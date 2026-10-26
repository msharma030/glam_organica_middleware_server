// server.js - the middleware. Port 3000.
//   POST /flow/customer     <- flow's API request block (name, email, address, phone)
//   POST /webhook/aisensy   <- AiSensy webhooks: order.placed AND payment.captured
//   GET  /debug             <- see everything stored
//   POST /admin/retry/:id   <- re-send a failed order to Glam
const express = require('express');
const fs = require('fs');
const { db } = require('./db');
const L = require('./logic');

const app = express();
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));

const stamp = () => new Date().toLocaleTimeString('en-IN', { hour12: false });
const log = (...a) => console.log(`[${stamp()}]`, ...a);

// keep a copy of every POST body AiSensy sends, exactly as received
app.use((req, res, next) => {
  if (req.method === 'POST') {
    fs.appendFileSync('requests.log', JSON.stringify({ at: new Date().toISOString(), path: req.path, body: req.body }) + '\n');
  }
  next();
});

app.post('/flow/customer', async (req, res) => {
  try {
    const { phone, warnings } = L.saveCustomer(req.body);
    log('flow/customer saved for', phone, warnings.length ? `| WARN: ${warnings.join('; ')}` : '');
    res.json({ ok: true, warnings });
    report(await L.reconcile(phone)); // payment may already be waiting for this profile
  } catch (e) {
    log('flow/customer rejected:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/webhook/aisensy', async (req, res) => {
  const evt = req.body;
  res.sendStatus(200); // acknowledge fast: AiSensy times out after 10s
  try {
    let r;
    if (evt.topic === 'order.placed') r = L.saveOrder(evt);
    else if (evt.topic === 'payment.captured') r = L.savePayment(evt);
    else return log('ignored topic', evt.topic);

    log(evt.topic, JSON.stringify(r));
    if (r.phone) report(await L.reconcile(r.phone));
  } catch (e) {
    console.error('processing error', e);
  }
});

function report(results) {
  for (const r of results) {
    if (r.waiting) log('  ...waiting for', r.waiting);
    else log(`  >> order #${r.orderId} matched ${r.reference_id}${r.ambiguous ? ' (AMBIGUOUS: several orders fit)' : ''} -> Glam ${r.glam} (${r.http || r.error})`);
  }
}

app.get('/debug', (req, res) =>
  res.json({
    customers: db.prepare('SELECT * FROM customers').all(),
    orders: db.prepare('SELECT id,phone,items,total_paise,status,reference_id,glam_status,glam_http,glam_response,created_at FROM orders ORDER BY id DESC').all(),
    payments: db.prepare('SELECT event_id,phone,amount_paise,status,created_at FROM payments ORDER BY created_at DESC').all(),
  })
);

app.get('/debug/order/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.sendStatus(404);
  res.json({ ...o, items: JSON.parse(o.items), glam_body: o.glam_body && JSON.parse(o.glam_body) });
});

app.post('/admin/retry/:id', async (req, res) => {
  try { res.json(await L.retry(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); }
});

// bad JSON (typically an address with quotes/line breaks) -> show the raw text
app.use((err, req, res, next) => {
  log('BAD JSON on', req.path, '-', err.message, '\n   raw body:', req.rawBody);
  fs.appendFileSync('requests.log', JSON.stringify({ at: new Date().toISOString(), path: req.path, parseError: err.message, raw: req.rawBody }) + '\n');
  res.status(400).json({ ok: false, error: 'bad json' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`middleware on :${PORT} | Glam endpoint: ${L.CONFIG.GLAM_URL}`));
