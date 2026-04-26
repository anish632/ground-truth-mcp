# Ground Truth — Billing and Auth Implementation Summary

This internal summary describes how Ground Truth's billing and access control work today.

Ground Truth runs on Cloudflare Workers and exposes a verification layer for AI agents over MCP and direct HTTP. The billing layer keeps one free verification path open and gates the broader verification suite behind API keys with Stripe-backed billing state.

---

## Scope Implemented

### Access control

- `check_endpoint` is available without an API key
- All other verification tools are treated as Pro
- Pro requests require a valid `X-API-Key`
- Pro requests also require active billing
- Free requests are capped at 100 requests per calendar month
- Pro requests default to 5,000 requests per calendar month

### Billing routes

- `GET /pricing`
- `POST /api/checkout`
- `GET /api/success`
- `POST /api/webhook`

### Storage

- API keys live in the `API_KEYS` KV namespace
- Monthly usage counters also live in the `API_KEYS` KV namespace
- Cache and request telemetry logs remain in Durable Objects with SQLite

### Preserved behavior

- Existing MCP tool implementations remain intact
- Telemetry remains intact
- Cloudflare Workers architecture remains intact

---

## Auth Flow

1. Request hits `/mcp`
2. If the request targets `check_endpoint`, it can proceed without an API key
3. If the request targets a Pro tool:
   - require a valid `X-API-Key`
   - require active billing
   - enforce the monthly Pro quota
4. Missing or invalid API keys return `401`
5. Inactive billing returns `402`
6. Exhausted monthly quota returns `429`

The free vs Pro split is controlled by the `FREE_TOOLS` constant in `src/index.ts`.

---

## Billing Flow

1. User opens `/pricing`
2. User submits `POST /api/checkout`
3. Worker creates a Stripe Checkout session
4. Stripe redirects back to `/api/success?session_id=...`
5. Worker retrieves the session and creates or reuses an API key
6. Stripe webhook updates subscription state
7. Cancelled subscriptions mark keys inactive

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

## Key Files

- `src/index.ts`
  - auth middleware
  - pricing page
  - checkout route
  - success route
  - webhook route
- `wrangler.jsonc`
  - KV binding configuration
- `setup-stripe.mjs`
  - helper script for creating Stripe resources
- `SETUP.md`
  - deployment and operational setup
- `NEXT_STEPS.md`
  - deployment checklist and follow-up work

---

## Public Positioning Note

The public product story is now:

- Headline: `Stop your AI from being wrong.`
- Category: `verification layer for AI agents`
- Value before protocol: explain the verification benefits first, and MCP second

If future implementation changes touch the landing page, pricing page, README, or API docs, keep that ordering intact.

---

## Operational Follow-Ups

- Ensure `API_KEYS` is configured in every environment
- Keep Stripe price IDs, public pricing copy, and checkout behavior aligned
- If new tools are added, decide explicitly whether they belong in Free or Pro
- If pricing changes, update Stripe resources and public docs together
- Re-run usage enforcement checks after auth or billing changes

---

## Verification Notes

This file documents the implementation structure. For deployment steps and smoke tests, use [SETUP.md](./SETUP.md). For active launch or follow-up tasks, use [NEXT_STEPS.md](./NEXT_STEPS.md).
