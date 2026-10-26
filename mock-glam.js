// mock-glam.js - stands in for https://www.glamorganica.com/api/order-data while testing. Port 4000.
// Checks Basic auth + required fields like a real API would, and logs every body it receives.
//   MOCK_USER / MOCK_PASS   credentials (default glamorganica / test-password)
//   MOCK_STRICT=true        also REJECT empty address locality/city/state (default: only warn)
const express = require('express');
const fs = require('fs');

const USER = process.env.MOCK_USER || 'glamorganica';
const PASS = process.env.MOCK_PASS || 'test-password';
const STRICT = process.env.MOCK_STRICT === 'true';

const app = express();
app.use(express.json());
let counter = 1000;

app.post('/api/order-data', (req, res) => {
  const auth = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  if (auth !== expected) {
    console.log('REJECTED 401: bad credentials');
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  const b = req.body || {};
  const errors = [], warnings = [];
  const need = (obj, keys, where) => keys.forEach((k) => {
    if (obj?.[k] === undefined || obj[k] === null || obj[k] === '') errors.push(`${where}${k} is required`);
  });

  need(b, ['CustomerName', 'CustomerEmailID', 'CustomerPhoneNo', 'OrderTotalAmount', 'PaymentOption',
           'PaymentID', 'TransactionID', 'TransactionStatus'], '');
  need(b.ShippingAddress, ['CustomerShippingAddressName', 'CustomerShippingAddressPhoneNo',
           'CustomerShippingAddressPinCode', 'CustomerShippingAddressFullAddress'], 'ShippingAddress.');
  for (const k of ['CustomerShippingAddressLocality', 'CustomerShippingAddressCity', 'CustomerShippingAddressState']) {
    if (!b.ShippingAddress?.[k]) (STRICT ? errors : warnings).push(`ShippingAddress.${k} is empty`);
  }
  if (!/^\d{10}$/.test(String(b.CustomerPhoneNo || ''))) errors.push('CustomerPhoneNo must be 10 digits');
  if (!/^\d{6}$/.test(String(b.ShippingAddress?.CustomerShippingAddressPinCode || ''))) errors.push('PinCode must be 6 digits');
  if (b.TransactionStatus !== 'Success') errors.push('TransactionStatus must be "Success"');

  if (!Array.isArray(b.Products) || !b.Products.length) {
    errors.push('Products must be a non-empty array');
  } else {
    b.Products.forEach((p, i) => {
      need(p, ['ProductSKU', 'ProductQuantity', 'ProductSalePrice', 'ProductMRP'], `Products[${i}].`);
      if (!(p.ProductQuantity > 0)) errors.push(`Products[${i}].ProductQuantity must be > 0`);
    });
    const sum = b.Products.reduce((s, p) => s + p.ProductQuantity * p.ProductSalePrice, 0);
    if (Math.abs(sum - b.OrderTotalAmount) > 0.01)
      warnings.push(`OrderTotalAmount ${b.OrderTotalAmount} != sum of products ${sum}`);
  }

  fs.appendFileSync('mock_received.log', JSON.stringify({ at: new Date().toISOString(), errors, warnings, body: b }) + '\n');

  if (errors.length) {
    console.log('REJECTED 400:', errors.join(' | '));
    return res.status(400).json({ status: 'error', errors });
  }
  const orderId = `MOCK-${++counter}`;
  console.log(`ACCEPTED ${orderId}  total=${b.OrderTotalAmount}  payment=${b.PaymentID}`, warnings.length ? `| warnings: ${warnings.join('; ')}` : '');
  res.json({ status: 'success', orderId, warnings });
});

app.listen(process.env.MOCK_PORT || 4000, () =>
  console.log(`mock Glam API on :${process.env.MOCK_PORT || 4000}  (user=${USER}, strict=${STRICT})`)
);
