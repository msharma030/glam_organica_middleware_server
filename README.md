# AiSensy → Glam Organica Order Middleware

A small Node.js service that turns a WhatsApp catalog order (AiSensy flow + WhatsApp Pay) into a single, complete order request for Glam Organica's backend API.

![node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-green) ![status](https://img.shields.io/badge/status-testing-orange)

---

## Table of contents
1. [Problem](#1-problem)
2. [How it works](#2-how-it-works)
3. [Architecture](#3-architecture)
4. [Matching logic](#4-matching-logic)
5. [Endpoints](#5-endpoints)
6. [Payload mapping](#6-payload-mapping)
7. [Project structure](#7-project-structure)
8. [Getting started](#8-getting-started)
9. [Configuration](#9-configuration)
10. [Testing](#10-testing)
11. [Connecting real AiSensy](#11-connecting-real-aisensy)
12. [Going live against Glam's API](#12-going-live-against-glams-api)
13. [Operations and troubleshooting](#13-operations-and-troubleshooting)
14. [Known limitations](#14-known-limitations)
15. [Open items](#15-open-items)
16. [Security](#16-security)
17. [Roadmap](#17-roadmap)

---

## 1. Problem
Glam's API (`POST /api/order-data`) expects **one** request containing customer, address, products and payment details. AiSensy provides this data in **three separate places**, with no shared key between the two webhooks:

| Data | Source | Notes |
|---|---|---|
| Name, email, address, phone | Flow → API request block | Collected in the flow, not present in webhooks |
| Products, quantity, price | `order.placed` webhook | No payment reference |
| Payment and transaction IDs | `payment.captured` webhook | Has `reference_id` (RF-…), no products |

## 2. How it works
1. The flow calls `POST /flow/customer` with the customer's details.
2. AiSensy sends `order.placed`, then `payment.captured`, to `POST /webhook/aisensy`.
3. Everything is stored in SQLite. Inputs can arrive in **any order**.
4. When customer profile + pending order + successful payment exist for a phone number, the middleware builds Glam's body and calls Glam **once**.
5. Duplicate webhooks (AiSensy retries up to 15 times) are ignored. Failed sends are kept and can be retried.

## 3. Architecture
```
WhatsApp customer
      │
      ▼
AiSensy flow ──(API request block)──► POST /flow/customer ─┐
      │                                                    │
      ├─ order.placed ──────────────► POST /webhook/aisensy ┤──► SQLite
      └─ payment.captured ──────────► POST /webhook/aisensy ┘   (customers, orders, payments, events)
                                                               │
                                              reconcile(phone) │ all 3 present?
                                                               ▼
                                         POST {GLAM_URL}/api/order-data
                                         headers: username, password
```

## 4. Matching logic
There is no shared key, so a payment is paired with an order when **all** hold:

- same last-10-digits phone number
- order total equals payment amount (`value / offset`)
- payment arrives within **30 minutes** after the order (1 minute clock-skew tolerance)
- the latest matching order wins; ambiguity is flagged in the log

Only payments with `transaction.status = success` are used.

## 5. Endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | `/flow/customer` | Receives customer name, email, address, phone from the flow |
| POST | `/webhook/aisensy` | Receives `order.placed` and `payment.captured` (other topics are ignored) |
| GET | `/debug` | Overview of customers, orders, payments |
| GET | `/debug/order/:id` | Full detail of one order, including the body sent to Glam and Glam's response |
| POST | `/admin/retry/:id` | Re-send a stored body for a failed order |

Webhooks are acknowledged with `200` immediately, then processed.

## 6. Payload mapping
| Glam field | Source |
|---|---|
| `CustomerName`, `CustomerEmailID` | Flow API block (`name`, `email`) |
| `CustomerPhoneNo` | `order.placed` phone, last 10 digits |
| `OrderTotalAmount` | `payment.captured` amount (`value / offset`) |
| `TotalGSTAmount` | Calculated: `paid − paid / 1.18` (GST treated as inclusive, **to be confirmed**) |
| `TotalShippingAmount`, `CouponCode`, `CouponValue` | `0`, `""`, `0` |
| `PaymentOption` | `"Online"` |
| `PaymentID` | `transaction.pg_transaction_id` (`pay_…`) |
| `TransactionID` | `transaction.id` (`order_…`) |
| `TransactionStatus` | `"Success"` |
| `ShippingAddress.*` | Flow address form: `in_pin_code`, `address`, `landmark_area`, `city`, `state`, `name`, `phone_number` |
| `Products[].ProductSKU` | `product_retailer_id` (Commerce Manager "Content ID") |
| `Products[].ProductQuantity` | `quantity` |

> **Pending:** Glam's latest spec uses `{ProductSKU, SizeID, ProductQuantity}` with no price or MRP. The current code still sends `ProductSalePrice` / `ProductMRP` and no `SizeID`. A product mapping (retailer ID → SKU + SizeID) is planned once Glam supplies the values.

## 7. Project structure
```
.
├── server.js                 # Express app, routes, request logging
├── logic.js                  # Store, match, build body, send to Glam
├── db.js                     # SQLite schema (node:sqlite)
├── mock-glam.js              # Local stand-in for Glam's API (port 4000)
├── simulate.js               # Scenario runner (no WhatsApp needed)
├── sample-glam-payload.json  # Glam's original sample body
├── package.json
└── README.md
```
Generated at runtime (do not commit): `middleware.db*`, `requests.log`, `mock_received.log`.

## 8. Getting started
**Requirements:** Node.js 22.13 or newer (uses built-in `node:sqlite`). Tested on Node 24, Windows PowerShell.

```powershell
npm install
npm run mock    # window 1: fake Glam API on :4000
npm start       # window 2: middleware on :3000
```

## 9. Configuration
| Variable | Default | Description |
|---|---|---|
| `GLAM_URL` | `http://localhost:4000/api/order-data` | Glam endpoint |
| `GLAM_USER` / `GLAM_PASS` | mock values for localhost only | Required for any non-local URL |
| `GLAM_AUTH_MODE` | custom headers | Set to `basic` to send `Authorization: Basic` instead of `username`/`password` headers |
| `DB_FILE` | `middleware.db` | SQLite file |
| `PORT` | `3000` | Middleware port |
| `MOCK_STRICT` | off | Mock rejects empty locality/city/state |
| `MOCK_USER` / `MOCK_PASS` | `glamorganica` / `test-password` | Mock login |

Matching constants (`MATCH_WINDOW_MS`, `GST_RATE`, `SHIPPING`) are in `logic.js` → `CONFIG`.

## 10. Testing
Simulated scenarios (no WhatsApp needed):
```powershell
node simulate.js glam-sample     # Glam's own sample JSON against the mock
node simulate.js happy           # customer → order → payment
node simulate.js payment-first   # payment before order
node simulate.js customer-last   # address arrives last
node simulate.js duplicate       # AiSensy retries
node simulate.js same-amount     # shows the ambiguity risk
node simulate.js no-match        # payment matching no order
```
Success looks like: `>> order #N matched RF-... -> Glam sent (200)`.
Use `$env:PHONE="919000000001"` for a fresh phone number.

## 11. Connecting real AiSensy
1. Expose the middleware publicly (for testing, `ngrok http 3000`).
2. **Flow → API request block**, placed after the address step and before the payment request:
   - `POST https://<public-url>/flow/customer`, header `Content-Type: application/json`
   ```json
   {
     "phone": "$MobileNumber",
     "name": "$customerName",
     "email": "$customerEmail",
     "address": "$customerAddress"
   }
   ```
3. **Webhooks:** subscribe `order.placed` and `payment.captured` to `https://<public-url>/webhook/aisensy`.
4. Place a small real order (₹1–2) and pay.
5. Verify in the middleware console, `/debug`, `requests.log` (raw AiSensy bodies) and `mock_received.log`.

> Do not share one public URL between two AiSensy projects: events from the other project will land in this service and its logs.

## 12. Going live against Glam's API
Only after Glam confirms, since this **creates real orders**:
```powershell
$env:GLAM_URL="https://www.glamorganica.com/api/order-data"
$env:GLAM_USER="<username>"
$env:GLAM_PASS="<password>"
npm start
```
Then verify the order at Glam using the `TransactionID` from `/debug/order/<id>`.

## 13. Operations and troubleshooting
| Symptom | Likely cause |
|---|---|
| Nothing in logs after a real order | Webhook not subscribed, paused after failures, or tunnel URL changed |
| `phone is missing` / `$MobileNumber` literal | Flow variable not substituted (test button); run the real flow |
| `address is [object Object]` | Old version; update `logic.js` |
| `BAD JSON` | Address contains quotes or line breaks; raw text is logged |
| `send_failed (4xx/5xx)` | Check Glam's response in `/debug/order/<id>`, fix, then `POST /admin/retry/<id>` |
| Order stays `pending` | Payment not received, amount differs, or outside the 30-minute window |

Retry a failed order: `curl.exe -X POST http://localhost:3000/admin/retry/<orderId>`

## 14. Known limitations
- Same customer, same cart value within 30 minutes can pair a payment with the wrong order. Fix: AiSensy adds `reference_id` to `order.placed`.
- Webhook signature (`X-AiSensy-Signature`) is not verified.
- Runs locally; not yet hosted, no automatic retries or alerts.
- Raw webhook bodies are logged, which includes customer phone numbers. Treat `requests.log` as sensitive.

## 15. Open items
Needed from Glam:
- [ ] `SizeID`: meaning and source per product
- [ ] SKUs: equal to catalog IDs/content id of Meta commerce manager, update the mapping between Meta's content id and Glam's SKU
- [ ] `OrderTotalAmount`: before or after GST and shipping; GST on top or included; shipping value
- [ ] Which Razorpay values go in `PaymentID` and `TransactionID`

## 16. Security
- Never commit credentials. Use environment variables.
- Add to `.gitignore`:
  ```
  node_modules/
  middleware.db*
  *.log
  .env
  ```
- Before production: verify the AiSensy webhook signature, filter by AiSensy `project_id`, and serve over HTTPS.

## 17. Roadmap
1. Update the order body: SKU mapping + `SizeID`, prices removed
2. Joint live test order, marked as a test
3. Host the service with retries and alerts
4. Go live and monitor the first orders
