# Ground Truth

**First tool call for AI agents: check a live endpoint in 60 seconds. No signup. No API key.**

Ground Truth gives AI agents read-only verification against live public data. The first action is one free tool call: `check_endpoint` with `url=https://example.com`.

The paid product is persistent evidence, not a one-off lookup. After the first call works, teams pay for saved monitors, scheduled checks, change history, reports, webhooks/notifications, and API-key access that prevents agents from repeating stale pricing, claim, endpoint, package, or compliance facts.

Do not start with pricing, compliance, claims, package-market, competitor, monitor, API-key, or payment examples. First prove the MCP connection works by calling `check_endpoint`.

[![MCP](https://img.shields.io/badge/MCP-1.11.0-blue)](https://modelcontextprotocol.io)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com)
[![ground-truth-mcp MCP server](https://glama.ai/mcp/servers/anish632/ground-truth-mcp/badges/score.svg)](https://glama.ai/mcp/servers/anish632/ground-truth-mcp)

**Live:** https://ground-truth-mcp.anishdasmail.workers.dev

---

## Glama Quickstart: One Copy-Paste Path

Use this exact path from Glama or any MCP client that supports remote Streamable HTTP.

### 1. Add the remote server

```json
{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp"
    }
  }
}
```

No `X-API-Key` is needed for this first call.

### 2. Paste this prompt

> Use Ground Truth's `check_endpoint` tool with `url` set to `https://example.com`. Do not answer from memory. Call the tool and return exactly: `url`, `accessible`, `status`, `contentType`, and `responseTimeMs`.

### 3. Confirm the tool result

```json
{
  "url": "https://example.com/",
  "accessible": true,
  "status": 200,
  "contentType": "text/html",
  "responseTimeMs": 120
}
```

`responseTimeMs` will vary. Seeing this shape means the first Ground Truth MCP tool call worked.

### If the agent answers without a tool call

Reply with:

> Call the MCP tool named `check_endpoint` now. Use `url=https://example.com`.

## Free First Tools

After the first `check_endpoint` call works, these free tools work without signup or an API key:

- `check_endpoint`: verify that a public URL or API endpoint responds.
- `inspect_security_headers`: inspect HSTS, CSP, frame protections, and related browser-facing security headers.

## Activation Measurement

Portfolio baseline before this quickstart rewrite (30-day Glama signal): **1,075 profile views -> 0 tool calls**.

| Metric | Definition | Target by 2026-05-27 |
|---|---|---|
| Profile views | Glama/Smithery/MCP Market listing views (30d) | Hold or grow only after activation works |
| First successful tool call | MCP `tools/call` for `check_endpoint` with HTTP 200 and structured result | **>=1% of new profile views** in the 7 days after rewrite ships |
| Time to first call | Install/connect → first free tool result | **< 60 seconds** for a cold user following this README |

**How to measure**

1. **Server-side:** Durable Object `usage_log` / KV monthly counters for `check_endpoint` and `inspect_security_headers` (production Worker). Compare week-over-week tool-call counts, not impressions alone.
2. **Optional telemetry:** Set `GROUND_TRUTH_TELEMETRY=true` on the Worker to emit `first_successful_tool_call` events to your analytics endpoint.
3. **Decision rule:** If profile views continue but free tool calls stay at **0**, keep the marketplace profile focused on only the [Glama Quickstart](#glama-quickstart-one-copy-paste-path) prompt. Do not buy more impressions or lead with paid-tool examples.

**Success event (log or dashboard):**

```json
{
  "event": "first_successful_tool_call",
  "tool": "check_endpoint",
  "arguments": { "url": "https://example.com" }
}
```

---

## Health Check

Check that the hosted server card is reachable:

```bash
curl -I https://ground-truth-mcp.anishdasmail.workers.dev/.well-known/mcp/server-card.json
```

Smoke-test the free tool over MCP HTTP:

```bash
SESSION_ID="$(curl -i -s -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ground-truth-quickstart","version":"1.0.0"}},"id":0}' | tr -d '\r' | awk '/^mcp-session-id:/ {print $2}')"

curl -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"check_endpoint","arguments":{"url":"https://example.com"}},"id":1}'
```

---

## What Ground Truth Verifies (after the first call)

| Verification | Tool | Tier |
|---|---|---|
| **API endpoints** | `check_endpoint` | Free |
| **Security posture** | `inspect_security_headers` | Free |

Paid tools (pricing, compliance, claims, package-market, competitor checks, and monitors) are documented in [Example Workflows](#example-workflows) and [Tool Reference](#tool-reference). Use them only after a successful free first call.

## Paid Positioning: Monitored Evidence

Do not sell Ground Truth as "an agent can check a page once." Browser agents and search tools can often approximate that.

Sell Ground Truth as:

> Monitored evidence and change alerts for agent claims.

Paid value lives in durable workflows:

- Saved monitors for URLs, endpoints, pricing pages, packages, vendor claims, and custom prompts
- Scheduled hourly, daily, or weekly checks
- Stored before/after values and confidence
- Change reports for teams
- API-key access with predictable usage
- Future: Slack, email, webhook, or issue-tracker alerts

The revenue metric to watch is:

`first_successful_tool_call -> create_monitor -> run_monitor_now -> generate_change_report -> paid team key`

---

## Concrete Use Case: Grounded Source Lookup

Use Ground Truth when an agent needs to verify that a source or endpoint exists before it uses that source in an answer, support reply, or research note.

Example input:

```json
{
  "name": "check_endpoint",
  "arguments": {
    "url": "https://example.com"
  }
}
```

Example output shape:

```json
{
  "url": "https://example.com/",
  "accessible": true,
  "status": 200,
  "contentType": "text/html",
  "responseTimeMs": 120,
  "authRequired": false,
  "rateLimited": false,
  "sampleResponse": "<!doctype html><html..."
}
```

This gives the agent source-backed context that the URL was reachable at call time and enough response detail to decide whether to use the source, retry, or ask for a different URL.

---

## Complementary MCP Servers

Ground Truth is strongest when paired with a broader discovery or browser tool:

- [Tavily MCP Server](https://glama.ai/mcp/servers/%40tavily-ai/tavily-mcp) for real-time web search and content discovery before you run a claim or pricing check.
- [Firecrawl MCP Server](https://glama.ai/mcp/servers/%40ampcome-mcps/firecrawl-mcp) for deeper crawling and JS-heavy page extraction when raw HTML heuristics are not enough.
- [mcp-server-browserbase](https://glama.ai/mcp/servers/%40browserbase/mcp-server-browserbase) for interactive browser verification on pages that need clicks, auth, or client-side rendering.

These are complementary to Ground Truth rather than substitutes: they help you find or render the page, while Ground Truth helps you verify the resulting claim.

---

## Why AI Agents Need Verification

Training data goes stale. Docs change. Pricing changes. Competitors appear. Endpoints break. Policies move.

Ground Truth gives agents a way to check before they commit:

- Before quoting a price, pull the live pricing page
- Before comparing vendors, scan their live pricing pages side by side
- Before repeating a compliance claim, scan the live trust page
- Before asserting a security baseline, inspect the response headers
- Before saying a competitor does not exist, search the live registry
- Before recommending an API, confirm the endpoint responds
- Before calling one package more popular, compare real package metadata
- Before repeating a policy, verify the language on the current public page

The result is simple: agents that are less confident for the wrong reasons and more reliable when it matters.

---

## Example Workflows

> **Start with the Glama Quickstart above.** The workflows below use paid tools or secondary free tools. Skip them until `check_endpoint` works in your MCP client.

### Verify a pricing claim
> "Notion costs $8 per user per month for teams."

Use `check_pricing` on the live pricing page before repeating the number.

### Check whether a competitor exists
> "There is no good edge ORM alternative to Prisma."

Use `estimate_market` to search npm for `edge orm` and see what already exists.

### Compare vendor pricing pages
> "Vendor A is cheaper than Vendor B."

Use `compare_pricing_pages` to compare live pricing pages before repeating the claim.

### Scan a trust page
> "This vendor supports SOC 2, GDPR, and SCIM."

Use `assess_compliance_posture` before treating that as current fact.

### Inspect browser-facing security headers
> "This app has a strong public security baseline."

Use `inspect_security_headers` before making the claim.

### Validate an API endpoint
> "Use the OpenAI `/v1/models` endpoint to list available models."

Use `check_endpoint` before recommending it in docs, code, or support replies.

### Compare package popularity
> "Vue has overtaken React."

Use `compare_competitors` to compare live package metadata instead of guessing.

### Test a market assumption
> "There are fewer than 50 MCP tools on npm."

Use `test_hypothesis` with a count-based check and return the actual result.

### Confirm whether a support policy applies
> "AWS Business support includes 24/7 phone support."

Use `verify_claim` against the current AWS support page before treating that as fact.

---

## Access Modes

### Free

Free tier includes limited monthly endpoint and security-header checks.

- `check_endpoint`
- `inspect_security_headers`
- 100 requests per calendar month
- Tracked by Cloudflare client IP in production, or `X-Anonymous-Client-Id` for local/dev testing
- No signup or API key required

### Agentic pay-per-use

Paid tools also support agentic pay-per-use.

- Use an x402-compatible MCP client, or put an [xpay MCP proxy](https://docs.xpay.sh/en/products/mcp-monetization) in front of this server
- Tool pricing starts at `$0.01` per call and varies by tool
- Best for autonomous agents or variable workloads that are not ready for saved monitors
- Includes `estimate_market`, `check_pricing`, `compare_pricing_pages`, `compare_competitors`, `verify_claim`, `assess_compliance_posture`, and `test_hypothesis`

### Team

Team subscription uses API-key billing with predictable monthly usage and monitor history.

- Requires `X-API-Key` with active billing
- Default quota of 5,000 requests per calendar month
- Monthly usage tracked per API key and tool
- Includes all paid verification tools
- Includes monitor management: `create_monitor`, `list_monitors`, `run_monitor_now`, `get_monitor_result`, `delete_monitor`, and `generate_change_report`

Suggested paid packaging:

| Plan | Price | Best for | Paid promise |
|---|---:|---|---|
| Free | $0 | Connection proof | First endpoint/security checks |
| Monitor Starter | $9/mo | Individual agent builders | 10 saved monitors, weekly checks, evidence history |
| Team | $29/mo | Shared internal agents | Daily checks, reports, higher request quota |
| Business | $99/mo | Revenue/support/compliance workflows | Webhooks, alert routing, higher monitor volume |

[View pricing](https://ground-truth-mcp.anishdasmail.workers.dev/pricing)

---

## API Examples

### Direct API with `curl`

Direct HTTP calls to `/mcp` are session-based. Initialize once, keep the returned `mcp-session-id`, then call tools with that header.

This example calls the free `check_endpoint` tool with no API key.

```bash
SESSION_ID="$(curl -i -s -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {
        "name": "ground-truth-example",
        "version": "1.0.0"
      }
    },
    "id": 0
  }' | tr -d '\r' | awk '/^mcp-session-id:/ {print $2}')"

curl -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "check_endpoint",
      "arguments": {
        "url": "https://example.com"
      }
    },
    "id": 1
  }'
```

### JavaScript `fetch`

```javascript
const initResponse = await fetch("https://ground-truth-mcp.anishdasmail.workers.dev/mcp", {
  method: "POST",
  headers: {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "ground-truth-example",
        version: "1.0.0",
      },
    },
    id: 0,
  }),
});

const sessionId = initResponse.headers.get("mcp-session-id");

if (!sessionId) {
  throw new Error("Missing mcp-session-id from initialize response");
}

const response = await fetch("https://ground-truth-mcp.anishdasmail.workers.dev/mcp", {
  method: "POST",
  headers: {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Mcp-Session-Id": sessionId,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "check_endpoint",
      arguments: {
        url: "https://example.com",
      },
    },
    id: 1,
  }),
});

const result = await response.json();
console.log(result);
```

Lightweight request checks for free access, team-plan billing, invalid keys, inactive billing, quota enforcement, and active paid access live in [test-usage-enforcement.sh](./test-usage-enforcement.sh).

---

## MCP Setup

If you use Claude Desktop, Cursor, or another MCP client, Ground Truth can plug in as a verification tool for your agent.

MCP stands for [Model Context Protocol](https://modelcontextprotocol.io). It is the standard that lets AI apps call external tools.

If you want agentic pay-per-use without changing your app code, register this MCP URL with xpay and share the resulting proxy URL instead.

### Claude Desktop

For the free first call, add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp"
    }
  }
}
```

### Cursor

For the free first call, add this to `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp"
    }
  }
}
```

### Optional Team API Key

Only add `X-API-Key` when you are using paid tools through the team plan:

```json
{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp",
      "headers": {
        "X-API-Key": "gt_live_your_key_here"
      }
    }
  }
}
```

### Claude Code skill

If you want the same workflow without running a server, see [claude-skill/](./claude-skill/).

---

## Use Cases

### Support

- Verify a pricing claim before sending it to a customer
- Check whether a support policy applies before escalating
- Confirm an API endpoint exists before recommending it in a reply
- Inspect public security headers before repeating a security claim

### Product

- Test whether a market assumption is true before writing a spec
- Check whether a competitor exists before framing a roadmap
- Compare package popularity before making a platform choice
- Compare pricing pages before telling a team one vendor is cheaper

### Compliance

- Scan trust pages for SOC 2, GDPR, HIPAA, DPA, SSO, and SCIM signals
- Verify pricing or packaging claims before repeating them internally
- Check that a public terms or policy URL is reachable and current

### Security & vendor diligence

- Compare competitor pricing across live pages
- Inspect browser-facing security headers before recommending or approving a vendor
- Validate positioning claims with structured checks

---

## Tool Reference

| Tool | Tier | What it does |
|---|---|---|
| `check_endpoint` | Free | Checks whether a URL or API endpoint exists and responds |
| `estimate_market` | Paid | Counts packages in npm or PyPI for a search term |
| `check_pricing` | Paid | Extracts prices, plans, and free-tier signals from a page |
| `inspect_security_headers` | Free | Checks common browser-facing security headers on a public URL |
| `compare_pricing_pages` | Paid | Compares multiple live pricing pages side by side |
| `compare_competitors` | Paid | Compares packages side by side with live metadata |
| `verify_claim` | Paid | Checks whether live sources support or contradict a claim |
| `assess_compliance_posture` | Paid | Scans a trust page for compliance and enterprise-security signals |
| `test_hypothesis` | Paid | Runs pass/fail tests against a live-data assumption |

Full reference: [API_USAGE.md](./API_USAGE.md)

---

## Troubleshooting

### Server not connecting

- Confirm your MCP client supports remote Streamable HTTP servers.
- Confirm the URL is exactly `https://ground-truth-mcp.anishdasmail.workers.dev/mcp`.
- Restart or refresh the MCP client after editing its config.
- Run the server-card health check: `curl -I https://ground-truth-mcp.anishdasmail.workers.dev/.well-known/mcp/server-card.json`.

### No tool calls appearing

- Use the copy-paste prompt above and name the tool: `check_endpoint`.
- Make sure the client has Ground Truth enabled in its tool list.
- Start with a free tool. Do not add `X-API-Key` unless you are testing paid team access.
- If the model answers from memory, ask it to call `check_endpoint` explicitly.

### Missing environment variables

- Hosted free checks do not need environment variables or an API key.
- Local deployments need the `API_KEYS` KV binding for quota tracking.
- Team billing needs `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
- x402 pay-per-use can use defaults for testnet, but production payments should set `GROUND_TRUTH_X402_NETWORK` and `GROUND_TRUTH_X402_RECIPIENT`.

### Unsupported MCP client

- Use the direct MCP HTTP curl example above to confirm the server works.
- Use a client with remote Streamable HTTP support for the hosted server.
- If a directory requires stdio, use the included Glama bridge command: `npm run start:glama:stdio`.
- For agentic paid tools in clients without native x402 support, put an xpay proxy in front of the live `/mcp` URL.

---

## Architecture

Ground Truth keeps the current Cloudflare Workers architecture:

- Runtime: Cloudflare Workers
- Storage: Durable Objects with SQLite for cache and usage logs
- API keys: Cloudflare KV
- Billing: Stripe team subscriptions plus x402-compatible pay-per-use
- Protocol: MCP
- Language: TypeScript

---

## Distribution

Ground Truth is set up for multiple discovery and monetization paths:

- Official MCP Registry publishing through `server.json` for ecosystem-wide discovery.
- Smithery publishing. `smithery.yaml` defines the HTTP config schema (optional `X-API-Key`) for Smithery's Install button and release flow. Use Smithery's **Publish** button in the dashboard to create a new release after deploying.
- xpay MCP monetization. You can register the live `/mcp` URL with xpay to get a managed pay-per-tool proxy without changing the server code.
- MCP Market directory listing for additional discovery.
- Apify is optional if you want a separate marketplace-native Actor version later; the current project stays optimized for remote MCP delivery rather than an Actor-first runtime.

### Marketplace Profile Copy

Use these snippets when updating Glama, Smithery, MCP Market, or xpay profile fields.

Short description:

> First tool call for AI agents: call `check_endpoint` with `url=https://example.com` to verify Ground Truth is connected. No signup or API key for the first endpoint check.

Try-first prompt:

> Use Ground Truth's `check_endpoint` tool with `url` set to `https://example.com`. Do not answer from memory. Call the tool and return exactly: `url`, `accessible`, `status`, `contentType`, and `responseTimeMs`.

Setup note:

> No API key is required for the first `check_endpoint` call. Add `X-API-Key` only after that works and only for team-plan paid tools.

---

## Development

```bash
cd ground-truth-mcp
npm install
npx wrangler dev
```

Deployment notes live in [SETUP.md](./SETUP.md).

---

## GitHub Releases

Stable GitHub releases are created automatically when you push a version tag that matches `v*`.

```bash
git tag v0.4.0
git push origin v0.4.0
```

That tag triggers [`.github/workflows/release.yml`](./.github/workflows/release.yml), which typechecks the project and publishes a GitHub release from the tag. This is the repo-side piece Glama uses to detect stable releases during maintenance scans.

---

## Glama Release

Glama releases are Docker-based, not GitHub releases. This repo includes a `Dockerfile` that starts the Worker locally through Wrangler on port `3000`.

```bash
docker build -t ground-truth-mcp .
docker run --rm -p 3000:3000 ground-truth-mcp
```

For the Glama flow:

1. Claim the server in Glama.
2. Open the Dockerfile admin page, use this repository `Dockerfile`, and run the deploy test.
3. After the deploy test succeeds, click **Make Release**, choose a version, and publish.
4. If the score page still shows `No LICENSE`, trigger a re-scan in the Glama admin interface after GitHub has recognized the root `LICENSE` file.
5. If the score page still shows `No related servers`, use **Add related servers** in the claimed Glama UI and add `Tavily MCP Server`, `Firecrawl MCP Server`, and `mcp-server-browserbase`. That checklist item is managed on Glama's side rather than in `glama.json`.

If Glama generates an `mcp-proxy`-based build spec instead of using the repository `Dockerfile`, point the command at `npm run start:glama:stdio`. That bridge exposes the existing remote Ground Truth MCP endpoint over stdio so `mcp-proxy` can host it.

---

## Scheduled Monitoring

Ground Truth can **continuously monitor** URLs, pricing pages, package versions, endpoint statuses, vendor claims, and custom keyword patterns — and alert you when anything changes.

Monitors are stored in the Durable Object SQLite database, scoped to your team API key. A Cloudflare cron trigger runs hourly and verifies all due monitors automatically.

### Monitor target types

| `target_type` | What it checks | `target_value` format | `instructions` |
|---|---|---|---|
| `url` / `endpoint` | HTTP status, accessibility | `https://…` | — |
| `pricing_page` | Prices found, plans, free tier | `https://…/pricing` | — |
| `package` | Latest version on npm or PyPI | `npm:pkg-name` or `pypi:pkg-name` | — |
| `vendor_claim` | Whether claim text appears at a URL | The claim text | The URL to check |
| `custom_prompt` | Comma-separated keyword presence | `https://…` | `kw1,kw2,kw3` |

### Monitor tool reference

All monitor tools require a **team API key** (`X-API-Key` header). They count against your monthly quota.

---

#### `create_monitor`

Create a new monitor.

```json
{
  "name": "Stripe pricing",
  "target_type": "pricing_page",
  "target_value": "https://stripe.com/pricing",
  "schedule": "daily"
}
```

| Argument | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Human-readable label |
| `target_type` | enum | yes | See table above |
| `target_value` | string | yes | URL or package identifier |
| `instructions` | string | no | Evidence URL (vendor_claim) or keyword list (custom_prompt) |
| `schedule` | `manual`/`hourly`/`daily`/`weekly` | no | Default: `daily` |
| `notification_destination` | string | no | Email or webhook URL (stored, not yet dispatched) |

**Returns:** `{ id, name, target_type, target_value, schedule, created_at }`

---

#### `list_monitors`

List monitors owned by this API key.

```json
{ "active_only": true }
```

**Returns:** `{ monitors: [...], total }`

---

#### `run_monitor_now`

Immediately execute a monitor's check outside its normal schedule.

```json
{ "monitor_id": "mon_abc123" }
```

**Returns:** `{ monitor_id, result_id, status, changed, old_value, new_value, confidence, evidence, run_at }`

`status` is one of `changed`, `unchanged`, or `error`.

---

#### `get_monitor_result`

Retrieve recent run history for a monitor.

```json
{ "monitor_id": "mon_abc123", "limit": 10 }
```

**Returns:** `{ monitor_id, results: [...], total }`

Each result includes `status`, `changed`, `old_value`, `new_value`, `confidence`, `evidence`, and `run_at`.

---

#### `delete_monitor`

Permanently delete a monitor and all its stored results.

```json
{ "monitor_id": "mon_abc123" }
```

**Returns:** `{ monitor_id, deleted, results_deleted }`

---

#### `generate_change_report`

Generate a summary of monitor activity for the past day or week.

```json
{ "period": "daily" }
```

| Argument | Type | Description |
|---|---|---|
| `period` | `daily`/`weekly` | Time window — past 24h or 7d |
| `include_unchanged` | boolean | Also list stable monitors (default false) |

**Returns:**

```json
{
  "period": "daily",
  "from": "2026-05-25T00:00:00.000Z",
  "to":   "2026-05-26T00:00:00.000Z",
  "summary": {
    "monitors_run": 3,
    "changes_detected": 1,
    "failed_checks": 0,
    "unchanged": 2
  },
  "changes": [
    {
      "monitor_id": "mon_abc123",
      "monitor_name": "Stripe pricing",
      "target_type": "pricing_page",
      "target_value": "https://stripe.com/pricing",
      "run_at": "2026-05-25T14:00:00.000Z",
      "old_value": "{\"pricesFound\":[\"$2.9%\"]}",
      "new_value": "{\"pricesFound\":[\"$2.7%\"]}",
      "confidence": 0.95,
      "risk_level": "high"
    }
  ],
  "failures": [],
  "recommended_actions": [
    "Review high-risk pricing and claim changes before communicating to stakeholders."
  ]
}
```

---

### Example agent prompts for monitoring

**Create a daily pricing monitor:**
> Use Ground Truth `create_monitor` with name "Stripe pricing", target_type "pricing_page", target_value "https://stripe.com/pricing", and schedule "daily".

**Run it immediately and check for changes:**
> Use Ground Truth `run_monitor_now` with the monitor_id from the previous step. Report whether anything changed and what the new prices are.

**Get a weekly change report:**
> Use Ground Truth `generate_change_report` with period "weekly". Summarize any high-risk changes and the recommended actions.

**Track a package version:**
> Use Ground Truth `create_monitor` with name "Zod version watch", target_type "package", target_value "npm:zod", and schedule "daily". Then call `run_monitor_now` to record the baseline version.

**Monitor a vendor compliance claim:**
> Use Ground Truth `create_monitor` with name "Acme SOC2 claim", target_type "vendor_claim", target_value "SOC 2 Type II", instructions "https://acme.example.com/security", and schedule "weekly".

---

### Scheduled execution (cron)

The cron trigger is configured in `wrangler.jsonc` to fire **every hour**. On each tick it queries all active non-manual monitors, finds those past their interval (hourly/daily/weekly), runs the check, and records the result. No extra setup is needed after deployment.

To run due monitors on demand (admin/CI use):

```bash
# Trigger the scheduled run via the internal DO route
curl -X POST https://ground-truth-mcp.anishdasmail.workers.dev/internal/run-due-monitors
```

This route is proxied by the Worker to the Durable Object's `handleRunDueMonitors()` method.

### Local development

Run the smoke tests against a local `wrangler dev` instance:

```bash
# Start the local server
npm run start

# In another terminal — basic auth tests (no API key needed)
./test-monitors.sh

# Full test suite with a valid API key
GROUND_TRUTH_API_KEY=gt_live_your_key ./test-monitors.sh
```

---

## Documentation

- [API_USAGE.md](./API_USAGE.md) for API calls and tool arguments
- [SETUP.md](./SETUP.md) for deployment and billing setup
- [claude-skill/](./claude-skill/) for the zero-deployment Claude Code version

---

## Support

- Email: anishdasmail@gmail.com
- Website: https://ground-truth-mcp.anishdasmail.workers.dev/

---

## License

MIT — see [LICENSE](./LICENSE)

---

**Made by [Anish Das](https://github.com/anish632)**

_Last updated: May 26, 2026 - Glama first-call activation rewrite_
