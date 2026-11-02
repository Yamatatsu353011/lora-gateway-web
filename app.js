require("dotenv").config();

const express = require("express");
const Redis = require("ioredis");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const SQLITE_PATH = process.env.SQLITE_PATH || "/var/lib/lora-gateway/gateway.db";

// 基地局ごとに.envで指定する
const LORA_NODE_ID = process.env.LORA_NODE_ID || null;

const redis = new Redis(REDIS_URL);
const db = new sqlite3.Database(SQLITE_PATH);

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function makeBstXyLabel(zx, zy, xtile, ytile) {
  if (
    zx === null || zy === null ||
    xtile === null || ytile === null
  ) {
    return null;
  }

  if (zx === zy) {
    return `XY:z${zx}:x${xtile}:y${ytile}`;
  }

  return `XY:zx${zx}:zy${zy}:x${xtile}:y${ytile}`;
}

// ============================================================
// Express setup
// ============================================================

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// Home
// ============================================================

app.get("/", async (req, res) => {
  res.render("index");
});

app.get("/mobile", (req, res) => {
  res.render("mobile_home");
});

// ============================================================
// Legacy LoRa text send
// ============================================================

app.post("/send", async (req, res) => {
  const packet = {
    packet_id: `web-${Date.now()}`,
    payload_type: "text",
    payload_text: req.body.payload_text || "",
    created_at: new Date().toISOString(),
    source: "web"
  };

  await redis.lpush("queue:lora:tx", JSON.stringify(packet));
  await redis.publish("event:lora:tx_request", JSON.stringify(packet));

  res.redirect("/");
});

// ============================================================
// API: gateway state
// ============================================================

app.get("/api/state", async (req, res) => {
  function parseJsonOrNull(value) {
    if (!value) return null;

    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  const gpsRaw = await redis.get("state:gps");
  const selfRaw = await redis.get("state:self");
  const timeSyncRaw = await redis.get("state:time_sync");
  const loraRaw = await redis.get("state:lora");

  const result = {
    gps: parseJsonOrNull(gpsRaw),
    self: parseJsonOrNull(selfRaw),
    time_sync: parseJsonOrNull(timeSyncRaw),
    lora: parseJsonOrNull(loraRaw),
    queue: {
      lora_tx: await redis.llen("queue:lora:tx"),
      lora_rx: await redis.llen("queue:lora:rx"),
    },
    server_time: new Date().toISOString(),
  };

  res.json(result);
});

// ============================================================
// API: mobile nodes
// ============================================================

app.get("/api/nodes", async (req, res) => {
  try {
    const nodes = await dbAll(
      `SELECT
         node_id,
         lat,
         lon,
         updated_at
       FROM mobile_nodes
       WHERE lat IS NOT NULL
         AND lon IS NOT NULL
       ORDER BY node_id`
    );

    res.json({ nodes });

  } catch (err) {
    console.error("[API-NODES-ERR]", err);

    res.status(500).json({
      nodes: [],
      error: "failed to load mobile nodes"
    });
  }
});

// ============================================================
// New order page
// ============================================================

app.get("/orders/new", async (req, res) => {
  const items = await dbAll(
    `SELECT * FROM item_master ORDER BY display_order`
  );

  res.render("order_new", { items });
});

// ============================================================
// ASK: create order
// ============================================================

app.post("/orders", async (req, res) => {
  const orderId = makeId("ord");
  const createdAt = nowIso();

  const requesterNode =
    LORA_NODE_ID || req.body.requester_node || "dev-gateway-a";

  const note = req.body.note || "";

  const clickedLat = parseOptionalNumber(req.body.target_lat);
  const clickedLon = parseOptionalNumber(req.body.target_lon);

  const targetZx = parseOptionalNumber(req.body.target_zx);
  const targetZy = parseOptionalNumber(req.body.target_zy);
  const targetXtile = parseOptionalNumber(req.body.target_xtile);
  const targetYtile = parseOptionalNumber(req.body.target_ytile);

  const targetSouth = parseOptionalNumber(req.body.target_south);
  const targetNorth = parseOptionalNumber(req.body.target_north);
  const targetWest = parseOptionalNumber(req.body.target_west);
  const targetEast = parseOptionalNumber(req.body.target_east);

  const targetAreaLabel = req.body.target_area_label || "";

  const targetBstXy = makeBstXyLabel(
    targetZx,
    targetZy,
    targetXtile,
    targetYtile
  );

  const targetArea = targetBstXy
    ? `${targetBstXy} ${targetAreaLabel ? `(${targetAreaLabel})` : ""}`
    : targetAreaLabel;

  await dbRun(
    `INSERT INTO orders
     (
       order_id,
       requester_node,
       target_area,
       target_lat,
       target_lon,
       target_level,
       target_size_m,
       target_area_label,
       target_zx,
       target_zy,
       target_xtile,
       target_ytile,
       target_south,
       target_north,
       target_west,
       target_east,
       target_bst_xy,
       status,
       note,
       created_at,
       updated_at
     )
     VALUES
     (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    [
      orderId,
      requesterNode,
      targetArea,
      clickedLat,
      clickedLon,
      targetZx,
      null,
      targetAreaLabel,
      targetZx,
      targetZy,
      targetXtile,
      targetYtile,
      targetSouth,
      targetNorth,
      targetWest,
      targetEast,
      targetBstXy,
      note,
      createdAt,
      createdAt,
    ]
  );

  const items = await dbAll(
    `SELECT * FROM item_master ORDER BY display_order`
  );

  const orderItemsForMessage = [];

  for (const item of items) {
    const field = `qty_${item.item_code}`;
    const qty = Number(req.body[field] || 0);

    if (qty > 0) {
      await dbRun(
        `INSERT INTO order_items
         (
           order_id,
           item_code,
           requested_qty,
           accepted_qty,
           fulfilled_qty,
           remaining_qty
         )
         VALUES (?, ?, ?, 0, 0, ?)`,
        [orderId, item.item_code, qty, qty]
      );

      orderItemsForMessage.push({
        item_code: item.item_code,
        item_name: item.item_name,
        requested_qty: qty,
        unit: item.unit,
      });
    }
  }

  const businessMessage = {
    type: "ORDER_REQUEST",
    order_id: orderId,
    requester_node: requesterNode,
    target: {
      kind: "BST_XY_TILE",
      clicked_point: {
        lat: clickedLat,
        lon: clickedLon,
      },
      zx: targetZx,
      zy: targetZy,
      xtile: targetXtile,
      ytile: targetYtile,
      bst_xy: targetBstXy,
      bounds: {
        south: targetSouth,
        north: targetNorth,
        west: targetWest,
        east: targetEast,
      },
      label: targetAreaLabel,
    },
    items: orderItemsForMessage,
    note,
    created_at: createdAt,
  };

  await dbRun(
    `INSERT INTO business_events
     (
       event_type,
       order_id,
       payload_json,
       created_at
     )
     VALUES ('order_created', ?, ?, ?)`,
    [
      orderId,
      JSON.stringify(businessMessage),
      createdAt,
    ]
  );

  await redis.publish(
    "event:business:order_created",
    JSON.stringify(businessMessage)
  );

  res.redirect(`/orders/${orderId}`);
});

// ============================================================
// Order list
// ============================================================

app.get("/orders", async (req, res) => {
  const orders = await dbAll(
    `SELECT
       o.*,
       SUM(oi.requested_qty) AS total_requested,
       SUM(oi.accepted_qty) AS total_accepted,
       SUM(oi.remaining_qty) AS total_remaining
     FROM orders o
     LEFT JOIN order_items oi ON o.order_id = oi.order_id
     GROUP BY o.order_id
     ORDER BY o.id DESC`
  );

  res.render("orders", { orders });
});

// ============================================================
// Order detail
// ============================================================

app.get("/orders/:orderId", async (req, res) => {
  const orderId = req.params.orderId;

  const order = await dbGet(
    `SELECT * FROM orders WHERE order_id = ?`,
    [orderId]
  );

  if (!order) {
    return res.status(404).send("Order not found");
  }

  const items = await dbAll(
    `SELECT
       oi.*,
       im.item_name,
       im.category,
       im.unit
     FROM order_items oi
     JOIN item_master im ON oi.item_code = im.item_code
     WHERE oi.order_id = ?
     ORDER BY im.display_order`,
    [orderId]
  );

  const offers = await dbAll(
    `SELECT * FROM offers
     WHERE order_id = ?
     ORDER BY id DESC`,
    [orderId]
  );

  // JOIN item_master is required for im.item_name / im.unit.
  const offerItems = await dbAll(
    `SELECT
       ofi.*,
       o.offer_id,
       o.responder_node,
       im.item_name,
       im.unit
     FROM offer_items ofi
     JOIN offers o ON ofi.offer_id = o.offer_id
     JOIN item_master im ON ofi.item_code = im.item_code
     WHERE o.order_id = ?
     ORDER BY o.id DESC, im.display_order`,
    [orderId]
  );

  // ----------------------------------------------------------
  // REPLY(C): local receipt queue status
  // ----------------------------------------------------------

  const receiptStatus = {};

  for (const offer of offers) {
    if (String(offer.offer_id).startsWith("lora-reply-")) {
      const askId = offer.offer_id.slice("lora-reply-".length);

      receiptStatus[offer.offer_id] = Boolean(
        await redis.exists(`lora:orders:receipt_tx:${askId}`)
      );
    }
  }

  // ----------------------------------------------------------
  // REPLY(C): received receipts stored in SQLite
  //
  // A and B share app.js. Some existing DBs may not have
  // order_receipts until lora_node_sync.py creates it.
  // ----------------------------------------------------------

  let receipts = [];

  const receiptTable = await dbGet(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name = 'order_receipts'`
  );

  if (receiptTable) {
    receipts = await dbAll(
      `SELECT *
       FROM order_receipts
       WHERE order_id = ?
       ORDER BY received_at DESC`,
      [orderId]
    );
  }

  res.render("order_detail", {
    order,
    items,
    offers,
    offerItems,
    receiptStatus,
    receipts,
  });
});

// ============================================================
// REPLY(C): send receipt confirmation from requester BASE
// ============================================================

app.post("/orders/:orderId/receipt", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const offerId = String(req.body.offer_id || "").trim();

    if (!offerId.startsWith("lora-reply-")) {
      return res.status(400).send(
        "LoRaからの回答のみ受領確認できます"
      );
    }

    const askPktId = offerId.slice("lora-reply-".length);

    if (!/^[0-9A-Za-z]+-[0-9A-Za-z]+$/.test(askPktId)) {
      return res.status(400).send("Invalid ASK packet ID");
    }

    // --------------------------------------------------------
    // Retrieve the actual offer from SQLite
    // --------------------------------------------------------

    const rows = await dbAll(
      `SELECT
         o.responder_node,
         oi.item_code,
         oi.accepted_qty
       FROM offers o
       JOIN offer_items oi ON oi.offer_id = o.offer_id
       WHERE o.offer_id = ?
         AND o.order_id = ?`,
      [offerId, orderId]
    );

    if (rows.length !== 1) {
      return res.status(409).send(
        "回答が見つからないか、複数品目の回答です"
      );
    }

    const offer = rows[0];
    const receivedQty = Number(offer.accepted_qty);

    if (!Number.isInteger(receivedQty) || receivedQty <= 0) {
      return res.status(409).send(
        "受領対象の数量がありません"
      );
    }

    // --------------------------------------------------------
    // Validate the ASK / REPLY(P) / responder position
    // --------------------------------------------------------

    const [originalRaw, replyRaw, targetRaw] = await Promise.all([
      redis.get(`lora:orders:outgoing:${askPktId}`),
      redis.get(`lora:orders:reply_received:${askPktId}`),
      redis.get(`lora:orders:reply_position:${askPktId}`),
    ]);

    if (!originalRaw || !replyRaw || !targetRaw) {
      return res.status(409).send(
        "元のASK/REPLY/送信先位置が未登録です"
      );
    }

    const original = JSON.parse(originalRaw);
    const reply = JSON.parse(replyRaw);
    const target = JSON.parse(targetRaw);

    if (
      String(original.order_id) !== String(orderId) ||
      String(original.item_code) !== String(offer.item_code) ||
      Number(reply.accepted_qty) !== receivedQty ||
      String(reply.responder_node) !== String(offer.responder_node) ||
      String(target.responder_node) !== String(offer.responder_node)
    ) {
      return res.status(409).send(
        "発注情報と回答情報が一致しません"
      );
    }

    // Already queued by mesh_daemon.py
    if (await redis.exists(`lora:orders:receipt_tx:${askPktId}`)) {
      return res.status(409).send(
        "この物資の受領通知は送信キュー登録済みです"
      );
    }

    // --------------------------------------------------------
    // Notify mesh_daemon.py
    // --------------------------------------------------------

    const event = {
      type: "ORDER_RECEIPT",
      order_id: orderId,
      ask_pkt_id: askPktId,
      responder_node: offer.responder_node,
      received_qty: receivedQty,
      created_at: nowIso(),
    };

    const listeners = await redis.publish(
      "event:business:receipt_created",
      JSON.stringify(event)
    );

    if (listeners < 1) {
      return res.status(503).send(
        "mesh_daemon.pyが受領イベントを購読していません"
      );
    }

    console.log(
      `[ORDER-RECEIPT-EVENT] ask=${askPktId} qty=${receivedQty}`
    );

    res.redirect(`/orders/${encodeURIComponent(orderId)}`);

  } catch (err) {
    console.error("[ORDER-RECEIPT-ERR]", err);

    res.status(500).send(
      "受領通知イベントの発行に失敗しました"
    );
  }
});

// ============================================================
// Requests list
// ============================================================

app.get("/requests", async (req, res) => {
  const orders = await dbAll(
    `SELECT
       o.*,
       SUM(oi.requested_qty) AS total_requested,
       SUM(oi.accepted_qty) AS total_accepted,
       SUM(oi.remaining_qty) AS total_remaining
     FROM orders o
     LEFT JOIN order_items oi ON o.order_id = oi.order_id
     WHERE o.status = 'open'
     GROUP BY o.order_id
     ORDER BY o.id DESC`
  );

  res.render("requests", { orders });
});

// ============================================================
// REPLY(P): reply input page
// ============================================================

app.get("/requests/:orderId/reply", async (req, res) => {
  const orderId = req.params.orderId;

  const order = await dbGet(
    `SELECT * FROM orders WHERE order_id = ?`,
    [orderId]
  );

  if (!order) {
    return res.status(404).send("Request not found");
  }

  const items = await dbAll(
    `SELECT
       oi.*,
       im.item_name,
       im.category,
       im.unit
     FROM order_items oi
     JOIN item_master im ON oi.item_code = im.item_code
     WHERE oi.order_id = ?
     ORDER BY im.display_order`,
    [orderId]
  );

  res.render("request_reply", { order, items });
});

// ============================================================
// REPLY(P): create offer
// ============================================================

app.post("/requests/:orderId/reply", async (req, res) => {
  const orderId = req.params.orderId;
  const offerId = makeId("off");
  const createdAt = nowIso();

  // ----------------------------------------------------------
  // Use the local BASE node ID, not the mock form value.
  // Both A and B use this same app.js.
  // ----------------------------------------------------------

  const responderNode = LORA_NODE_ID;

  if (!responderNode || !/^\d{4}$/.test(responderNode)) {
    return res.status(500).send(
      "LORA_NODE_IDが未設定です。.envに0001または0002を設定してください。"
    );
  }

  const note = req.body.note || "";

  // LoRa ASK received by the current BASE:
  // local SQLite order_id = lora-<ASK packet ID>
  const askPktId = orderId.startsWith("lora-")
    ? orderId.slice("lora-".length)
    : null;

  const order = await dbGet(
    `SELECT * FROM orders WHERE order_id = ?`,
    [orderId]
  );

  if (!order) {
    return res.status(404).send("Request not found");
  }

  const orderItems = await dbAll(
    `SELECT * FROM order_items WHERE order_id = ?`,
    [orderId]
  );

  const quantities = orderItems.map(item => {
    const raw = Number(req.body[`offer_${item.item_code}`] || 0);
    const offeredQty = Number.isFinite(raw)
      ? Math.max(0, Math.floor(raw))
      : 0;

    const acceptedQty = Math.min(
      offeredQty,
      Number(item.remaining_qty)
    );

    return { item, offeredQty, acceptedQty };
  });

  // ----------------------------------------------------------
  // Existing Web offer registration
  // ----------------------------------------------------------

  await dbRun(
    `INSERT INTO offers
     (offer_id, order_id, responder_node, status, note,
      created_at, updated_at)
     VALUES (?, ?, ?, 'offered', ?, ?, ?)`,
    [offerId, orderId, responderNode, note, createdAt, createdAt]
  );

  for (const { item, offeredQty, acceptedQty } of quantities) {
    if (offeredQty > 0) {
      await dbRun(
        `INSERT INTO offer_items
         (offer_id, item_code, offered_qty, accepted_qty)
         VALUES (?, ?, ?, ?)`,
        [offerId, item.item_code, offeredQty, acceptedQty]
      );

      await dbRun(
        `UPDATE order_items
         SET accepted_qty = accepted_qty + ?,
             remaining_qty = MAX(remaining_qty - ?, 0)
         WHERE id = ?`,
        [acceptedQty, acceptedQty, item.id]
      );
    }
  }

  const summary = await dbGet(
    `SELECT SUM(remaining_qty) AS total_remaining
     FROM order_items
     WHERE order_id = ?`,
    [orderId]
  );

  const newStatus =
    summary && Number(summary.total_remaining) === 0
      ? "fulfilled"
      : "open";

  await dbRun(
    `UPDATE orders
     SET status = ?, updated_at = ?
     WHERE order_id = ?`,
    [newStatus, createdAt, orderId]
  );

  await dbRun(
    `INSERT INTO business_events
     (event_type, order_id, offer_id, payload_json, created_at)
     VALUES ('offer_created', ?, ?, ?, ?)`,
    [orderId, offerId, JSON.stringify(req.body), createdAt]
  );

  // ----------------------------------------------------------
  // REPLY(P) event for mesh_daemon.py
  // ----------------------------------------------------------

  const packet = {
    type: "ORDER_REPLY",
    order_id: orderId,
    ask_pkt_id: askPktId,
    offer_id: offerId,
    responder_node: responderNode,
    requester_node: order.requester_node,
    items: quantities.map(({ item, acceptedQty }) => ({
      item_code: item.item_code,
      requested_qty: Number(item.requested_qty),
      accepted_qty: acceptedQty,
    })),
    created_at: createdAt,
  };

  // Preserve the previous Web queue.
  await redis.lpush(
    "queue:lora:tx",
    JSON.stringify(packet)
  );

  if (askPktId) {
    await redis.publish(
      "event:business:offer_created",
      JSON.stringify(packet)
    );

    console.log(
      `[ORDER-REPLY-EVENT] ask=${askPktId} offer=${offerId}`,
      packet.items
    );
  }

  res.redirect(`/orders/${orderId}`);
});

// ============================================================
// Start server
// ============================================================

app.listen(PORT, "127.0.0.1", () => {
  console.log(
    `LoRa gateway web app listening on http://127.0.0.1:${PORT}`
  );
  console.log(`[LORA-NODE-ID] ${LORA_NODE_ID || "(not configured)"}`);
});
