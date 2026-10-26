# AiSensy → Glam Organica middleware (local test setup, Windows)

## What it does
Glam's API wants ONE request with customer + address + products + payment. AiSensy gives you three separate inputs:

| Input | Comes from | Endpoint |
|---|---|---|
| Name, email, address, phone | Flow → API request block | `POST /flow/customer` |
| Products, qty, price | `order.placed` webhook | `POST /webhook/aisensy` |
| Payment + transaction IDs | `payment.captured` webhook | `POST /webhook/aisensy` |

All three are saved in SQLite (`middleware.db`). When all three are present for a phone number
(in ANY order), the middleware builds Glam's body and POSTs it to `GLAM_URL`
(default: the local mock on port 4000).

Matching rule (no shared key exists): same 10-digit phone + payment amount = order total
+ payment within 30 min after the order. Latest matching order wins.

## 1. One-time setup
1. Install Node.js 22.13 or newer (LTS) from nodejs.org (check: `node -v`).
2. Open PowerShell in this folder and run: `npm install`

## 2. Run (two PowerShell windows)
```
# window 1 - fake Glam API on :4000
npm run mock

# window 2 - the middleware on :3000
npm start
```

## 3. Test without WhatsApp first
```
node simulate.js glam-sample     # client's own sample JSON -> mock Glam (checks auth + validation)
node simulate.js happy           # customer -> order -> payment
node simulate.js payment-first   # payment arrives before order
node simulate.js customer-last   # address arrives last
node simulate.js duplicate       # AiSensy retries
node simulate.js same-amount     # shows the ambiguity risk
node simulate.js no-match        # payment that matches no order
```
Use `$env:PHONE="919000000001"; node simulate.js customer-last` for a fresh phone number
(a number that already has a saved profile skips the "waiting for address" step).

Watch window 2: `>> order #N matched RF-... -> Glam sent (200)` means success.
Inspect everything at http://localhost:3000/debug and one full order at http://localhost:3000/debug/order/1

## 4. Test with real AiSensy
1. Install ngrok, then in a third window: `ngrok http 3000`. Copy the https URL.
2. Flow → API request block (place it AFTER the address step, BEFORE the payment request):
   - POST `https://<ngrok-url>/flow/customer`, header `Content-Type: application/json`
   ```json
   {
     "phone": "$MobileNumber",
     "name": "$customerName",
     "email": "$customerEmail",
     "address": "$customerAddress"
   }
   ```
3. AiSensy webhook settings: subscribe BOTH `order.placed` and `payment.captured`
   to `https://<ngrok-url>/webhook/aisensy`.
4. Place a real test order (₹1-2) and pay.
5. Check window 2, `/debug`, `requests.log` (raw AiSensy bodies), `mock_received.log` (what Glam would get).

If the flow call logs `BAD JSON`, the address has quotes/line breaks that broke the JSON; the raw text is shown.
If it logs `WARN ... still a raw variable`, AiSensy did not fill that variable.

## 5. Switching from the mock to Glam's real API (only after Glam agrees)
```
$env:GLAM_URL="https://www.glamorganica.com/api/order-data"
$env:GLAM_USER="<username>"
$env:GLAM_PASS="<password>"
npm start
```
This creates REAL orders at Glam. Never hardcode the credentials in files.

## Mock options
- `$env:MOCK_STRICT="true"; npm run mock` → also rejects empty locality/city/state (default: only warns)
- Mock login: user `glamorganica`, password `test-password` (`MOCK_USER` / `MOCK_PASS` to change)


## Known limits
- Same customer, same cart value, within 30 min → can pair a payment with the wrong order (no shared key in the webhooks).
- `ProductSKU` = the catalog Content ID (`product_retailer_id`). Must equal Glam's SKU.
- GST = 18% inclusive of sale price; shipping = 0; MRP = sale price (change in `logic.js` → CONFIG / buildGlamBody).
