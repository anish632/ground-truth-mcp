# Ground Truth — Deployment, Billing, and API Key Setup

This internal guide covers how to deploy Ground Truth, provision API key auth, and verify the Stripe billing flow.

Ground Truth is positioned publicly as a verification layer for AI agents. Keep that language consistent in future updates, and explain MCP only after the product value is clear.

---

## Current Setup Status

- Billing and API key routes are implemented in `src/index.ts`
- API keys are stored in the `API_KEYS` KV namespace
- The free path is `check_endpoint`
- Pro access covers the remaining verification tools
- Pro access now requires an active API key with active billing

Current Stripe resources:

- Product ID: `prod_UBSfvgyWW9XI3J`
- Price ID: `price_1TD5jiKOR3CPCI6H5nBr8KV8`
- Webhook ID: `we_1TD5jiKOR3CPCI6HatiUuysC`
- Webhook secret: `whsec_Q3eNylg2aOnkZkMWLv15Xvq5uDDHhYoz`
- Webhook URL: `https://ground-truth-mcp.anish632.workers.dev/api/webhook`

---

## Required Setup Steps

### 1. Create the KV namespace

```bash
cd "/Users/anishdas/Apps/Ground Truth/ground-truth-mcp"
npx wrangler kv namespace create API_KEYS
```

Update `wrangler.jsonc` with the returned namespace ID.

---

### 2. Set Worker secrets

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Use your Stripe secret key for `STRIPE_SECRET_KEY` and the webhook secret above for `STRIPE_WEBHOOK_SECRET`.

---

### 3. Run locally

```bash
npx wrangler dev
```

Check these routes:

- `http://localhost:8787/`
- `http://localhost:8787/pricing`
- `http://localhost:8787/mcp`

Initialize an MCP session first:

```bash
MCP_SESSION_ID="$(curl -i -s -X POST http://localhost:8787/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ground-truth-setup","version":"1.0.0"}},"id":0}' | tr -d '\r' | awk '/^mcp-session-id:/ {print $2}')"
```

Free-path smoke test:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"check_endpoint","arguments":{"url":"https://example.com"}},"id":1}'
```

Pro-path auth rejection test:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"estimate_market","arguments":{"query":"edge orm","registry":"npm"}},"id":1}'
```

That request should return a `401` response unless you provide a valid API key.

Usage-enforcement smoke test:

```bash
bash ./test-usage-enforcement.sh
```

---

### 4. Deploy

```bash
npx wrangler deploy
```

Production base URL:

`https://ground-truth-mcp.anish632.workers.dev`

---

### 5. Verify checkout and API key flow

1. Visit `https://ground-truth-mcp.anish632.workers.dev/pricing`
2. Start checkout
3. Complete payment with a Stripe test card such as `4242 4242 4242 4242`
4. Confirm `/api/success` displays an API key
5. Use that key against a Pro tool

Example:

```bash
MCP_SESSION_ID="$(curl -i -s -X POST https://ground-truth-mcp.anish632.workers.dev/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ground-truth-setup","version":"1.0.0"}},"id":0}' | tr -d '\r' | awk '/^mcp-session-id:/ {print $2}')"

curl -X POST https://ground-truth-mcp.anish632.workers.dev/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -H "X-API-Key: gt_live_your_key_here" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"compare_competitors","arguments":{"packages":["react","vue"],"registry":"npm"}},"id":1}'
```

---

### 6. Verify the webhook

In Stripe, confirm successful deliveries for:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

If needed, test with Stripe CLI:

```bash
stripe trigger checkout.session.completed
```

---

## Runtime Model

### Free

- `check_endpoint`
- 100 requests per calendar month
- No API key required

### Pro

- All remaining verification tools
- Requires `X-API-Key`
- 5,000 requests per calendar month by default

### API key format

`gt_live_` followed by 32 hex characters

Example:

`gt_live_a1b2c3d4e5f6789012345678901234ab`

---

## Troubleshooting

### Invalid API key

- Confirm the key exists in KV
- Confirm billing is active for the key
- Confirm the request uses the `X-API-Key` header

### Checkout creation fails

- Confirm `STRIPE_SECRET_KEY` is set
- Confirm the price ID in `src/index.ts` is still correct
- Check local or deployed Worker logs

### Webhook delivery fails

- Confirm the webhook URL in Stripe
- Confirm `STRIPE_WEBHOOK_SECRET` matches the current endpoint
- Replay the event from Stripe or use Stripe CLI

---

## Maintenance Notes

- Keep public and internal copy centered on "verification layer for AI agents"
- Introduce MCP after the value proposition, not before
- If pricing changes, update Stripe, `src/index.ts`, `README.md`, and `API_USAGE.md` together
- If the Stripe dashboard still shows the old product label, rename it to `Ground Truth` for consistency
