// logic.js - storing the 3 inputs, matching them, building and sending the Glam body.
//
// The three inputs can arrive in ANY order. Each time one arrives we call reconcile(phone),
// which fires the Glam call only once all three are present:
//   1) customer profile  (flow API request block)
//   2) order.placed      (webhook)
//   3) payment.captured  (webhook, status success)

const { db, tx } = require('./db');

const CONFIG = {
  MATCH_WINDOW_MS: 30 * 60 * 1000, // payment must arrive within 30 min after its order
  CLOCK_SKEW_MS: 60 * 1000,        // tolerate payment timestamp slightly before order
  GST_RATE: 0.18,                  // GST inclusive in sale price
  SHIPPING: 0,
  GLAM_URL: process.env.GLAM_URL || 'http://localhost:4000/api/order-data',
};

// "917903596806" / "+91 79035 96806" / "7903596806" -> "7903596806"
const phone10 = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
};
const round2 = (n) => Math.round(n * 100) / 100;
const toPaise = (rupees) => Math.round(rupees * 100);
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
const unresolved = (v) => /^\$\w+$|\{\{.*\}\}/.test(v); // a variable AiSensy failed to fill, e.g. "$customerEmail"

// ---------- 1. customer profile from the flow's API request block ----------
// body: { phone, name, email, address }
function saveCustomer(body) {
  const phone = phone10(body.phone ?? body.MobileNumber);
  if (!phone) throw new Error('phone is missing - send the $MobileNumber value as "phone"');

  const addr = body.address && typeof body.address === 'object' ? JSON.stringify(body.address) : clean(body.address);
  const c = { phone, name: clean(body.name), email: clean(body.email), address: addr };
  const warnings = Object.entries({ name: c.name, email: c.email, address: c.address })
    .filter(([, v]) => !v || unresolved(v))
    .map(([k]) => `${k} is empty or still a raw variable`);

  db.prepare(
    `INSERT INTO customers (phone,name,email,address,updated_at) VALUES (@phone,@name,@email,@address,@t)
     ON CONFLICT(phone) DO UPDATE SET name=@name,email=@email,address=@address,updated_at=@t`
  ).run({ ...c, t: Date.now() });
  return { phone, warnings };
}

// ---------- 2. order.placed ----------
function saveOrder(evt) {
  if (!markSeen(evt, 'order.placed')) return { status: 'duplicate' };

  const o = evt.data.order;
  const items = (o.product_items || []).map((i) => ({
    sku: i.product_retailer_id, // catalog Content ID, sent as ProductSKU
    qty: i.quantity,
    unitPrice: i.item_price,    // rupees
  }));
  const total = round2(items.reduce((s, i) => s + i.qty * i.unitPrice, 0));

  db.prepare(
    `INSERT INTO orders (event_id,phone,items,total_paise,created_at) VALUES (?,?,?,?,?)`
  ).run(evt.id, phone10(o.phone_number), JSON.stringify(items), toPaise(total), Date.parse(evt.created_at));
  return { status: 'stored', phone: phone10(o.phone_number), total };
}

// ---------- 3. payment.captured ----------
function savePayment(evt) {
  if (!markSeen(evt, 'payment.captured')) return { status: 'duplicate' };

  const p = evt.data.payment;
  const status = p.transaction?.status === 'success' ? 'unmatched' : 'ignored';
  db.prepare(
    `INSERT INTO payments (event_id,phone,amount_paise,created_at,status,body) VALUES (?,?,?,?,?,?)`
  ).run(
    evt.id, phone10(p.phone_number), Math.round((p.amount.value / p.amount.offset) * 100),
    Date.parse(evt.created_at), status, JSON.stringify(p)
  );
  return { status: status === 'ignored' ? 'ignored_not_success' : 'stored', phone: phone10(p.phone_number) };
}

function markSeen(evt, topic) {
  const r = db
    .prepare(`INSERT OR IGNORE INTO events (event_id,topic,received_at,body) VALUES (?,?,?,?)`)
    .run(evt.id, topic, Date.now(), JSON.stringify(evt));
  return r.changes === 1; // 0 => AiSensy retry of something we already have
}

// ---------- matching + sending ----------
// Fires the Glam call for every (unmatched payment, pending order) pair for this phone,
// as long as the customer profile exists. Safe to call any number of times.
async function reconcile(phone) {
  const out = [];
  const customer = db.prepare(`SELECT * FROM customers WHERE phone=?`).get(phone);
  if (!customer) return [{ waiting: 'customer profile' }];

  const payments = db
    .prepare(`SELECT * FROM payments WHERE phone=? AND status='unmatched' ORDER BY created_at`)
    .all(phone);

  for (const pay of payments) {
    const cands = db
      .prepare(
        `SELECT * FROM orders WHERE phone=? AND status='pending' AND total_paise=?
           AND (? - created_at) BETWEEN ? AND ? ORDER BY created_at DESC`
      )
      .all(phone, pay.amount_paise, pay.created_at, -CONFIG.CLOCK_SKEW_MS, CONFIG.MATCH_WINDOW_MS);
    if (!cands.length) { out.push({ payment: pay.event_id, waiting: 'matching order' }); continue; }

    const order = cands[0]; // most recent wins
    const payBody = JSON.parse(pay.body);

    // claim both rows BEFORE any await, so concurrent calls can't double-send
    tx(() => {
      db.prepare(`UPDATE orders SET status='matched',payment_event_id=?,reference_id=? WHERE id=?`)
        .run(pay.event_id, payBody.reference_id, order.id);
      db.prepare(`UPDATE payments SET status='matched' WHERE event_id=?`).run(pay.event_id);
    });

    const body = buildGlamBody(order, payBody, customer);
    db.prepare(`UPDATE orders SET glam_body=? WHERE id=?`).run(JSON.stringify(body), order.id);
    const result = await sendToGlam(order.id, body);
    out.push({ orderId: order.id, ambiguous: cands.length > 1, reference_id: payBody.reference_id, ...result });
  }
  return out;
}

// AiSensy address form arrives as {"values":{name,in_pin_code,phone_number,address,city,landmark_area,state}}.
// Also accepts a flat object, a JSON string of either, or a plain text address (pincode found by pattern).
function parseAddress(raw) {
  let a = raw;
  if (typeof a === 'string') { try { const j = JSON.parse(a); if (j && typeof j === 'object') a = j; } catch (e) { /* plain text */ } }
  if (a && typeof a === 'object') {
    const v = a.values || a;
    const full = clean(v.address || v.full_address);
    return {
      name: clean(v.name),
      phone: phone10(v.phone_number || v.phone),
      pin: clean(v.in_pin_code || v.pincode || v.pin_code) || ((full.match(/\b\d{6}\b/) || [])[0] || ''),
      full,
      locality: clean(v.landmark_area || v.locality),
      city: clean(v.city),
      state: clean(v.state),
    };
  }
  const full = clean(a);
  return { name: '', phone: '', pin: (full.match(/\b\d{6}\b/) || [])[0] || '', full, locality: '', city: '', state: '' };
}

function buildGlamBody(order, pay, c) {
  const paid = round2(pay.amount.value / pay.amount.offset);
  const items = JSON.parse(order.items);
  const a = parseAddress(c.address);

  return {
    CustomerName: c.name,
    CustomerEmailID: c.email,
    CustomerPhoneNo: phone10(order.phone),
    CouponCode: '',
    CouponValue: 0,
    OrderTotalAmount: paid,
    TotalGSTAmount: round2(paid - paid / (1 + CONFIG.GST_RATE)), // GST inclusive
    TotalShippingAmount: CONFIG.SHIPPING,
    PaymentOption: 'Online',
    PaymentID: pay.transaction.pg_transaction_id,
    TransactionID: pay.transaction.id,
    TransactionStatus: 'Success',
    ShippingAddress: {
      CustomerShippingAddressName: a.name || c.name,
      CustomerShippingAddressPhoneNo: a.phone || phone10(order.phone),
      CustomerShippingAddressEmailID: c.email,
      CustomerShippingAddressPinCode: a.pin,
      CustomerShippingAddressFullAddress: a.full,
      CustomerShippingAddressLocality: a.locality,
      CustomerShippingAddressCity: a.city,
      CustomerShippingAddressState: a.state,
    },
    Products: items.map((i) => ({
      ProductSKU: i.sku,
      ProductQuantity: i.qty,
      ProductSalePrice: i.unitPrice,
      ProductMRP: i.unitPrice, // MRP ignored: same as sale price
    })),
  };
}

function glamAuthHeader() {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(CONFIG.GLAM_URL);
  const user = process.env.GLAM_USER || (local ? 'glamorganica' : '');
  const pass = process.env.GLAM_PASS || (local ? 'test-password' : '');
  if (!user || !pass) throw new Error('GLAM_USER / GLAM_PASS must be set for a non-local GLAM_URL');
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function sendToGlam(orderId, body) {
  try {
    const resp = await fetch(CONFIG.GLAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: glamAuthHeader() },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    const ok = resp.ok;
    db.prepare(`UPDATE orders SET glam_status=?,glam_http=?,glam_response=?,sent_at=? WHERE id=?`)
      .run(ok ? 'sent' : 'send_failed', resp.status, text, Date.now(), orderId);
    return { glam: ok ? 'sent' : 'send_failed', http: resp.status, response: text };
  } catch (e) {
    db.prepare(`UPDATE orders SET glam_status='send_failed',glam_response=?,sent_at=? WHERE id=?`)
      .run(String(e.message), Date.now(), orderId);
    return { glam: 'send_failed', error: e.message };
  }
}

// re-send a stored body (used by /admin/retry/:id)
async function retry(orderId) {
  const o = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);
  if (!o || !o.glam_body) throw new Error('no stored Glam body for this order');
  return sendToGlam(orderId, JSON.parse(o.glam_body));
}

module.exports = { CONFIG, saveCustomer, saveOrder, savePayment, reconcile, retry, phone10 };
