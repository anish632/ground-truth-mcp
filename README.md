# Ground Truth

**Verification layer for AI agents.**

Ground Truth lets AI agents verify claims, inspect APIs, compare competitors, and validate assumptions against live data before acting.

Free tier includes limited monthly endpoint checks. Pro unlocks claim verification, market checks, competitor comparisons, and higher usage limits.

[![MCP](https://img.shields.io/badge/MCP-1.11.0-blue)](https://modelcontextprotocol.io)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com)

**Live:** https://ground-truth-mcp.anishdasmail.workers.dev

---

## What Ground Truth Verifies

Ground Truth helps agents check facts before they answer, recommend, or act.

| Verification | What it checks | Example |
|---|---|---|
| **Pricing claims** | Pulls live pricing from product pages | "Does Stripe have a free tier?" |
| **Competitor existence** | Checks whether real alternatives show up in npm or PyPI | "Are there edge-first Prisma alternatives?" |
| **API endpoints** | Confirms a URL exists and responds | "Does this endpoint return 200?" |
| **Package popularity** | Compares package metadata side by side | "How do React and Vue compare right now?" |
| **Market assumptions** | Tests a hypothesis against live counts or responses | "Is this category still small?" |
| **Support and policy claims** | Checks public pages for language that supports or contradicts a claim | "Does this support policy actually apply?" |

All results come from live data and are cached for 5 minutes for faster repeat checks.

---

## Why AI Agents Need Verification

Training data goes stale. Docs change. Pricing changes. Competitors appear. Endpoints break. Policies move.

Ground Truth gives agents a way to check before they commit:

- Before quoting a price, pull the live pricing page
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

## Free vs Pro

### Free

Free tier includes limited monthly endpoint checks.

- Only `check_endpoint`
- 100 requests per calendar month
- Tracked by Cloudflare client IP in production, or `X-Anonymous-Client-Id` for local/dev testing
- No signup or API key required

### Pro

Pro unlocks claim verification, market checks, competitor comparisons, and higher usage limits.

- Requires `X-API-Key` with active billing
- Default quota of 5,000 requests per calendar month
- Monthly usage tracked per API key and tool
- Includes `check_pricing`, `verify_claim`, `estimate_market`, `compare_competitors`, and `test_hypothesis`

[View pricing](https://ground-truth-mcp.anishdasmail.workers.dev/pricing)

---

## API Examples

### Direct API with `curl`

Direct HTTP calls to `/mcp` are session-based. Initialize once, keep the returned `mcp-session-id`, then call tools with that header.

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
  -H "X-API-Key: $GROUND_TRUTH_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "check_pricing",
      "arguments": {
        "url": "https://stripe.com/pricing"
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
    "X-API-Key": process.env.GROUND_TRUTH_API_KEY,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "compare_competitors",
      arguments: {
        packages: ["react", "vue"],
        registry: "npm",
      },
    },
    id: 1,
  }),
});

const result = await response.json();
console.log(result);
```

### Free endpoint check

```bash
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

Lightweight request checks for free access, blocked Pro calls, invalid keys, inactive billing, quota enforcement, and active Pro access live in [test-usage-enforcement.sh](./test-usage-enforcement.sh).

---

## MCP Setup

If you use Claude Desktop, Cursor, or another MCP client, Ground Truth can plug in as a verification tool for your agent.

MCP stands for [Model Context Protocol](https://modelcontextprotocol.io). It is the standard that lets AI apps call external tools.

### Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

### Cursor

Add this to `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally:

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

### Product

- Test whether a market assumption is true before writing a spec
- Check whether a competitor exists before framing a roadmap
- Compare package popularity before making a platform choice

### Legal

- Confirm whether a support policy applies on a live public page
- Verify pricing or packaging claims before repeating them internally
- Check that a public terms or policy URL is reachable and current

### Market research

- Compare competitor pricing across live pages
- Count category competitors before entering a space
- Validate positioning claims with structured checks

---

## Tool Reference

| Tool | Tier | What it does |
|---|---|---|
| `check_endpoint` | Free | Checks whether a URL or API endpoint exists and responds |
| `estimate_market` | Pro | Counts packages in npm or PyPI for a search term |
| `check_pricing` | Pro | Extracts prices, plans, and free-tier signals from a page |
| `compare_competitors` | Pro | Compares packages side by side with live metadata |
| `verify_claim` | Pro | Checks whether live sources support or contradict a claim |
| `test_hypothesis` | Pro | Runs pass/fail tests against a live-data assumption |

Full reference: [API_USAGE.md](./API_USAGE.md)

---

## Architecture

Ground Truth keeps the current Cloudflare Workers architecture:

- Runtime: Cloudflare Workers
- Storage: Durable Objects with SQLite for cache and usage logs
- API keys: Cloudflare KV
- Billing: Stripe Checkout and subscriptions
- Protocol: MCP
- Language: TypeScript

---

## Development

```bash
cd ground-truth-mcp
npm install
npx wrangler dev
```

Deployment notes live in [SETUP.md](./SETUP.md).

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

---

## Documentation

- [API_USAGE.md](./API_USAGE.md) for API calls and tool arguments
- [SETUP.md](./SETUP.md) for deployment and billing setup
- [claude-skill/](./claude-skill/) for the zero-deployment Claude Code version

---

## Support

- Email: anishdasmail@gmail.com
- Issues: https://github.com/anish632/ground-truth-mcp/issues

---

## License

MIT — see [LICENSE](./LICENSE)

---

**Made by [Anish Das](https://github.com/anish632)**

_Last updated: April 29, 2026_
