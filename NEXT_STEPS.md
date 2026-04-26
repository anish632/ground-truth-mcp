# Ground Truth — Operational Next Steps

This internal checklist is for deployment, verification, and follow-up maintenance.

---

## Immediate Deployment Checklist

### 1. Configure KV

```bash
cd "/Users/anishdas/Apps/Ground Truth/ground-truth-mcp"
npx wrangler kv namespace create API_KEYS
```

Update `wrangler.jsonc` with the returned namespace ID.

### 2. Set Worker secrets

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

### 3. Smoke test locally

```bash
npx wrangler dev
```

Check:

- `/`
- `/pricing`
- `/mcp`

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

Pro-path rejection test:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"estimate_market","arguments":{"query":"edge orm","registry":"npm"}},"id":1}'
```

### 4. Deploy

```bash
npx wrangler deploy
```

### 5. Validate checkout

1. Open `/pricing`
2. Start checkout
3. Complete payment
4. Confirm `/api/success` shows an API key
5. Use that key on a Pro tool

### 6. Validate webhook delivery

In Stripe, confirm delivery for:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

---

## Operational Cleanup Items

- Rename the Stripe dashboard product from `Ground Truth MCP` to `Ground Truth` if it still uses the old label
- Keep public copy aligned with `verification layer for AI agents`
- Introduce MCP after the value proposition in public-facing docs
- Keep Free vs Pro descriptions aligned across:
  - `README.md`
  - `API_USAGE.md`
  - `src/index.ts`

---

## When Making Future Changes

### If you add a new tool

- Decide whether it belongs in Free or Pro
- Update `FREE_TOOLS` in `src/index.ts` if needed
- Update `README.md` and `API_USAGE.md`
- Update landing and pricing copy if the offer changes

### If you change pricing

- Update the Stripe price
- Update checkout behavior in `src/index.ts`
- Update public pricing copy
- Update internal setup notes in `SETUP.md`

### If you change auth rules

- Re-test free requests
- Re-test Pro requests with API key
- Re-test `401`, `402`, and `429` responses
- Re-test webhook-driven deactivation
- Re-run `bash ./test-usage-enforcement.sh`

---

## Current References

- Product ID: `prod_UBSfvgyWW9XI3J`
- Price ID: `price_1TD5jiKOR3CPCI6H5nBr8KV8`
- Webhook ID: `we_1TD5jiKOR3CPCI6HatiUuysC`
- Webhook secret: `whsec_Q3eNylg2aOnkZkMWLv15Xvq5uDDHhYoz`
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
- Pro tools reject unauthenticated requests with `401`
- Pro tools reject inactive billing with `402`
- Free or Pro requests over quota return `429`
- Pro tools succeed with a valid API key
- Stripe checkout succeeds end to end
- Webhooks update key state correctly
