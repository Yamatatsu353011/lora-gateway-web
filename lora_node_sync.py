# -*- coding: utf-8 -*-
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

SQLITE_PATH = "/var/lib/lora-gateway/gateway.db"

SYNC_INTERVAL_SEC = 1.0


# ============================================================
# Utility
# ============================================================

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_loads_safe(value):
    if not value:
        return None
    try:
        return json.loads(value)
    except Exception:
        return None


def connect_db():
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ============================================================
# BST-ID decode helper
# ============================================================

def ytile_center_to_lat(ytile: int, z: int) -> float:
    """
    Web Mercator tile center y -> latitude.
    Uses y + 0.5 as tile center.
    """
    n = 2 ** z
    y_center = ytile + 0.5
    merc_n = math.pi * (1.0 - 2.0 * y_center / n)
    return math.degrees(math.atan(math.sinh(merc_n)))


def xtile_center_to_lon(xtile: int, z: int) -> float:
    """
    Web Mercator tile center x -> longitude.
    Uses x + 0.5 as tile center.
    """
    n = 2 ** z
    x_center = xtile + 0.5
    return x_center / n * 360.0 - 180.0


def ytile_bounds(ytile: int, z: int) -> Dict[str, float]:
    n = 2 ** z

    def y_to_lat(y):
        merc_n = math.pi * (1.0 - 2.0 * y / n)
        return math.degrees(math.atan(math.sinh(merc_n)))

    north = y_to_lat(ytile)
    south = y_to_lat(ytile + 1)

    return {
        "north": north,
        "south": south,
    }


def xtile_bounds(xtile: int, z: int) -> Dict[str, float]:
    n = 2 ** z
    west = xtile / n * 360.0 - 180.0
    east = (xtile + 1) / n * 360.0 - 180.0

    return {
        "west": west,
        "east": east,
    }


def parse_bst_id_xy_from_hex(bst_hex: str, bit_len: int) -> Optional[Dict[str, Any]]:
    """
    Decode the XY part of the official BST-ID bit layout.

    Expected BST-ID bit layout:
      flags(4) -> for each active axis in X,Y,H,T order:
        zoom_minus_1(5) -> value_bits(zoom)

    This function extracts X and Y only.
    It assumes the BST-ID was encoded by the current bst-id-main style.
    """

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
        active = flags[i] == "1"

        if not active:
            continue

        if pos + 5 > len(bits):
            return None

        zoom_minus_1 = int(bits[pos:pos + 5], 2)
        zoom = zoom_minus_1 + 1
        pos += 5

        if pos + zoom > len(bits):
            return None

        coord = int(bits[pos:pos + zoom], 2)
        pos += zoom

        parsed[axis] = {
            "zoom": zoom,
            "coord": coord,
        }

    if "x" not in parsed or "y" not in parsed:
        return None

    zx = parsed["x"]["zoom"]
    zy = parsed["y"]["zoom"]
    xtile = parsed["x"]["coord"]
    ytile = parsed["y"]["coord"]

    lon = xtile_center_to_lon(xtile, zx)
    lat = ytile_center_to_lat(ytile, zy)

    xb = xtile_bounds(xtile, zx)
    yb = ytile_bounds(ytile, zy)

    if zx == zy:
        bst_xy = f"XY:z{zx}:x{xtile}:y{ytile}"
    else:
        bst_xy = f"XY:zx{zx}:zy{zy}:x{xtile}:y{ytile}"

    return {
        "lat": lat,
        "lon": lon,
        "zx": zx,
        "zy": zy,
        "xtile": xtile,
        "ytile": ytile,
        "bst_xy": bst_xy,
        "bounds": {
            "north": yb["north"],
            "south": yb["south"],
            "west": xb["west"],
            "east": xb["east"],
        },
        "flags": flags,
        "bits": bits,
    }


# ============================================================
# DB schema / sync
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

    # If the LoRa beacon does not include lat/lon, recover approximate
    # tile center from official BST-ID.
    if (lat is None or lon is None) and bst_hex and bst_bit_len:
        decoded = parse_bst_id_xy_from_hex(
            bst_hex=str(bst_hex),
            bit_len=int(bst_bit_len),
        )

        if decoded:
            lat = decoded["lat"]
            lon = decoded["lon"]
            bst_xy = decoded["bst_xy"]

            # Keep decoded fields in node dict for debug output if needed.
            node["decoded_bst"] = decoded

    now = utc_now_iso()

    conn.execute(
        """
        INSERT INTO mobile_nodes
        (
            node_id,
            node_type,
            lat,
            lon,
            alt,
            speed_mps,
            heading_deg,
            bst_xy,
            bst_id_int,
            bst_bit_len,
            status,
            last_report_at,
            updated_at
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
            node_id,
            lat,
            lon,
            alt,
            speed_mps,
            heading_deg,
            bst_xy,
            str(bst_id_int) if bst_id_int is not None else None,
            int(bst_bit_len) if bst_bit_len is not None else None,
            now,
            now,
        ],
    )


def main():
    r = redis.Redis(
        host=REDIS_HOST,
        port=REDIS_PORT,
        db=REDIS_DB,
        decode_responses=True,
    )

    conn = connect_db()
    ensure_schema(conn)

    print("[LORA-NODE-SYNC] started", flush=True)

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

        except Exception as e:
            print(f"[LORA-NODE-SYNC-ERR] {e}", flush=True)

        time.sleep(SYNC_INTERVAL_SEC)


if __name__ == "__main__":
    main()
