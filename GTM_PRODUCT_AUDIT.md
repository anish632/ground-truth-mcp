# Ground Truth MCP GTM Product Audit

Date: 2026-05-19

## Activation Problem

Known 30-day signal:

- 1,111 search impressions
- 11 search clicks
- 932 profile views
- 0 tool calls

Interpretation: discovery and profile views exist, but users are not reaching the first successful MCP tool call.

## Core Activation Event

**First successful tool call** is the primary activation event.

Definition:

- User installs or connects Ground Truth MCP in a supported MCP client.
- User calls `check_endpoint` or `inspect_security_headers`.
- Tool returns an MCP result with HTTP `200` from the MCP server and a usable structured result.

Recommended first activation event:

```json
{
  "event": "first_successful_tool_call",
  "tool": "check_endpoint",
  "arguments": {
    "url": "https://api.github.com"
  }
}
```

## Inspection Checkpoint

1. README/profile copy: clear product category, but the first action was diluted by multiple prompts and paid examples appearing before the free no-key path.
2. Install instructions: Claude and Cursor examples included `X-API-Key` by default, which made the first call look gated.
3. MCP server configuration: remote Streamable HTTP endpoint at `https://ground-truth-mcp.anishdasmail.workers.dev/mcp`; optional `X-API-Key` is supported.
4. Available tools: 9 tools total. Free: `check_endpoint`, `inspect_security_headers`. Paid: `estimate_market`, `check_pricing`, `compare_pricing_pages`, `compare_competitors`, `verify_claim`, `assess_compliance_posture`, `test_hypothesis`.
5. Tool schemas/descriptions: implementation descriptions were detailed; static server-card descriptions needed stronger "call this first" language.
6. Example prompts: examples existed, but no single copy-paste first prompt dominated the page.
7. Deployment/configuration steps: Cloudflare Worker, MCP registry `server.json`, Smithery `smithery.yaml`, Glama Docker/stdio bridge, xpay wrapper deployment.
8. Logging/analytics: local Durable Object SQLite `usage_log`, KV monthly usage records, optional remote telemetry via `GROUND_TRUTH_TELEMETRY`.
9. Files likely to change: `README.md`, `API_USAGE.md`, `src/index.ts`, `server.json`, `package.json`, `smithery.yaml`, `GTM_PRODUCT_AUDIT.md`, `CHANGELOG.md`.
10. Risks/assumptions: not every MCP client supports remote Streamable HTTP; marketplace profile fields may require manual dashboard edits; free checks prove reachability at call time, not correctness or long-term availability.

## Activation Friction Found

- No single dominant "copy this first" prompt above broader positioning.
- Free path was mixed with paid/team examples too early.
- Install snippets included a team API key by default.
- Some CTAs sent users to `/mcp`, which is a protocol endpoint rather than a human quickstart.
- Marketplace/server descriptions did not explicitly tell users which tool to call first.

## Implemented Activation Improvements

- Added a 60-second quickstart centered on `check_endpoint`.
- Added one copy-paste "Try this first" prompt.
- Added example input and output shape for the first call.
- Added grounded source lookup as the concrete use case.
- Changed free first-call install snippets to omit `X-API-Key`.
- Kept team API key setup clearly optional and tied to paid tools.
- Added troubleshooting for server connection, missing tool calls, missing env vars, and unsupported MCP clients.
- Updated machine-readable descriptions to point to the first tool call.
- Updated deployed landing-page copy and setup snippets in the Worker source.

## Manual Marketplace Copy

Short description:

> Give AI agents one free first check: call `check_endpoint` to verify a public URL responds, then use paid tools for pricing, compliance, claims, package-market, and competitor checks.

Try-first prompt:

> Use Ground Truth to call `check_endpoint` with `url` set to `https://api.github.com`. Return the URL, status, accessible boolean, and response time.

Setup note:

> No API key is required for `check_endpoint` or `inspect_security_headers`. Add `X-API-Key` only for team-plan paid tools, or use x402/xpay for pay-per-use paid calls.

Release notes:

> Improved first-call activation with a no-key 60-second quickstart, one copy-paste `check_endpoint` prompt, example input/output, clearer free-vs-paid setup, and troubleshooting for MCP client connection issues.

## Next Measurement

Track the ratio:

`profile views -> first_successful_tool_call`

The immediate goal is not more profile views. The goal is that a cold user can reach `check_endpoint` successfully in under 60 seconds.
