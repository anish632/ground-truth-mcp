# Ground Truth

**Live fact-checking tools for AI agents. Start with one free tool call.**

Ground Truth gives AI agents read-only verification tools for live public data: free endpoint reachability checks, free security-header inspection, pricing-page scans, pricing-page comparisons, evidence-backed claim checks, package-market sizing, compliance scans, named package comparisons, and multi-step hypothesis tests.

You can use Ground Truth three ways:

- Free endpoint and security-header checks for lightweight verification
- Agentic pay-per-use with x402-compatible clients or an xpay proxy
- A team subscription with `X-API-Key` billing and predictable monthly usage

[![MCP](https://img.shields.io/badge/MCP-1.11.0-blue)](https://modelcontextprotocol.io)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com)
[![ground-truth-mcp MCP server](https://glama.ai/mcp/servers/anish632/ground-truth-mcp/badges/score.svg)](https://glama.ai/mcp/servers/anish632/ground-truth-mcp)

**Live:** https://ground-truth-mcp.anishdasmail.workers.dev

---

## 60-Second Quickstart

The fastest first success is the free `check_endpoint` tool. It does not need signup or an API key.

1. Add Ground Truth to an MCP client that supports remote Streamable HTTP:

```json
{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp"
    }
  }
}
```

2. Restart or refresh the MCP client so it loads the server.
3. Paste the prompt below.

## Try This First

Copy-paste this as your first prompt:

> Use Ground Truth to call the `check_endpoint` tool with `url` set to `https://api.github.com`. Return the URL, HTTP status, whether it was accessible, and response time.

Expected output shape:

```json
{
  "url": "https://api.github.com/",
  "accessible": true,
  "status": 200,
  "contentType": "application/json; charset=utf-8",
  "responseTimeMs": 120
}
```

`responseTimeMs` will vary. A first successful tool call means your MCP client is connected and Ground Truth is usable.

## Free First Tools

These tools work without signup or an API key:

- `check_endpoint`: verify that a public URL or API endpoint responds.
- `inspect_security_headers`: inspect HSTS, CSP, frame protections, and related browser-facing security headers.

If the agent answers from memory instead of calling a tool, ask it to call the tool by name.

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
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"check_endpoint","arguments":{"url":"https://api.github.com"}},"id":1}'
```

---

## What Ground Truth Verifies

Ground Truth helps agents check facts before they answer, recommend, or act.

| Verification | What it checks | Example |
|---|---|---|
| **Pricing claims** | Pulls live pricing from product pages | "Does Stripe have a free tier?" |
| **Pricing comparisons** | Compares multiple pricing pages side by side | "Which vendor shows a free trial right now?" |
| **Compliance posture** | Scans trust pages for enterprise signals | "Does this vendor mention SOC 2, GDPR, and SCIM?" |
| **Security posture** | Inspects browser-facing security headers | "Does this app expose HSTS and CSP?" |
| **Competitor existence** | Checks whether real alternatives show up in npm or PyPI | "Are there edge-first Prisma alternatives?" |
| **API endpoints** | Confirms a URL exists and responds | "Does this endpoint return 200?" |

All results come from live data and are cached for 5 minutes for faster repeat checks.

---

## Concrete Use Case: Grounded Source Lookup

Use Ground Truth when an agent needs to verify that a source or endpoint exists before it uses that source in an answer, support reply, or research note.

Example input:

```json
{
  "name": "check_endpoint",
  "arguments": {
    "url": "https://api.github.com"
  }
}
```

Example output shape:

```json
{
  "url": "https://api.github.com/",
  "accessible": true,
  "status": 200,
  "contentType": "application/json; charset=utf-8",
  "responseTimeMs": 120,
  "authRequired": false,
  "rateLimited": false,
  "sampleResponse": "{\"current_user_url\":\"https://api.github.com/user\"..."
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
- Best for autonomous agents or variable workloads
- Includes `estimate_market`, `check_pricing`, `compare_pricing_pages`, `compare_competitors`, `verify_claim`, `assess_compliance_posture`, and `test_hypothesis`

### Team

Team subscription uses API-key billing with predictable monthly usage.

- Requires `X-API-Key` with active billing
- Default quota of 5,000 requests per calendar month
- Monthly usage tracked per API key and tool
- Includes all paid verification tools

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
        "url": "https://api.github.com"
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
        url: "https://api.github.com",
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

> Give AI agents one free first check: call `check_endpoint` to verify a public URL responds, then use paid tools for pricing, compliance, claims, package-market, and competitor checks.

Try-first prompt:

> Use Ground Truth to call `check_endpoint` with `url` set to `https://api.github.com`. Return the URL, status, accessible boolean, and response time.

Setup note:

> No API key is required for `check_endpoint` or `inspect_security_headers`. Add `X-API-Key` only for team-plan paid tools, or use x402/xpay for pay-per-use paid calls.

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

_Last updated: May 19, 2026_
