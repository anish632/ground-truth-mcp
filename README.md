# Ground Truth MCP Server

A remote MCP server that lets AI agents validate their own claims against live data. Built on Cloudflare Workers with x402 micropayments on Base Sepolia.

## Tools

| Tool | Price | Description |
|------|-------|-------------|
| `check_endpoint` | Free | Probe a URL — returns status, auth flags, response time, content sample |
| `estimate_market` | $0.01 | Search npm or PyPI — returns total count + top results |
| `check_pricing` | $0.02 | Extract pricing signals from any URL — prices, plans, free tiers |
| `compare_competitors` | $0.03 | Side-by-side npm/PyPI package comparison |
| `verify_claim` | $0.05 | Cross-reference a claim against multiple URLs with keyword matching |
| `test_hypothesis` | $0.05 | Run a battery of live tests against a factual claim |

All paid tools use [x402](https://x402.org) for USDC micropayments on Base Sepolia. Results are cached for 5 minutes via Durable Object SQLite storage.

## Connect

### Remote (Streamable HTTP)

```json
{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp",
      "transport": "streamable-http"
    }
  }
}
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector@latest
# Connect to: https://ground-truth-mcp.anishdasmail.workers.dev/mcp
```

## Develop

```bash
npm install
npm run dev          # local server at http://localhost:8787/mcp
npm run type-check   # typecheck
npm run deploy       # deploy to Cloudflare
```

## What it catches

| Claim | Reality | Tool used |
|-------|---------|-----------|
| "There are only 2-3 MCP memory servers" | npm shows 50+ results for "mcp memory" | `estimate_market` |
| "This API returns JSON" | Actually returns XML with 403 | `check_endpoint` |
| "Library X is more popular than Y" | X has 12 versions, Y has 847 | `compare_competitors` |
| "Service X is free" | Pricing page shows $29/mo minimum | `check_pricing` |

## Architecture

- **Runtime:** Cloudflare Workers + Durable Objects
- **Protocol:** MCP over Streamable HTTP
- **Payments:** x402 USDC micropayments on Base Sepolia
- **Cache:** SQLite in Durable Object storage (5min TTL)
- **Registry:** Published to MCP Registry, MCP.so, Glama, PulseMCP
