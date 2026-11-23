<div align="center">

# WedPlan Server

### The REST API behind WedPlan, a wedding planning platform.

This server stores services, booking requests and payments in MongoDB, verifies the JWT sent by the WedPlan frontend, checks the user's role on every protected route, and turns on Premium only after a verified Stripe webhook.

**Live API:** [wedplan-server-api.vercel.app](https://wedplan-server-api.vercel.app) &nbsp;·&nbsp; **Live Site:** [wedplan-febappi.vercel.app](https://wedplan-febappi.vercel.app)

**Client Repository:** [github.com/febappi/WedPlan](https://github.com/febappi/WedPlan) &nbsp;·&nbsp; **Server Repository:** [github.com/febappi/WedPlan-Server](https://github.com/febappi/WedPlan-Server)

<br>

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?style=for-the-badge&logo=express&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white)
![Stripe](https://img.shields.io/badge/Stripe-API-635BFF?style=for-the-badge&logo=stripe&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES_Modules-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)

</div>

---

## Table of Contents

- [Main Features](#main-features)
- [Technologies I Used](#technologies-i-used)
- [How Authentication and Roles Work](#how-authentication-and-roles-work)
- [API Endpoints](#api-endpoints)
- [Rules the Server Enforces](#rules-the-server-enforces)
- [Running Locally](#running-locally)
- [Deploying to Vercel](#deploying-to-vercel)
- [Project Structure](#project-structure)

## Main Features

- JWT verification with Better Auth's public keys, plus role middleware for admins, vendors and customers
- Public service listing with multi-word search, category, city and price filters, price sorting and pagination
- Vendor service management with ownership checks, admin review (pending, approved, rejected) and a 3-service free plan limit
- Booking requests with server-side validation, duplicate protection and one-time accept, reject or cancel
- Stripe Checkout subscriptions where Premium is switched on only by signed webhook events, including renewals, failed payments and cancellation
- Admin tools for users (search, role filter, block and unblock), services and read-only transactions
- Dashboard statistics for each role
- Clear JSON errors: `400` bad input, `401` not signed in, `403` not allowed, `404` not found, `409` conflict
- Built for serverless: the database connection is checked on every request and reopened if it was closed

## Technologies I Used

- **Node.js** and **Express.js 5** (ES modules)
- **MongoDB** with the official driver
- **jose** for JWT verification
- **Stripe** for Checkout, subscriptions and webhooks
- **cors** and **dotenv**

## How Authentication and Roles Work

1. Users sign in on the Next.js app with Better Auth, which gives the browser a signed JWT.
2. The frontend sends it as `Authorization: Bearer <token>`.
3. The server checks the signature with Better Auth's public keys. It reads them from the shared `jwks` collection in MongoDB, so a check never waits for the frontend to wake up. The frontend's `/api/auth/jwks` is only a fallback when a key is not in the database yet.
4. The issuer and audience must both be `CLIENT_URL`.
5. The user is loaded from the `users` collection. The role and blocked status always come from the database, never from the token alone or the request body.

| Problem | Response |
| --- | --- |
| No token, a bad token or an expired token | `401` |
| A blocked user, the wrong role, or someone else's record | `403` |

## API Endpoints

| Method | Endpoint | Who | Description |
| --- | --- | --- | --- |
| GET | `/` | Public | Health check |
| GET | `/services` | Public | Approved and available services. `search`, `category`, `location`, `minPrice`, `maxPrice`, `sort` (`newest`, `price_asc`, `price_desc`), `page`, `limit` |
| GET | `/services/locations` | Public | Cities that have public services |
| GET | `/services/:id` | Signed in | One service. Pending, rejected or hidden services only for their vendor and admins |
| GET | `/services/mine` | Vendor | The vendor's services and plan limit |
| POST | `/services` | Vendor | Add a service (starts as pending). Free plan: 3 active services |
| PATCH | `/services/:id` | Vendor (owner) | Edit a service; it goes back to pending |
| PATCH | `/services/:id/availability` | Vendor (owner) | Switch a service on or off |
| DELETE | `/services/:id` | Vendor (owner), Admin | Delete a service and cancel its pending requests |
| GET | `/services/admin/all` | Admin | Every service with `search`, `status`, `category` |
| PATCH | `/services/:id/status` | Admin | Set `pending`, `approved` or `rejected` |
| POST | `/bookings` | Customer | Send a booking request |
| GET | `/bookings/mine` | Customer | The customer's requests, optional `status` |
| PATCH | `/bookings/:id/cancel` | Customer (owner) | Cancel a pending request |
| GET | `/bookings/vendor` | Vendor | Requests for the vendor's services, optional `status` |
| PATCH | `/bookings/:id/status` | Vendor (owner) | Accept or reject a pending request |
| GET | `/payments/plan` | Public | Premium price |
| POST | `/payments/checkout-session` | Vendor | Start Stripe Checkout for the signed-in vendor |
| GET | `/payments/session/:id` | Vendor (owner) | Payment status for the success page |
| GET | `/payments/subscription` | Vendor | Current plan and renewal date |
| POST | `/payments/cancel-subscription` | Vendor | Stop renewal; Premium lasts until the paid month ends |
| GET | `/payments/transactions` | Admin | All payments, read only |
| POST | `/payments/webhook` | Stripe | Signed Stripe events |
| GET | `/users/me` | Signed in | The signed-in user's profile |
| GET | `/users` | Admin | Users with `search` and `role` |
| GET | `/users/:id` | Admin | User details and counts |
| PATCH | `/users/:id/block` | Admin | Block or unblock (admins cannot be blocked) |
| GET | `/stats/vendor`, `/stats/customer`, `/stats/admin` | Matching role | Dashboard numbers |

## Rules the Server Enforces

- **Bookings:** only customers can book; only approved and available services; never your own service; the date cannot be in the past; one open request per customer, service and date (a unique partial index on pending and accepted requests); only pending requests can be accepted, rejected or cancelled, and only once.
- **Services:** only the owner can edit, switch or delete; edits go back to admin review; free vendors keep at most 3 active services, and a rejected service that returns to review is switched off if that would go over the limit.
- **Payments:** the vendor always comes from the token; Premium is set only by a verified `checkout.session.completed` or `invoice.paid` webhook; `customer.subscription.deleted` moves the vendor back to Free and switches off services beyond the three newest; there is no endpoint that edits a payment record.

## Running Locally

You need Node.js 20 or newer and a MongoDB database (the same one the frontend uses).

```bash
git clone https://github.com/febappi/WedPlan-Server.git
cd WedPlan-Server
npm install
```

Create a `.env` file in the project root (you can copy `.env.example`):

```env
PORT=5000
CLIENT_URL=http://localhost:3000
MONGODB_URI=your_mongodb_connection_string
DB_NAME=wedplan
STRIPE_SECRET_KEY=sk_test_your_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
PREMIUM_PRICE_AMOUNT=1900
PREMIUM_CURRENCY=usd
```

Then start the server:

```bash
npm run dev    # with auto reload
npm start      # without auto reload
```

The API runs on `http://localhost:5000`.

- `CLIENT_URL` must be the exact frontend URL without a trailing slash. It is used for CORS, the Stripe return links and checking the JWT.
- `MONGODB_URI` and `DB_NAME` must match the frontend, because both use the same `users` and `jwks` collections.
- `PREMIUM_PRICE_AMOUNT` is in the smallest currency unit, so `1900` is $19.00.

### Stripe webhooks on your computer

Install the [Stripe CLI](https://docs.stripe.com/stripe-cli), sign in with `stripe login`, then keep this running and put the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET`:

```bash
stripe listen --forward-to localhost:5000/payments/webhook --events checkout.session.completed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted
```

## Deploying to Vercel

1. Import the repository in Vercel. It runs `index.js` as a serverless function, so no extra config is needed.
2. Add the same environment variables as `.env` (`PORT` is not needed). Set `CLIENT_URL` to the live site URL with `https://`.
3. In MongoDB Atlas, allow connections from anywhere (`0.0.0.0/0`), because Vercel does not use fixed IP addresses.
4. In the Stripe dashboard, add a webhook endpoint for `https://wedplan-server-api.vercel.app/payments/webhook` with the six events above, and put its signing secret in `STRIPE_WEBHOOK_SECRET`.

## Project Structure

```text
index.js            app setup, routes, error handlers and start-up
config.js           the frontend URL, trimmed of a trailing slash
db.js               MongoDB client, collections, indexes and the connection check
middleware/
├── verifyToken.js  checks the JWT and loads the user
└── verifyRole.js   admin, vendor and customer guards
routes/             services, bookings, payments, webhook, users, stats
utils/              plan limits, Stripe client, validation and helpers
```
