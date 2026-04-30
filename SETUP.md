# Ground Truth — Deployment, Billing, and Distribution Setup

This internal guide covers how to deploy Ground Truth, provision billing, and verify both the team-plan and agentic-payment flows.

Ground Truth is positioned publicly as a verification layer for AI agents. Keep that language consistent in future updates, and explain MCP only after the product value is clear.

---

## Current Setup Status

- Billing and API key routes are implemented in `src/index.ts`
- API keys are stored in the `API_KEYS` KV namespace
- Free access covers `check_endpoint`
- Paid tools support both team API-key billing and x402-compatible pay-per-use
- The server publishes MCP metadata at `/.well-known/mcp/server-card.json`

Current Stripe resources:

- Product ID: `prod_UBSfvgyWW9XI3J`
- Price ID: `price_1TD5jiKOR3CPCI6H5nBr8KV8`
- Webhook ID: `we_1TD5jiKOR3CPCI6HatiUuysC`
- Webhook secret: `whsec_Q3eNylg2aOnkZkMWLv15Xvq5uDDHhYoz`
- Webhook URL: `https://ground-truth-mcp.anishdasmail.workers.dev/api/webhook`

These are live production Stripe resources. Reuse them unless pricing or billing structure changes.

---

## Required Setup Steps

### 1. Create the KV namespace

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

Use your Stripe secret key for `STRIPE_SECRET_KEY` and the webhook secret above for `STRIPE_WEBHOOK_SECRET`.

### 3. Optional environment variables

Runtime flags:

- `GROUND_TRUTH_TELEMETRY=false`
  Disables remote telemetry while keeping local usage logs in the Durable Object SQLite store.
- `GROUND_TRUTH_AGENTIC_PAYMENTS=false`
  Turns off direct x402 payment handling and leaves the team plan as the only paid path.
- `STRIPE_PRICE_ID=price_...`
  Overrides the default production Stripe price ID if you need a different plan in another environment.

x402 configuration:

- `GROUND_TRUTH_X402_NETWORK`
  Defaults to `base-sepolia`. Set to `base` for production mainnet USDC flows.
- `GROUND_TRUTH_X402_RECIPIENT`
  Recipient wallet for paid x402 settlements.
- `GROUND_TRUTH_X402_FACILITATOR_URL`
  Optional override. Defaults to the standard facilitator URL for the selected network.

Compatibility aliases also work:

- `X402_NETWORK`
- `X402_RECIPIENT`
- `X402_FACILITATOR_URL`

### 4. Run locally

```bash
npx wrangler dev
```

Check these routes:

- `http://localhost:8787/`
- `http://localhost:8787/pricing`
- `http://localhost:8787/mcp`
- `http://localhost:8787/.well-known/mcp/server-card.json`

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

Agentic unpaid paid-tool smoke test:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"estimate_market","arguments":{"query":"edge orm","registry":"npm"}},"id":2}'
```

That request should return HTTP `200` with MCP payment metadata in `_meta["x402/error"]` unless agentic payments are disabled.

Team-path invalid-key test:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -H "X-API-Key: gt_live_invalid" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"estimate_market","arguments":{"query":"edge orm","registry":"npm"}},"id":3}'
```

That request should return `401`.

Usage-enforcement smoke test:

```bash
bash ./test-usage-enforcement.sh
```

Optional end-to-end x402 test:

```bash
ALLOW_X402_TEST=true PRIVATE_KEY=0x... node test-x402-payment.mjs
```

### 5. Deploy

```bash
npx wrangler deploy
```

Production base URL:

`https://ground-truth-mcp.anishdasmail.workers.dev`

### 6. Verify checkout and API key flow

Use the existing live product and price above. Do not create a second production product for the same team plan unless pricing intentionally changes.

1. Visit `https://ground-truth-mcp.anishdasmail.workers.dev/pricing`
2. Start checkout
3. Complete payment with a Stripe test card such as `4242 4242 4242 4242`
4. Confirm `/api/success` displays an API key
5. Use that key against a paid tool

Example:

```bash
MCP_SESSION_ID="$(curl -i -s -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ground-truth-setup","version":"1.0.0"}},"id":0}' | tr -d '\r' | awk '/^mcp-session-id:/ {print $2}')"

curl -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -H "X-API-Key: gt_live_your_key_here" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"compare_competitors","arguments":{"packages":["react","vue"],"registry":"npm"}},"id":1}'
```

### 7. Verify the webhook

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

### Agentic pay-per-use

- `estimate_market`
- `check_pricing`
- `inspect_security_headers`
- `compare_pricing_pages`
- `compare_competitors`
- `verify_claim`
- `assess_compliance_posture`
- `test_hypothesis`
- x402-compatible direct flow or xpay proxy flow

### Team

- The same paid tool set as agentic pay-per-use
- Requires `X-API-Key`
- 5,000 requests per calendar month by default

### API key format

`gt_live_` followed by 32 hex characters

Example:

`gt_live_a1b2c3d4e5f6789012345678901234ab`

---

## Distribution and Monetization Setup

### Official MCP Registry

- Publish the remote server metadata from `server.json`
- Server name: `io.github.anish632/ground-truth`
- Remote URL: `https://ground-truth-mcp.anishdasmail.workers.dev/mcp`
- This repo now includes `.github/workflows/publish-mcp-registry.yml` so a `v*` tag can publish to the registry with GitHub OIDC
- If publishing manually, use `mcp-publisher login github` and `mcp-publisher publish`

### xpay

- Register the production `/mcp` URL with xpay if you want a managed pay-per-tool proxy
- Use the production MCP URL: `https://ground-truth-mcp.anishdasmail.workers.dev/mcp`
- Recommended provider slug: `ground-truth`
- xpay can auto-discover tools from the live server or the server card at `https://ground-truth-mcp.anishdasmail.workers.dev/.well-known/mcp/server-card.json`
- Start with per-tool pricing that matches the Worker metadata:
  - `estimate_market` → `$0.01`
  - `check_pricing` → `$0.02`
  - `inspect_security_headers` → `$0.02`
  - `compare_competitors` → `$0.03`
  - `compare_pricing_pages` → `$0.04`
  - `verify_claim` → `$0.05`
  - `assess_compliance_posture` → `$0.05`
  - `test_hypothesis` → `$0.05`
- Publish the resulting proxy URL anywhere you want agentic usage without native x402 support
- For a dedicated xpay upstream, deploy the separate Worker with `npm run deploy:xpay`
- The xpay-specific upstream URL is `https://ground-truth-mcp-xpay.anishdasmail.workers.dev/mcp`
- Configure xpay upstream auth with:
  - Header: `X-Ground-Truth-Xpay-Secret`
  - Value: the `GROUND_TRUTH_XPAY_UPSTREAM_SECRET` secret configured on the xpay Worker
- A more proxy-friendly option is:
  - Header: `Authorization`
  - Value: `Bearer <GROUND_TRUTH_XPAY_UPSTREAM_SECRET>`
- The xpay-specific Worker skips native team/x402 billing only when that shared-secret header is present
- If xpay runtime calls do not forward the custom header reliably, use the hidden-path variant instead:
  - Upstream URL: `https://ground-truth-mcp-xpay.anishdasmail.workers.dev/mcp-xpay-<GROUND_TRUTH_XPAY_UPSTREAM_PATH_SECRET>`
  - No upstream auth header required
- A simpler fallback is the query-token variant:
  - Upstream URL: `https://ground-truth-mcp-xpay.anishdasmail.workers.dev/mcp?xpay_secret=<GROUND_TRUTH_XPAY_UPSTREAM_PATH_SECRET>`
  - No upstream auth header required

### Smithery

- Form values:
  - Namespace / Server ID: `anishdasmail / ground-truth`
  - MCP Server URL: `https://ground-truth-mcp.anishdasmail.workers.dev/mcp`
- Publish the production remote MCP URL
- Recommended namespace/server slug: `anishdasmail / ground-truth`
- Point Smithery to `https://ground-truth-mcp.anishdasmail.workers.dev/mcp`
- The `/.well-known/mcp/server-card.json` route is available as metadata fallback
- If Smithery's scan is blocked by Cloudflare bot protection, allow `SmitheryBot/1.0` or rely on the static server card

### MCP Market

- Create or update the listing with the production MCP URL
- Emphasize pricing verification, compliance posture, and security posture in the description

### Apify

- Optional only
- Best treated as a separate marketplace distribution project if you want Apify-native usage billing later

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

### x402 payment flow fails

- Confirm `GROUND_TRUTH_X402_RECIPIENT` is a valid wallet
- Confirm the configured network matches the client wallet
- Confirm the facilitator URL is reachable
- If using testnet, confirm the wallet has test USDC

### Webhook delivery fails

- Confirm the webhook URL in Stripe
- Confirm `STRIPE_WEBHOOK_SECRET` matches the current endpoint
- Replay the event from Stripe or use Stripe CLI

---

## Maintenance Notes

- Keep public and internal copy centered on "verification layer for AI agents"
- Introduce MCP after the value proposition, not before
- If pricing changes, update Stripe, `src/index.ts`, `README.md`, and `API_USAGE.md` together
- If agentic prices change, update `AGENTIC_TOOL_PRICES_USD`, the pricing page copy, and the server card together
- The current live Stripe dashboard label is `Ground Truth MCP`; rename it to `Ground Truth` only if you want tighter branding consistency
