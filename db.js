// db.js - SQLite storage using Node's built-in sqlite module (Node 22.13+ / 24). No native install needed.
// The file middleware.db is created in the folder you run the server from.
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.DB_FILE || 'middleware.db');
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  phone TEXT PRIMARY KEY,          -- 10 digits
  name TEXT, email TEXT, address TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (   -- every webhook seen once; used to ignore AiSensy retries
  event_id TEXT PRIMARY KEY,
  topic TEXT,
  received_at INTEGER,
  body TEXT
);

CREATE TABLE IF NOT EXISTS orders (   -- from order.placed
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  phone TEXT,
  items TEXT,                         -- JSON: [{sku, qty, unitPrice}]
  total_paise INTEGER,
  created_at INTEGER,
  status TEXT DEFAULT 'pending',      -- pending -> matched
  payment_event_id TEXT,
  reference_id TEXT,                  -- RF-... from the payment event
  glam_status TEXT,                   -- NULL | sent | send_failed
  glam_http INTEGER,
  glam_response TEXT,
  glam_body TEXT,
  sent_at INTEGER
);

CREATE TABLE IF NOT EXISTS payments ( -- from payment.captured
  event_id TEXT PRIMARY KEY,
  phone TEXT,
  amount_paise INTEGER,
  created_at INTEGER,
  status TEXT DEFAULT 'unmatched',    -- unmatched -> matched | ignored
  body TEXT
);
`);

// run several statements as one all-or-nothing unit
function tx(fn) {
  db.exec('BEGIN');
  try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, tx };
