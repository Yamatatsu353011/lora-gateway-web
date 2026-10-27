# -*- coding: utf-8 -*-
"""Synchronize LoRa mobile nodes and received order ASK packets to gateway.db."""
import json
import math
import time
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import redis

REDIS_HOST = "127.0.0.1"
REDIS_PORT = 6379
REDIS_DB = 0
REDIS_NODE_PATTERN = "lora:nodes:*"
REDIS_RECEIVED_ORDERS = "lora:orders:received"
SQLITE_PATH = "/var/lib/lora-gateway/gateway.db"
SYNC_INTERVAL_SEC = 1.0
ORDER_SYNC_INTERVAL_SEC = 5.0


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_loads_safe(value):
    if not value:
        return None
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return None


def connect_db():
    conn = sqlite3.connect(SQLITE_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


# ============================================================
# BST-ID decode helper (existing functionality)
# ============================================================

def ytile_center_to_lat(ytile: int, z: int) -> float:
    n = 2 ** z
    y_center = ytile + 0.5
    merc_n = math.pi * (1.0 - 2.0 * y_center / n)
    return math.degrees(math.atan(math.sinh(merc_n)))


def xtile_center_to_lon(xtile: int, z: int) -> float:
    n = 2 ** z
    x_center = xtile + 0.5
    return x_center / n * 360.0 - 180.0


def ytile_bounds(ytile: int, z: int) -> Dict[str, float]:
    n = 2 ** z

    def y_to_lat(y):
        merc_n = math.pi * (1.0 - 2.0 * y / n)
        return math.degrees(math.atan(math.sinh(merc_n)))

    return {"north": y_to_lat(ytile), "south": y_to_lat(ytile + 1)}


def xtile_bounds(xtile: int, z: int) -> Dict[str, float]:
    n = 2 ** z
    return {
        "west": xtile / n * 360.0 - 180.0,
        "east": (xtile + 1) / n * 360.0 - 180.0,
    }


def parse_bst_id_xy_from_hex(bst_hex: str, bit_len: int) -> Optional[Dict[str, Any]]:
    """Decode XY tile data from the BST-ID flags/zoom/coordinate bit layout."""
    if not bst_hex or not bit_len:
        return None

    value = int(bst_hex, 16)
    bits = format(value, f"0{bit_len}b")
    if len(bits) < 4:
        return None

    flags = bits[:4]
    pos = 4
    axes = ["x", "y", "h", "t"]
    parsed: Dict[str, Dict[str, int]] = {}

    for i, axis in enumerate(axes):
        if flags[i] != "1":
            continue
        if pos + 5 > len(bits):
            return None
        zoom = int(bits[pos:pos + 5], 2) + 1
        pos += 5
        if pos + zoom > len(bits):
            return None
        coord = int(bits[pos:pos + zoom], 2)
        pos += zoom
        parsed[axis] = {"zoom": zoom, "coord": coord}

    if "x" not in parsed or "y" not in parsed:
        return None

    zx = parsed["x"]["zoom"]
    zy = parsed["y"]["zoom"]
    xtile = parsed["x"]["coord"]
    ytile = parsed["y"]["coord"]
    xb = xtile_bounds(xtile, zx)
    yb = ytile_bounds(ytile, zy)

    if zx == zy:
        bst_xy = f"XY:z{zx}:x{xtile}:y{ytile}"
    else:
        bst_xy = f"XY:zx{zx}:zy{zy}:x{xtile}:y{ytile}"

    return {
        "lat": ytile_center_to_lat(ytile, zy),
        "lon": xtile_center_to_lon(xtile, zx),
        "zx": zx,
        "zy": zy,
        "xtile": xtile,
        "ytile": ytile,
        "bst_xy": bst_xy,
        "bounds": {**yb, **xb},
        "flags": flags,
        "bits": bits,
    }


# ============================================================
# DB schema / mobile node sync (existing functionality)
# ============================================================

def ensure_schema(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS mobile_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id TEXT UNIQUE NOT NULL,
            node_type TEXT DEFAULT 'mobile',
            lat REAL,
            lon REAL,
            alt REAL,
            speed_mps REAL,
            heading_deg REAL,
            bst_xy TEXT,
            bst_id_int TEXT,
            bst_bit_len INTEGER,
            status TEXT DEFAULT 'active',
            last_report_at TEXT,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.commit()


def sync_one_node(conn, node):
    node_id = node.get("node_id")
    if not node_id:
        return

    lat = node.get("lat")
    lon = node.get("lon")
    alt = node.get("alt")
    speed_mps = node.get("speed_mps")
    heading_deg = node.get("heading_deg")
    bst_xy = node.get("bst_xy")
    bst_id_int = node.get("bst_id_int")
    bst_bit_len = node.get("bst_bit_len")
    bst_hex = node.get("bst_hex")

    if (lat is None or lon is None) and bst_hex and bst_bit_len:
        decoded = parse_bst_id_xy_from_hex(
            bst_hex=str(bst_hex), bit_len=int(bst_bit_len)
        )
        if decoded:
            lat = decoded["lat"]
            lon = decoded["lon"]
            bst_xy = decoded["bst_xy"]
            node["decoded_bst"] = decoded

    now = utc_now_iso()
    conn.execute(
        """
        INSERT INTO mobile_nodes
        (
            node_id, node_type, lat, lon, alt, speed_mps, heading_deg,
            bst_xy, bst_id_int, bst_bit_len, status, last_report_at, updated_at
        )
        VALUES (?, 'mobile', ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
            lat = excluded.lat,
            lon = excluded.lon,
            alt = excluded.alt,
            speed_mps = excluded.speed_mps,
            heading_deg = excluded.heading_deg,
            bst_xy = excluded.bst_xy,
            bst_id_int = excluded.bst_id_int,
            bst_bit_len = excluded.bst_bit_len,
            status = excluded.status,
            last_report_at = excluded.last_report_at,
            updated_at = excluded.updated_at
        """,
        [
            node_id, lat, lon, alt, speed_mps, heading_deg, bst_xy,
            str(bst_id_int) if bst_id_int is not None else None,
            int(bst_bit_len) if bst_bit_len is not None else None,
            now, now,
        ],
    )


# ============================================================
# Received LoRa order ASK -> existing Web orders / order_items
# ============================================================

def decode_order_goal(record):
    """Best-effort XY tile decoding. Decimal goal_bst is used in routing JSON."""
    try:
        raw = record.get("goal_bst")
        nbits = int(record.get("goal_bit_len", 0))
        if raw is None or nbits <= 0:
            return None
        value = int(str(raw), 10)
        if value < 0 or value.bit_length() > nbits:
            return None
        return parse_bst_id_xy_from_hex(format(value, "x"), nbits)
    except (ValueError, TypeError, OverflowError):
        return None


def sync_one_order(conn, record):
    """Return True only when a new order was inserted.

    One LoRa ASK packet maps to one Web order. No original Web order_id is
    transmitted yet, so multiple item packets cannot be regrouped here.
    """
    if not isinstance(record, dict) or record.get("source") != "LORA_ORDER_ASK":
        return False

    pkt_id = str(record.get("pkt_id") or "").strip()
    origin = str(record.get("origin_node") or "").strip()
    item_code = str(record.get("item_code") or "").strip()
    if not pkt_id or not origin or not item_code:
        print(f"[LORA-ORDER-SKIP] missing fields: {record}", flush=True)
        return False

    try:
        qty = int(record.get("requested_qty"))
    except (ValueError, TypeError):
        print(f"[LORA-ORDER-SKIP] invalid quantity: pkt={pkt_id}", flush=True)
        return False
    if qty <= 0:
        print(f"[LORA-ORDER-SKIP] nonpositive quantity: pkt={pkt_id}", flush=True)
        return False

    order_id = f"lora-{pkt_id}"
    if conn.execute("SELECT 1 FROM orders WHERE order_id = ?", (order_id,)).fetchone():
        return False

    if not conn.execute(
        "SELECT 1 FROM item_master WHERE item_code = ?", (item_code,)
    ).fetchone():
        print(f"[LORA-ORDER-SKIP] unknown item_code={item_code} pkt={pkt_id}", flush=True)
        return False

    # ASK carries a BST integer, not the original clicked lat/lon.
    # Do not guess a map position before confirming the exact wire encoding.
    goal = None
    raw_goal = record.get("goal_bst")
    raw_len = record.get("goal_bit_len")
    area_label = goal["bst_xy"] if goal else f"BST:{raw_goal}/{raw_len}"
    now = utc_now_iso()
    columns = (
        "order_id, requester_node, target_area, status, note, created_at, updated_at, "
        "target_lat, target_lon, target_level, target_area_label, "
        "target_zx, target_zy, target_xtile, target_ytile, "
        "target_south, target_north, target_west, target_east, target_bst_xy"
    )
    target = goal or {}
    bounds = target.get("bounds", {})
    values = (
        order_id, origin, area_label, "open",
        f"LoRa ASK pkt_id={pkt_id}; received_by={record.get('received_by', '')}",
        now, now,
        target.get("lat"), target.get("lon"), target.get("zx"), area_label,
        target.get("zx"), target.get("zy"), target.get("xtile"),
        target.get("ytile"), bounds.get("south"), bounds.get("north"),
        bounds.get("west"), bounds.get("east"), target.get("bst_xy"),
    )

    # Caller wraps both INSERTs in a single transaction.
    placeholders = ", ".join("?" for _ in values)
    conn.execute(f"INSERT INTO orders ({columns}) VALUES ({placeholders})", values)
    conn.execute(
        """
        INSERT INTO order_items
            (order_id, item_code, requested_qty, accepted_qty, fulfilled_qty, remaining_qty)
        VALUES (?, ?, ?, 0, 0, ?)
        """,
        (order_id, item_code, qty, qty),
    )
    print(
        f"[LORA-ORDER-SYNC] order={order_id} from={origin} "
        f"item={item_code} qty={qty}",
        flush=True,
    )
    return True


def sync_received_orders(r, conn):
    # History remains in Redis. Re-reading is safe because order_id is unique.
    # The list must be retained in Redis until at least one successful sync.
    records = r.lrange(REDIS_RECEIVED_ORDERS, 0, -1)
    added = 0
    for raw in reversed(records):  # oldest first
        record = json_loads_safe(raw)
        if not isinstance(record, dict):
            continue
        try:
            # Keep each order's parent+item insert atomic even if one fails.
            with conn:
                if sync_one_order(conn, record):
                    added += 1
        except sqlite3.Error as exc:
            print(
                f"[LORA-ORDER-SYNC-ERR] pkt={record.get('pkt_id')} {exc}",
                flush=True,
            )
    return added


def main():
    r = redis.Redis(
        host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB, decode_responses=True
    )
    conn = connect_db()
    ensure_schema(conn)
    print("[LORA-NODE-SYNC] started (nodes + orders)", flush=True)
    last_order_sync = 0.0

    while True:
        try:
            keys = list(r.scan_iter(match=REDIS_NODE_PATTERN, count=100))
            count = 0
            for key in keys:
                value = r.get(key)
                node = json_loads_safe(value)
                if not node:
                    continue
                sync_one_node(conn, node)
                count += 1
            conn.commit()
            if count > 0:
                print(f"[LORA-NODE-SYNC] synced {count} nodes", flush=True)
        except Exception as exc:
            conn.rollback()
            print(f"[LORA-NODE-SYNC-ERR] {exc}", flush=True)

        if time.monotonic() - last_order_sync >= ORDER_SYNC_INTERVAL_SEC:
            try:
                sync_received_orders(r, conn)
            except Exception as exc:
                conn.rollback()
                print(f"[LORA-ORDER-SYNC-ERR] {exc}", flush=True)
            last_order_sync = time.monotonic()

        time.sleep(SYNC_INTERVAL_SEC)


if __name__ == "__main__":
    main()
