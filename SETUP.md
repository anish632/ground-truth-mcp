# Ground Truth — Deployment, Billing, and Distribution Setup

This internal guide covers how to deploy Ground Truth, provision billing, and verify both the team-plan and agentic-payment flows.

Ground Truth is positioned publicly as competitive change evidence for B2B SaaS teams and their agents. The product-led activation path is three persistent monitors free in `/watch`; preflight tools support that core workflow.

---

## Current Setup Status

- Billing and API key routes are implemented in `src/index.ts`
- API keys are stored in the `API_KEYS` KV namespace
- Free access includes three persistent daily or weekly monitors, 100 monitor actions/month, core preflight tools, and a limited `verify_claim` allowance
- Paid tools support both team API-key billing and x402-compatible pay-per-use
- The server publishes MCP metadata at `/.well-known/mcp/server-card.json`
- The Worker Durable Object exposes rolling unique/repeat-user and paid-usage metrics at `/stats`

Current Stripe resources:

- Product ID: `prod_UBSfvgyWW9XI3J`
- Price ID: `price_1TD5jiKOR3CPCI6H5nBr8KV8`
- Webhook ID: `we_1TD5jiKOR3CPCI6HatiUuysC`
- Webhook secret: stored as the `STRIPE_WEBHOOK_SECRET` Worker secret; never commit the value
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

Use your Stripe secret key for `STRIPE_SECRET_KEY` and retrieve the signing secret from Stripe for `STRIPE_WEBHOOK_SECRET`.

Optional secrets for recurring-revenue features:

```bash
# Email change alerts (lets monitors use mailto: destinations). Omit to keep
# webhook + Slack alerts only; mailto: monitors are then rejected at creation.
npx wrangler secret put RESEND_API_KEY
# Annual billing (2 months free). Create a yearly Stripe price per tier, then:
npx wrangler secret put STRIPE_PRICE_ID_ANNUAL         # Monitor  $90/yr
npx wrangler secret put STRIPE_PRICE_ID_BETTER_ANNUAL  # Team     $290/yr
npx wrangler secret put STRIPE_PRICE_ID_BEST_ANNUAL    # Scale    $990/yr
```

`RESEND_FROM` (optional var) sets the From address for email alerts. Annual pricing only appears on `/pricing` for the tiers whose annual price ID is configured; without it, checkout stays monthly-only.

### 3. Optional environment variables

Runtime flags:

- `GROUND_TRUTH_TELEMETRY=false`
  Disables the optional external telemetry sink. Stable usage and funnel events remain in the Worker Durable Object and are available from `/stats`.
- `GROUND_TRUTH_TELEMETRY_ENDPOINT=https://...`
  Optional external telemetry sink. It is only used when `GROUND_TRUTH_TELEMETRY=true`; the product does not depend on this endpoint.
- `GROUND_TRUTH_DEPLOYMENT_MODE=xpay_upstream`
  Used by the separate xpay deployment. Analytics also records the deployment inferred from the hostname (`main` or `xpay`).
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
- `http://localhost:8787/watch`
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

Preflight smoke test:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"preflight_endpoint","arguments":{"url":"https://example.com"}},"id":1}'
```

The preflight result includes `verdict`, `summary`, `evidence`, and `recommended_action`, while preserving the underlying endpoint and header fields.

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

Immediately confirm the MCP transport is healthy (this is the first thing an agent hits):

```bash
curl -s https://ground-truth-mcp.anishdasmail.workers.dev/health/mcp
```

Expect `{"ok":true,"verdict":"PASS",...}` with HTTP 200. A `FAIL` (HTTP 503) means the `initialize` handshake is broken — the `detail` field carries the real error. Point an external uptime check (or a Ground Truth monitor) at this URL so any future transport outage pages you instead of silently zeroing activation.

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
- `inspect_security_headers`
- `preflight_endpoint`
- 100 requests per calendar month
- No API key required

### Agentic pay-per-use

- `estimate_market`
- `check_pricing`
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

- Store any xpay credential as a Worker secret; do not place it in Wrangler vars or commit it
- Register the production `/mcp` URL with xpay if you want a managed pay-per-tool proxy for paid tools
- Use the production MCP URL: `https://ground-truth-mcp.anishdasmail.workers.dev/mcp`
- Recommended provider slug: `ground-truth`
- xpay can auto-discover tools from the live server or the server card at `https://ground-truth-mcp.anishdasmail.workers.dev/.well-known/mcp/server-card.json`
- Start with per-tool pricing that matches the Worker metadata:
  - `estimate_market` → `$0.01`
  - `check_pricing` → `$0.01`
  - `compare_competitors` → `$0.025`
  - `compare_pricing_pages` → `$0.035`
  - `verify_claim` → `$0.01`
  - `assess_compliance_posture` → `$0.06`
  - `test_hypothesis` → `$0.05`
- Publish the resulting proxy URL anywhere you want agentic usage without native x402 support
- For a dedicated xpay upstream, deploy the separate Worker with `npm run deploy:xpay`
- The xpay-specific upstream URL is `https://ground-truth-mcp-xpay.anishdasmail.workers.dev/mcp`
- Keep the direct hosted server for free preflight and team API-key access; use xpay for the proxy deployment
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
- Use the preflight copy: `No API key is required for the free preflight. Start by calling preflight_endpoint with url=https://example.com.`
- Recommended namespace/server slug: `anishdasmail / ground-truth`
- Point Smithery to `https://ground-truth-mcp.anishdasmail.workers.dev/mcp`
- The `/.well-known/mcp/server-card.json` route is available as metadata fallback
- If Smithery's scan is blocked by Cloudflare bot protection, allow `SmitheryBot/1.0` or rely on the static server card
- Use this preflight profile note: `No API key is required for the free preflight. Start by calling preflight_endpoint with url=https://example.com.`

### Profile copy snippets

Short description:

> Preflight first: call `preflight_endpoint` with `url=https://example.com` before an agent trusts the resource. No signup or API key is required for the free preflight.

Quickstart:

> Use Ground Truth's `preflight_endpoint` tool with `url` set to `https://example.com`. Return `verdict`, `summary`, `evidence`, and `recommended_action`.

Release note:

> Repositioned around preflighting unfamiliar APIs, URLs, and claims with PASS/WARN/FAIL evidence, clearer free-vs-paid usage, and rolling usage analytics.

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

## Analytics event taxonomy

The Worker records the following canonical events when the corresponding action occurs:

`homepage_view`, `pricing_view`, `mcp_connection`, `tool_call_started`, `tool_call_completed`, `tool_call_failed`, `payment_required`, `checkout_started`, `checkout_completed`, `subscription_activated`, and `paid_tool_call`.

Checkout starts are keyed to a generated checkout request ID and carried into Stripe metadata. Webhook and success-page completion events use that same key and are deduplicated. If a Stripe checkout originates outside this Worker, the webhook backfills a start event. `/stats` also normalizes the displayed start count to never be lower than completed checkouts and exposes the raw count and coverage ratio separately.

The event payload stores `ts`, hashed `clientHash`, optional `mcpClientId`, `tool`, `tier`, `status`, `paymentMethod`, `source`, `deployment`, and `serverVersion`; request payload contents are not stored. Usage events are queued with `waitUntil` to keep MCP latency unchanged, so a hard termination can lose an individual non-billing event. Stripe success-page and webhook delivery can arrive in either order, which is why the checkout key, deduplication, raw counts, and coverage ratio are retained.

## Maintenance Notes

- Keep public and internal copy centered on preflighting external resources before agent trust or action
- Introduce MCP after the preflight workflow, not before
- If pricing changes, update Stripe, `src/index.ts`, `README.md`, and `API_USAGE.md` together
- If agentic prices change, update `AGENTIC_TOOL_PRICES_USD`, the pricing page copy, and the server card together
- The current live Stripe dashboard label is `Ground Truth MCP`; rename it to `Ground Truth` only if you want tighter branding consistency
