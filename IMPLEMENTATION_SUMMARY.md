# Ground Truth — Billing and Access Implementation Summary

This internal summary describes how Ground Truth's billing and access control work today.

Ground Truth runs on Cloudflare Workers and exposes a verification layer for AI agents over MCP and direct HTTP. The billing layer keeps one free verification path open, supports team API-key billing through Stripe, and supports agentic pay-per-use through x402-compatible payment flows.

---

## Scope Implemented

### Access control

- `check_endpoint` is available without an API key
- All other verification tools are paid
- Paid requests can use either:
  - a valid `X-API-Key` with active billing
  - an x402 payment payload sent through MCP `_meta`
- Free requests are capped at 100 requests per calendar month
- Team requests default to 5,000 requests per calendar month

### Billing routes

- `GET /pricing`
- `POST /api/checkout`
- `GET /api/success`
- `POST /api/webhook`

### Discovery and metadata routes

- `GET /.well-known/mcp/server-card.json`

### Storage

- API keys live in the `API_KEYS` KV namespace
- Monthly usage counters also live in the `API_KEYS` KV namespace
- Cache, request telemetry logs, and paid-response replay cache live in Durable Objects with SQLite

### Preserved behavior

- Existing MCP tool implementations remain intact
- Telemetry remains intact and can be disabled
- Cloudflare Workers architecture remains intact

---

## Access Flow

1. Request hits `/mcp`
2. If the request targets `check_endpoint`, it can proceed without an API key
3. If the request targets a paid tool and includes `X-API-Key`:
   - require a valid API key
   - require active billing
   - enforce the monthly team quota
4. If the request targets a paid tool and does not include `X-API-Key`:
   - advertise x402 payment requirements in MCP `_meta`
   - verify the payment payload on retry
   - execute the tool
   - settle the payment
5. Missing or invalid explicit team API keys return `401`
6. Inactive team billing returns `402`
7. Exhausted monthly free or team quotas return `429`
8. Unpaid agentic calls return HTTP `200` with `_meta["x402/error"]`

The free-vs-paid split is controlled by the `FREE_TOOLS` constant in `src/index.ts`.

---

## Billing Flow

### Team plan

1. User opens `/pricing`
2. User submits `POST /api/checkout`
3. Worker creates a Stripe Checkout session
4. Stripe redirects back to `/api/success?session_id=...`
5. Worker retrieves the session and creates or reuses an API key
6. Stripe webhook updates subscription state
7. Cancelled subscriptions mark keys inactive

### Agentic pay-per-use

1. Client calls a paid tool without `X-API-Key`
2. Tool returns `_meta["x402/error"]` with payment requirements
3. Client or proxy signs and retries with `_meta["x402/payment"]`
4. Worker verifies the payment, executes the tool, and settles the payment
5. Successful result returns `_meta["x402/payment-response"]`
6. The payment token hash is cached to make paid retries idempotent

---

## Stored API Key Shape

Keys are stored in KV as JSON records similar to:

```json
{
  "active": true,
  "billingActive": true,
  "subscriptionStatus": "active",
  "monthlyQuota": 5000,
  "email": "customer@example.com",
  "stripeCustomerId": "cus_xxx",
  "subscriptionId": "sub_xxx",
  "createdAt": "2026-04-26T00:00:00.000Z"
}
```

Key format:

`gt_live_` + 32 hex characters

---

## Stripe Resources

Current resources used by the project:

- Product ID: `prod_UBSfvgyWW9XI3J`
- Price ID: `price_1TD5jiKOR3CPCI6H5nBr8KV8`
- Webhook ID: `we_1TD5jiKOR3CPCI6HatiUuysC`
- Webhook secret: `whsec_Q3eNylg2aOnkZkMWLv15Xvq5uDDHhYoz`
- Webhook URL: `https://ground-truth-mcp.anishdasmail.workers.dev/api/webhook`

Note: some older Stripe dashboard resources may still carry the previous `Ground Truth MCP` label. Operationally that is fine, but rename them if you want naming consistency in Stripe.

---

## x402 Runtime Defaults

- Default network: `base-sepolia`
- Default facilitator: `https://x402.org/facilitator`
- Default mainnet facilitator: `https://api.cdp.coinbase.com/platform/v2/x402`
- Recipient wallet is configurable via environment variable
- Agentic payments can be disabled with `GROUND_TRUTH_AGENTIC_PAYMENTS=false`

---

## Key Files

- `src/index.ts`
  - auth middleware
  - pricing page
  - checkout route
  - success route
  - webhook route
  - x402 payment flow
  - server card route
- `wrangler.jsonc`
  - KV binding configuration
- `SETUP.md`
  - deployment and operational setup
- `NEXT_STEPS.md`
  - deployment checklist and follow-up work

---

## Public Positioning Note

The public product story is now:

- Headline: `Stop your AI from being wrong.`
- Category: `verification layer for AI agents`
- Billing story: `free endpoint checks`, `agentic pay-per-use`, `team subscription`
- Value before protocol: explain the verification benefits first, and MCP second

If future implementation changes touch the landing page, pricing page, README, or API docs, keep that ordering intact.

---

## Operational Follow-Ups

- Ensure `API_KEYS` is configured in every environment
- Keep Stripe price IDs, public pricing copy, and checkout behavior aligned
- Keep x402 recipient, network, and public pricing copy aligned
- If new tools are added, decide explicitly whether they belong in Free or Paid
- If pricing changes, update Stripe resources, x402 prices, and public docs together
- Re-run usage enforcement checks after auth or billing changes

---

## Verification Notes

This file documents the implementation structure. For deployment steps and smoke tests, use [SETUP.md](./SETUP.md). For active launch or follow-up tasks, use [NEXT_STEPS.md](./NEXT_STEPS.md).
