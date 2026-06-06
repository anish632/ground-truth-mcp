# Ground Truth MCP GTM Product Audit

Date: 2026-05-19

## Activation Problem

Known 30-day signal from latest Glama screenshot:

- 1,179 search impressions
- 11 search clicks
- 1,075 profile views
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
    "url": "https://example.com"
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

> First tool call for AI agents: call `check_endpoint` with `url=https://example.com` to verify Ground Truth is connected. No signup or API key for the first endpoint check.

Try-first prompt:

> Use Ground Truth's `check_endpoint` tool with `url` set to `https://example.com`. Do not answer from memory. Call the tool and return exactly: `url`, `accessible`, `status`, `contentType`, and `responseTimeMs`.

Setup note:

> No API key is required for the first `check_endpoint` call. Add `X-API-Key` only after that works and only for team-plan paid tools.

Release notes:

> Improved first-call activation with a no-key 60-second quickstart, one copy-paste `check_endpoint` prompt, example input/output, clearer free-vs-paid setup, and troubleshooting for MCP client connection issues.

## Current Activation Rewrite

The profile and quickstart now lead with one path only:

1. Add the remote MCP URL.
2. Paste the exact `check_endpoint` prompt with `url=https://example.com`.
3. Verify a structured result containing `url`, `accessible`, `status`, `contentType`, and `responseTimeMs`.

Track the ratio:

`profile views -> first successful check_endpoint call`

The immediate goal is not more profile views. The goal is that a cold user can reach `check_endpoint` successfully in under 60 seconds.

---

## Revenue Sprint Update (2026-06-02)

### Pivot

Ground Truth should not monetize primarily as one paid tool call. A single `check_pricing` or `verify_claim` call is easy for a browser/search agent to approximate.

Position the paid product as:

> Monitored evidence and change alerts for agent claims.

The free product proves the MCP connection. The paid product preserves and repeats verification over time.

### Paid Value

Charge for durable infrastructure:

- Saved monitors
- Scheduled runs
- Before/after diff history
- Change reports
- Team API keys
- Higher quotas
- Future: Slack/email/webhook alerts and audit-log export

### Offer Tests

| Offer | Price | Implementation status | Why |
|---|---:|---|---|
| First endpoint/security checks | $0 | Implemented | Reduces activation friction |
| Agentic per-call tools | From $0.01/call | Implemented | Useful, but likely weak as primary revenue |
| Monitor Starter | $9/mo | Positioning update; pricing page should be aligned | Tests individual willingness to pay for saved monitors |
| Team monitor plan | $29/mo | Team API key exists; monitor framing needs emphasis | Better fit for recurring value |
| Business alerts | $99/mo | Not implemented | Webhooks/alerts/audit history for higher-stakes workflows |

### Decision Rule

Track:

`profile_view -> first_successful_tool_call -> create_monitor -> run_monitor_now -> generate_change_report -> checkout_started -> checkout_completed`

If profile views continue but `first_successful_tool_call` remains near zero, do not mention paid tools earlier. Keep fixing activation.

If first calls happen but no monitors are created, the paid workflow is unclear. Move monitor examples and "watch this claim" prompts higher.

If monitors are created but no checkout starts, package the paid promise as alerts/history/reports rather than tool access.

### Listing Copy To Use

Short description:

> Free first MCP call: run `check_endpoint` with `url=https://example.com`. Paid plans add saved monitors, scheduled checks, evidence history, and change reports for agent claims.

Paid-plan copy:

> Stop agents from repeating stale claims. Monitor pricing pages, docs, endpoints, packages, trust pages, and vendor claims on a schedule, then review the evidence history when something changes.
