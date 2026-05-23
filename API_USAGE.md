# Ground Truth API Guide

**Live fact-checking tools for AI agents. Start with one free tool call.**

Ground Truth gives AI agents a verification layer they can call before answering, recommending, or taking action.

Ground Truth supports three access modes:

- Free endpoint and security-header checks
- Agentic pay-per-use with x402-compatible clients or an xpay proxy
- Team API-key billing with a monthly subscription

This guide covers what Ground Truth verifies, how the access modes differ, direct API examples, MCP setup, and every available tool.

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
3. Paste this prompt:

> Use Ground Truth to call the `check_endpoint` tool with `url` set to `https://example.com`. Return the URL, HTTP status, whether it was accessible, and response time.

Expected output shape:

```json
{
  "url": "https://example.com/",
  "accessible": true,
  "status": 200,
  "contentType": "text/html",
  "responseTimeMs": 120
}
```

`responseTimeMs` will vary. A first successful tool call means your MCP client is connected and Ground Truth is usable.

---

## What Ground Truth Verifies

Ground Truth helps agents verify:

- Pricing claims
- Pricing comparisons
- Compliance posture
- Security posture
- Competitor existence
- API endpoints
- Package comparisons
- Market assumptions
- Support and policy claims

If the answer depends on live public data, Ground Truth is designed to check it first.

---

## Access Modes

### Free

Free tier includes limited monthly endpoint and security-header checks.

- `check_endpoint`
- `inspect_security_headers`
- 100 requests per calendar month
- Tracked by Cloudflare client IP in production, or `X-Anonymous-Client-Id` for local/dev testing
- No API key required for free checks

### Agentic pay-per-use

Paid tools also support agentic pay-per-use.

- Use an x402-compatible MCP client, or put an xpay proxy in front of the live `/mcp` URL
- Tool pricing starts at `$0.01` per call and varies by tool
- Best for autonomous agents and variable workloads
- Includes every paid verification tool

### Team

Team billing uses a monthly subscription and `X-API-Key`.

- Requires `X-API-Key` with active billing
- Default quota of 5,000 requests per calendar month
- Monthly usage tracked per API key and tool
- Includes every paid verification tool

To use the team plan, subscribe at [ground-truth-mcp.anishdasmail.workers.dev/pricing](https://ground-truth-mcp.anishdasmail.workers.dev/pricing) and send your key in `X-API-Key`.

---

## Try This First

These two calls work without signup or an API key:

- `check_endpoint` for "Does this URL respond right now?"
- `inspect_security_headers` for "What security headers does this public site expose?"

Copy-paste this first prompt:

> Use Ground Truth to call the `check_endpoint` tool with `url` set to `https://example.com`. Return the URL, HTTP status, whether it was accessible, and response time.

---

## API Examples

### Direct API with `curl`

Call the free `check_endpoint` tool with no API key:

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

Call the free `check_endpoint` tool from code:

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
        "url": "https://example.com"
      }
    },
    "id": 1
  }'
```

### Unpaid paid-tool request

Call a paid tool without `X-API-Key` to get x402 payment metadata back from MCP:

```bash
curl -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "estimate_market",
      "arguments": {
        "query": "edge orm",
        "registry": "npm"
      }
    },
    "id": 2
  }'
```

Expected behavior:

- HTTP status stays `200`
- The MCP result includes `_meta["x402/error"]`
- The error payload includes `PAYMENT_REQUIRED` plus accepted payment requirements

---

## Concrete Use Case: Grounded Source Lookup

Use Ground Truth when an agent needs to verify that a source or endpoint exists before using it in an answer, support reply, or citation-ready research context.

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

The result gives the agent source-backed context that the URL was reachable at call time plus a short response sample for grounding. It does not prove authenticated behavior, page correctness, or long-term availability.

---

## Limits and Access Rules

- Free access applies to `check_endpoint` and `inspect_security_headers`
- Free access is limited to 100 requests per calendar month
- Free usage is tracked by Cloudflare client IP in production, or `X-Anonymous-Client-Id` for local/dev testing
- Free requests over the monthly limit return `429`
- Paid tools can be accessed with either a valid team API key or an x402 payment
- Missing or invalid team keys return `401` when you explicitly send `X-API-Key`
- Inactive team billing returns `402`
- Team usage over the monthly limit returns `429`
- The default team monthly quota is 5,000 tool requests per API key
- Unpaid agentic requests return MCP payment metadata rather than an HTTP auth error

For local testing, `X-Anonymous-Client-Id` is the easiest way to simulate separate anonymous clients.

---

## MCP Setup

Ground Truth can also be used through MCP clients like Claude Desktop and Cursor.

MCP means [Model Context Protocol](https://modelcontextprotocol.io), the standard many AI apps use to call external tools.

If you want turnkey pay-per-tool billing without changing your client, register the live MCP URL with xpay and share the proxy URL instead.

The server also publishes a metadata card at:

`https://ground-truth-mcp.anishdasmail.workers.dev/.well-known/mcp/server-card.json`

### Claude Desktop

For the free first call, add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

For the free first call, add to `.cursor/mcp.json` or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp"
    }
  }
}
```

Only add `X-API-Key` when you are using paid tools through the team plan.

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

### Compare vendor pricing pages

```json
{
  "name": "compare_pricing_pages",
  "arguments": {
    "pages": [
      { "name": "Vendor A", "url": "https://example.com/pricing" },
      { "name": "Vendor B", "url": "https://example.org/pricing" }
    ]
  }
}
```

### Scan a trust page

```json
{
  "name": "assess_compliance_posture",
  "arguments": {
    "url": "https://example.com/security"
  }
}
```

### Inspect public security headers

```json
{
  "name": "inspect_security_headers",
  "arguments": {
    "url": "https://example.com"
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

### `estimate_market` (Paid)

Checks whether competitors or alternatives exist by searching npm or PyPI.

| Field | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search query such as `edge orm` |
| `registry` | `npm` or `pypi` | No | Defaults to `npm` |

Returns total result count plus top matches with version and description data.

---

### `check_pricing` (Paid)

Extracts prices and plan signals from a live pricing page.

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | The pricing page URL |

Returns prices found, plan names, free-option signals, free-trial signals, and cache status.

---

### `inspect_security_headers` (Free)

Checks common browser-facing security headers on a public URL.

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | The URL to inspect |

Returns individual header presence, a summary score, and missing recommended headers.

---

### `compare_pricing_pages` (Paid)

Compares 2 to 5 pricing pages side by side.

| Field | Type | Required | Description |
|---|---|---|---|
| `pages` | array | Yes | Objects containing `name` and `url` |

Returns normalized pricing signals for each page plus an aggregate summary.

---

### `compare_competitors` (Paid)

Compares 2 to 10 packages side by side.

| Field | Type | Required | Description |
|---|---|---|---|
| `packages` | string[] | Yes | Package names to compare |
| `registry` | `npm` or `pypi` | No | Defaults to `npm` |

Returns version, description, license, publish dates, keywords, and found/not-found status.

---

### `verify_claim` (Paid)

Checks whether live sources support or contradict a claim.

| Field | Type | Required | Description |
|---|---|---|---|
| `claim` | string | Yes | The claim you want to verify |
| `evidence_urls` | string[] | Yes | One to ten URLs to check |
| `keywords` | string[] | Yes | Signals expected on supporting pages |

Returns per-source support data plus an overall verdict.

---

### `assess_compliance_posture` (Paid)

Scans a trust or security page for enterprise compliance signals.

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | The trust, security, or compliance page URL |

Returns matched signals such as SOC 2, GDPR, HIPAA, SSO, SCIM, and DPA mentions.

---

### `test_hypothesis` (Paid)

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

## Authentication and Billing

### Team API-key mode

Team requests use the `X-API-Key` header.

```bash
-H "X-API-Key: gt_live_your_key_here"
```

API keys start with `gt_live_`.

By default, an active team key can make 5,000 tool requests per calendar month.

### Agentic pay-per-use mode

Agentic requests do not need `X-API-Key`.

- A paid tool first returns `_meta["x402/error"]` with payment requirements
- The client or proxy pays and retries with `_meta["x402/payment"]`
- Successful paid responses include `_meta["x402/payment-response"]`

Use [test-x402-payment.mjs](./test-x402-payment.mjs) for an opt-in end-to-end payment test.

---

## Enforcement Checks

Use [test-usage-enforcement.sh](./test-usage-enforcement.sh) for lightweight request checks covering:

1. Free `check_endpoint` works
2. Unpaid paid-tool requests return MCP payment metadata
3. Invalid team API key is rejected
4. Inactive team subscription is rejected
5. Free quota exceeded returns `429`
6. Active team key can call all paid tools

---

## Troubleshooting

### Server not connecting

- Confirm your MCP client supports remote Streamable HTTP servers.
- Confirm the URL is exactly `https://ground-truth-mcp.anishdasmail.workers.dev/mcp`.
- Restart or refresh the MCP client after editing its config.
- Check metadata reachability with `curl -I https://ground-truth-mcp.anishdasmail.workers.dev/.well-known/mcp/server-card.json`.

### No tool calls appearing

- Use the copy-paste prompt above and name the tool: `check_endpoint`.
- Make sure Ground Truth is enabled in the client's tool list.
- Start with the free tool and no `X-API-Key`.
- If the model answers from memory, ask it to call `check_endpoint` explicitly.

### Missing environment variables

- Hosted free checks do not need environment variables or an API key.
- Local deployments need the `API_KEYS` KV binding for quota tracking.
- Team billing needs `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
- Production x402 payments should set `GROUND_TRUTH_X402_NETWORK` and `GROUND_TRUTH_X402_RECIPIENT`.

### Unsupported MCP client

- Use the direct MCP HTTP curl example above to confirm the server works.
- Use a client with remote Streamable HTTP support for the hosted server.
- If a directory requires stdio, use `npm run start:glama:stdio`.
- For paid tools in clients without native x402 support, use an xpay proxy in front of the live `/mcp` URL.

---

## Errors

| Status | Meaning | What to do |
|---|---|---|
| `200` | Unpaid agentic paid-tool request | Read `_meta["x402/error"]` and pay via an x402 client or xpay proxy |
| `401` | Missing or invalid explicit team API key | Add a valid `X-API-Key` or remove it and use agentic pay-per-use |
| `402` | Team billing inactive | Reactivate the subscription for the API key or get a new one at `/pricing` |
| `429` | Monthly quota exceeded | Wait for the next calendar month or use the other billing mode |
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
- Compare pricing pages before repeating vendor positioning

### Compliance

- Scan trust pages for SOC 2, GDPR, HIPAA, DPA, SSO, and SCIM signals
- Check public terms, trust, and pricing pages before quoting them internally

### Security and vendor diligence

- Inspect browser-facing security headers before making a security claim
- Compare vendors with live pricing, compliance, and public-security checks

---

## Related Docs

- [README.md](./README.md)
- [SETUP.md](./SETUP.md)
- [claude-skill/README.md](./claude-skill/README.md)
