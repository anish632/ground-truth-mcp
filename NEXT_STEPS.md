# Ground Truth — Operational Next Steps

This internal checklist is for deployment, verification, and follow-up maintenance.

---

## Immediate Deployment Checklist

### 1. Configure KV

```bash
cd "/Users/anishdas/Apps-Tier 1/groundtruth-mcp/ground-truth-mcp"
npx wrangler kv namespace create API_KEYS
```

Update `wrangler.jsonc` with the returned namespace ID.

### 2. Set Worker secrets

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

### 3. Configure environment variables

- Set `GROUND_TRUTH_X402_RECIPIENT` for the wallet that should receive agentic payments
- Set `GROUND_TRUTH_X402_NETWORK=base` if you want production mainnet billing instead of the default `base-sepolia`
- Optionally set `GROUND_TRUTH_X402_FACILITATOR_URL` if you need a custom facilitator
- Optionally set `STRIPE_PRICE_ID` if a non-default Stripe plan should be used
- Set `GROUND_TRUTH_TELEMETRY=false` if you want to disable remote telemetry

### 4. Smoke test locally

```bash
npx wrangler dev
```

Check:

- `/`
- `/pricing`
- `/mcp`
- `/.well-known/mcp/server-card.json`

Initialize an MCP session first:

```bash
MCP_SESSION_ID="$(curl -i -s -X POST http://localhost:8787/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ground-truth-next-steps","version":"1.0.0"}},"id":0}' | tr -d '\r' | awk '/^mcp-session-id:/ {print $2}')"
```

Free-path test:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"check_endpoint","arguments":{"url":"https://example.com"}},"id":1}'
```

Agentic unpaid paid-tool test:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"estimate_market","arguments":{"query":"edge orm","registry":"npm"}},"id":2}'
```

Team invalid-key rejection test:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -H "X-API-Key: gt_live_invalid" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"estimate_market","arguments":{"query":"edge orm","registry":"npm"}},"id":3}'
```

Run the request smoke tests:

```bash
bash ./test-usage-enforcement.sh
```

Optional paid-loop test:

```bash
ALLOW_X402_TEST=true PRIVATE_KEY=0x... node test-x402-payment.mjs
```

### 5. Deploy

```bash
npx wrangler deploy
```

### 6. Validate checkout

Use the existing live Stripe product and price for this flow.

1. Open `/pricing`
2. Start checkout
3. Complete payment
4. Confirm `/api/success` shows an API key
5. Use that key on a paid tool

### 7. Validate webhook delivery

In Stripe, confirm delivery for:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

---

## Distribution Checklist

### xpay

- Register the production `/mcp` URL if you want a managed pay-per-tool proxy
- Confirm per-tool prices match the pricing page and server card

### Smithery

- Publish the production remote MCP URL
- Confirm the listing reads the server card correctly
- Apply for a verified badge if appropriate

### MCP Market

- Refresh the listing description and categories
- Highlight pricing verification, compliance posture, and security posture

### GitHub and Glama

- Push the latest `main`
- Tag the release when ready
- Trigger Glama sync after release if discovery metadata looks stale

---

## Operational Cleanup Items

- Rename the Stripe dashboard product from `Ground Truth MCP` to `Ground Truth` if it still uses the old label
- Keep public copy aligned with `verification layer for AI agents`
- Introduce MCP after the value proposition in public-facing docs
- Keep Free / Agentic / Team descriptions aligned across:
  - `README.md`
  - `API_USAGE.md`
  - `SETUP.md`
  - `src/index.ts`

---

## When Making Future Changes

### If you add a new tool

- Decide whether it belongs in Free or Paid
- Update `FREE_TOOLS` in `src/index.ts` if needed
- Update `AGENTIC_TOOL_PRICES_USD` if it is paid
- Update `README.md` and `API_USAGE.md`
- Update landing and pricing copy if the offer changes
- Update the server card metadata

### If you change pricing

- Update the Stripe price or monthly-plan copy
- Update x402 prices in `src/index.ts`
- Update public pricing copy
- Update internal setup notes in `SETUP.md`

### If you change auth or payment rules

- Re-test free requests
- Re-test team requests with API key
- Re-test `401`, `402`, and `429` responses
- Re-test the unpaid x402 payment-required response
- Re-test webhook-driven deactivation
- Re-run `bash ./test-usage-enforcement.sh`

---

## Current References

- Product ID: `prod_UBSfvgyWW9XI3J`
- Price ID: `price_1TD5jiKOR3CPCI6H5nBr8KV8`
- Webhook ID: `we_1TD5jiKOR3CPCI6HatiUuysC`
- Production URL: `https://ground-truth-mcp.anishdasmail.workers.dev`

---

## Useful Docs

- [README.md](./README.md)
- [API_USAGE.md](./API_USAGE.md)
- [SETUP.md](./SETUP.md)
- [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md)

---

## Success Criteria

You are in a good state when:

- The homepage and pricing page use the current verification-layer positioning
- `check_endpoint` works without auth
- Paid tools advertise x402 payment metadata when called without a team key
- Team requests reject inactive billing with `402`
- Free or team requests over quota return `429`
- Paid tools succeed with a valid team key
- Stripe checkout succeeds end to end
- Webhooks update key state correctly
