# Ground Truth MCP Server

<a href="https://glama.ai/mcp/servers/@anish632/ground-truth-mcp"><img width="380" height="200" src="https://glama.ai/mcp/servers/@anish632/ground-truth-mcp/badge" alt="Ground Truth MCP server" /></a>

**Validate AI claims against live data.**

An MCP server that lets AI agents fact-check their own research in real time — probing endpoints, counting competitors, and testing hypotheses against live registries instead of guessing.

## Origin

This tool was born from an AI agent catching itself giving bad advice. During a research conversation about MCP business opportunities, the agent recommended building products based on claims like "competition is low" and "this API is freely available" — then built a prototype to test those claims and discovered several were wrong. Competitors it said didn't exist already had packages on npm. An API it recommended building on top of couldn't even be reached.

Ground Truth is the tool that conversation needed.

## Tools

### `check_endpoint`
Probe a URL or API endpoint. Returns HTTP status, content type, response time, auth requirements, rate limit headers, and a structural summary of the response.

```
"Is this API actually accessible, or am I recommending something that doesn't work?"
```

### `estimate_market`
Count packages/servers in a space on npm or PyPI. Returns total count, top results with version history and update dates, and activity signals.

```
"I'm about to say 'competition is low' — is that actually true?"
```

### `test_hypothesis`
Test a factual claim against multiple live checks. Returns pass/fail per test and an overall verdict: SUPPORTED, REFUTED, or PARTIALLY SUPPORTED.

```
"Before I present this conclusion, let me verify it."
```

## Connect

### MCP Inspector (quickest test)
```bash
npx @modelcontextprotocol/inspector@latest
# Enter: https://ground-truth-mcp.anishdasmail.workers.dev/mcp
```

### Claude Desktop
Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp"
    }
  }
}
```

### Any MCP Client
Connect to `https://ground-truth-mcp.anishdasmail.workers.dev/mcp` via Streamable HTTP transport.

## Develop

```bash
npm install
npm start          # local dev server at http://localhost:8787/mcp
npm run deploy     # deploy to Cloudflare Workers
```

## What It Caught (First Run)

| Claim | Verdict |
|-------|---------|
| "Memory MCP server competition is Medium" | ⚠️ Medium but actively growing — 12+ packages, several updated this week |
| "Email/SMS MCP servers: very low competition" | ❌ Wrong — `twilio-mcp` and `mcp-send-email` already exist |
| "Business verification MCP space is empty" | ✅ Confirmed — no relevant packages found |
| "OpenCorporates has a free API" | ❌ Could not verify — API unreachable |

## License

MIT
