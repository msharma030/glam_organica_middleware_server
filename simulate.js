// simulate.js - fake the 3 inputs AiSensy would send, so you can test without WhatsApp.
//   node simulate.js happy            customer -> order -> payment
//   node simulate.js payment-first    payment arrives BEFORE its order
//   node simulate.js customer-last    order + payment arrive, address arrives after
//   node simulate.js duplicate        the same webhooks delivered twice (AiSensy retry)
//   node simulate.js same-amount      two same-value orders, then one payment (ambiguity)
//   node simulate.js no-match         payment amount does not match any order
//   node simulate.js glam-sample      POST the client's own sample JSON straight to the mock API
// Optional: BASE=https://xxxx.ngrok-free.app node simulate.js happy
const BASE = process.env.BASE || 'http://localhost:3000';
const GLAM = process.env.GLAM || 'http://localhost:4000/api/order-data';
const run = Date.now().toString(36);
const PHONE = process.env.PHONE || '917903596806';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

const post = async (path, body, headers = {}) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  console.log(`POST ${path} -> ${r.status}`);
};
const objectAddress = { values: { name: 'Aisensy HO', in_pin_code: '122015', phone_number: '8826340054',
  address: 'Sector 22, Electronic City', city: 'Gurgaon', landmark_area: 'Maison D Auraine', state: 'Haryana' } };
const customer = () => post('/flow/customer', {
  phone: PHONE, name: 'Test Customer', email: 'test@example.com',
  address: process.env.ADDR === 'string'
    ? 'House 10, Main Road, Connaught Place, New Delhi, Delhi 110001'   // old plain-text style
    : objectAddress,                                                     // what AiSensy really sends
});
const order = (id, at, qty = 2, price = 1) => post('/webhook/aisensy', {
  id: `o-${id}-${run}`, created_at: iso(at), topic: 'order.placed',
  data: { order: { catalog_id: '2260000268174734', text: '',
    product_items: [{ product_retailer_id: '9ftity4c6v', quantity: qty, item_price: price, currency: 'INR' }],
    phone_number: PHONE, messageId: 'wamid.SIM_ORDER_' + id } },
});
const payment = (id, at, rupees = 2) => post('/webhook/aisensy', {
  id: `p-${id}-${run}`, created_at: iso(at), topic: 'payment.captured',
  data: { payment: { reference_id: 'RF-sim' + id, amount: { value: rupees * 100, offset: 100 }, currency: 'INR',
    transaction: { id: 'order_SIM' + id, pg_transaction_id: 'pay_SIM' + id, type: 'razorpay', status: 'success',
                   method: { type: 'upi' } },
    phone_number: PHONE, messageId: 'wamid.SIM_PAY_' + id } },
});

const scenarios = {
  async happy()          { const t = Date.now(); await customer(); await order('a', t); await sleep(300); await payment('a', t + 60000); },
  async 'payment-first'() { const t = Date.now(); await customer(); await payment('b', t + 60000); await sleep(300); await order('b', t); },
  async 'customer-last'() { const t = Date.now(); await order('c', t); await payment('c', t + 60000); await sleep(300); await customer(); },
  async duplicate()      { const t = Date.now(); await customer(); await order('d', t); await order('d', t); await payment('d', t + 60000); await payment('d', t + 60000); },
  async 'same-amount'()  { const t = Date.now(); await customer(); await order('e1', t); await order('e2', t + 120000); await sleep(300); await payment('e', t + 180000); },
  async 'no-match'()     { const t = Date.now(); await customer(); await order('f', t); await sleep(300); await payment('f', t + 60000, 5); },
  async 'glam-sample'() {
    const sample = require('./sample-glam-payload.json');
    const auth = 'Basic ' + Buffer.from('glamorganica:test-password').toString('base64');
    const r = await fetch(GLAM, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(sample) });
    console.log('mock Glam ->', r.status, await r.text());
  },
};

const name = process.argv[2];
if (!scenarios[name]) { console.log('usage: node simulate.js <' + Object.keys(scenarios).join(' | ') + '>'); process.exit(1); }
scenarios[name]().then(async () => {
  await sleep(1200);
  if (name !== 'glam-sample') console.log('\nstate: ' + BASE + '/debug');
});
