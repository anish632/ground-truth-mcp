# Ground Truth API Guide

**Stop your AI from being wrong.**

Ground Truth gives AI agents a verification layer they can call before answering, recommending, or taking action.

This guide covers what Ground Truth verifies, how Free and Pro differ, direct API examples, MCP setup, and every available tool.

---

## What Ground Truth Verifies

Ground Truth helps agents verify:

- Pricing claims
- Competitor existence
- API endpoints
- Package comparisons
- Market assumptions
- Support and policy claims

If the answer depends on live data, Ground Truth is designed to check it first.

---

## Free vs Pro

### Free

Best for basic endpoint checks and limited verification needs.

- Only `check_endpoint`
- 100 requests per calendar month
- Tracked by Cloudflare client IP in production, or `X-Anonymous-Client-Id` for local/dev testing
- No API key required for the free endpoint check

### Pro

Unlocks the full verification layer for agents that need broader coverage.

- Requires `X-API-Key`
- Billing must be active
- Default quota of 5,000 requests per calendar month
- Monthly usage tracked per API key and tool
- Competitor comparison
- Claim verification
- Market checks
- Structured reports
- Priority response

To use Pro, subscribe at [ground-truth-mcp.anishdasmail.workers.dev/pricing](https://ground-truth-mcp.anishdasmail.workers.dev/pricing) and send your key in `X-API-Key`.

---

## API Examples

### Direct API with `curl`

Verify a pricing claim:

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

Compare package popularity:

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

Validate an API endpoint with no API key:

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

---

## Limits and Access Rules

- Free access only applies to `check_endpoint`
- Free access is limited to 100 requests per calendar month
- Free usage is tracked by Cloudflare client IP in production, or `X-Anonymous-Client-Id` for local/dev testing
- Free requests over the monthly limit return `429`
- Pro tool calls require `X-API-Key`
- Missing or invalid Pro keys return `401`
- Inactive billing returns `402`
- Pro usage over the monthly limit returns `429`
- The default Pro monthly quota is 5,000 tool requests per API key

For local testing, `X-Anonymous-Client-Id` is the easiest way to simulate separate anonymous clients.

---

## MCP Setup

Ground Truth can also be used through MCP clients like Claude Desktop and Cursor.

MCP means [Model Context Protocol](https://modelcontextprotocol.io), the standard many AI apps use to call external tools.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Add to `.cursor/mcp.json` or `~/.cursor/mcp.json`:

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

---

## Example Workflows

### Verify a pricing claim

```json
{
  "name": "check_pricing",
  "arguments": {
    "url": "https://notion.so/pricing"
  }
}
```

### Check whether a competitor exists

```json
{
  "name": "estimate_market",
  "arguments": {
    "query": "edge orm",
    "registry": "npm"
  }
}
```

### Validate an API endpoint

```json
{
  "name": "check_endpoint",
  "arguments": {
    "url": "https://api.openai.com/v1/models"
  }
}
```

### Compare package popularity

```json
{
  "name": "compare_competitors",
  "arguments": {
    "packages": ["react", "vue"],
    "registry": "npm"
  }
}
```

### Test a market assumption

```json
{
  "name": "test_hypothesis",
  "arguments": {
    "hypothesis": "There are fewer than 50 MCP tools on npm",
    "tests": [
      {
        "description": "Count MCP-related npm packages",
        "type": "npm_count_below",
        "query": "mcp server",
        "threshold": 50
      }
    ]
  }
}
```

### Confirm whether a support policy applies

```json
{
  "name": "verify_claim",
  "arguments": {
    "claim": "AWS Business support includes 24/7 phone support",
    "evidence_urls": ["https://aws.amazon.com/premiumsupport/plans/"],
    "keywords": ["24/7", "phone", "business", "support"]
  }
}
```

---

## Tool Reference

### `check_endpoint` (Free)

Checks whether a URL or API endpoint exists and responds.

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | The URL to probe |

Returns status, response time, content type, auth signal, rate-limit signal, and a sample response body.

---

### `estimate_market` (Pro)

Checks whether competitors or alternatives exist by searching npm or PyPI.

| Field | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search query such as `edge orm` |
| `registry` | `npm` or `pypi` | No | Defaults to `npm` |

Returns total result count plus top matches with version and description data.

---

### `check_pricing` (Pro)

Extracts prices and plan signals from a live pricing page.

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | The pricing page URL |

Returns prices found, plan names, free-option signals, free-trial signals, and cache status.

---

### `compare_competitors` (Pro)

Compares 2 to 10 packages side by side.

| Field | Type | Required | Description |
|---|---|---|---|
| `packages` | string[] | Yes | Package names to compare |
| `registry` | `npm` or `pypi` | No | Defaults to `npm` |

Returns version, description, license, publish dates, keywords, and found/not-found status.

---

### `verify_claim` (Pro)

Checks whether live sources support or contradict a claim.

| Field | Type | Required | Description |
|---|---|---|---|
| `claim` | string | Yes | The claim you want to verify |
| `evidence_urls` | string[] | Yes | One to ten URLs to check |
| `keywords` | string[] | Yes | Signals expected on supporting pages |

Returns per-source support data plus an overall verdict.

---

### `test_hypothesis` (Pro)

Runs structured pass/fail checks against a market or product assumption.

| Field | Type | Required | Description |
|---|---|---|---|
| `hypothesis` | string | Yes | The assumption to test |
| `tests` | array | Yes | The tests to run |

Supported test types:

| Type | Fields | Meaning |
|---|---|---|
| `endpoint_exists` | `url` | Passes if the URL returns 2xx |
| `npm_count_above` | `query`, `threshold` | Passes if npm results are above the threshold |
| `npm_count_below` | `query`, `threshold` | Passes if npm results are below the threshold |
| `response_contains` | `url`, `substring` | Passes if the page response contains the substring |

---

## Authentication

Pro requests use the `X-API-Key` header.

Example:

```bash
-H "X-API-Key: gt_live_your_key_here"
```

API keys start with `gt_live_`.

By default, an active Pro key can make 5,000 tool requests per calendar month.

---

## Enforcement Checks

Use [test-usage-enforcement.sh](./test-usage-enforcement.sh) for lightweight request checks covering:

1. Free `check_endpoint` works
2. Free user calling a Pro tool is blocked
3. Invalid API key is rejected
4. Inactive subscription is rejected
5. Quota exceeded returns `429`
6. Active Pro key can call all tools

---

## Errors

| Status | Meaning | What to do |
|---|---|---|
| `401` | Missing or invalid API key | Add `X-API-Key` or check that the key is valid |
| `402` | Billing inactive | Reactivate billing for the API key or get a new one at `/pricing` |
| `429` | Monthly quota exceeded | Wait for the next calendar month or upgrade/reactivate as needed |
| `404` | Tool not found | Check the tool name spelling |

---

## Use Cases

### Support

- Verify a pricing claim before a customer sees it
- Confirm whether a support policy applies before escalating
- Check whether an API endpoint is live before recommending it

### Product

- Test a market assumption before shipping a strategy doc
- Check whether a competitor exists before saying the category is open
- Compare package popularity before making a stack decision

### Legal

- Confirm whether a support or policy claim is still true on the live site
- Check public terms and pricing pages before quoting them internally

### Market research

- Count competitors in a category
- Compare pricing across live public pages
- Turn assumptions into structured pass/fail checks

---

## Related Docs

- [README.md](./README.md)
- [SETUP.md](./SETUP.md)
- [claude-skill/README.md](./claude-skill/README.md)
