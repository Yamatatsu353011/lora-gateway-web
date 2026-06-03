PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS received_packets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    packet_id TEXT,
    source_node TEXT,
    previous_node TEXT,
    destination_node TEXT,
    target_bst_prefix TEXT,
    payload_type TEXT,
    payload_text TEXT,
    payload_json TEXT,
    rssi REAL,
    snr REAL,
    hop_count INTEGER,
    ttl INTEGER,
    received_at TEXT NOT NULL,
    raw_line TEXT
);

CREATE TABLE IF NOT EXISTS transmit_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    packet_id TEXT,
    destination_node TEXT,
    target_bst_prefix TEXT,
    payload_type TEXT,
    payload_text TEXT,
    payload_json TEXT,
    status TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
);

CREATE TABLE IF NOT EXISTS self_state_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT,
    lat REAL,
    lon REAL,
    alt REAL,
    gps_time TEXT,
    fix_status TEXT,
    satellites_used INTEGER,
    hdop REAL,
    pps_valid INTEGER,
    chrony_sync INTEGER,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT,
    component TEXT,
    message TEXT,
    created_at TEXT NOT NULL
);
