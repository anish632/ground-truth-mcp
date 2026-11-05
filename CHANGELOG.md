# Changelog

## 0.9.0 - 2026-11-05

- Fix the MCP transport silently returning an opaque Cloudflare `1101` worker exception on `initialize`/tool calls: `serve()` is now guarded so any framework-level failure returns a readable JSON-RPC error (and is logged) instead of a black-box 500 that blocked every connection and zeroed activation.
- Add a `/health/mcp` self-check that runs a real `initialize` handshake and returns `PASS`/`FAIL` (HTTP 200/503), so an external uptime monitor — or a Ground Truth monitor on this URL — catches a transport outage immediately.
- Add email and Slack change alerts alongside webhooks: a monitor's destination may now be an HTTPS webhook, a Slack Incoming Webhook (`https://hooks.slack.com/...`), or `mailto:you@example.com` (email requires `RESEND_API_KEY`).
- Add annual billing (2 months free) per tier via optional annual Stripe price IDs; `/pricing` shows the annual option only when configured, and `/api/checkout?interval=annual` uses it.
- Improve activation: the server now returns MCP `instructions` on `initialize`, so every connecting agent is told the exact no-key first call (`check_endpoint`) and the no-signup path to recurring value (`preview_monitor` → free `create_monitor`) before any paid prompt.

## Unreleased - 2026-09-04

- Fix first pricing checks in new browser workspaces by initializing their cache table before monitor actions and scheduled runs.
- Add a no-save live pricing example, readable baseline summaries, next-check timing, and an empty competitor URL field to the watch dashboard.
- Show all three monthly plans before checkout and enable hourly schedules from server-granted paid entitlements.
- Preserve actionable first-run errors and the saved monitor so users can retry without creating a duplicate.
- Reject failed HTTP sources instead of recording empty pricing baselines; require each plan's own configured Stripe price.
- Clarify the availability-only website monitor and focus the homepage on competitor pricing evidence.
- Add dashboard interaction regressions and a repeatable local/production monitoring smoke test (`node test-watch.mjs [origin]`).

## 0.8.0 - 2026-08-27

- Add a no-signup `/watch` dashboard with three persistent daily or weekly monitors, immediate first-run evidence, history, webhooks, share links, and a copyable recovery key.
- Let free watch keys call every monitor-management MCP tool while reserving hourly schedules, higher monitor caps, and larger quotas for paid plans.
- Preserve the same key, monitors, and evidence through self-serve Stripe upgrades.
- Move monitor state from transient MCP sessions to account-sharded Durable Objects and schedule checks per account.
- Replace Stripe customer-wide KV scans with a direct customer-to-key index, retaining a one-time compatibility repair path.
- Add product-led funnel events for watch-key creation, monitor creation, first monitor run, and dashboard views.
- Reposition the homepage, pricing, registry metadata, and documentation around competitive change evidence for B2B SaaS teams.
- Remove committed runtime credentials from current configuration and setup documentation.

## 0.7.0 - 2026-08-10

- Add the free `preview_monitor` activation tool and no-signup `/try` Monitor Lab.
- Return agent-readable monitoring cadence, persistence, and next-action guidance before checkout.
- Reposition the homepage, pricing, server card, Glama, and Smithery metadata around source freshness and persistent monitoring.
- Add monitor-preview and qualified-activation metrics.
- Exclude known maintainer smoke-test and health-check clients from growth analytics without bypassing quotas or billing.

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

- Add first-success activation tracking plus paid and monitor intent events.
- Exclude synthetic verification probes from usage metrics.
- Include checkout and monitor next actions in paid-gate responses and post-checkout guidance.
- Reframe paid usage around saved monitors, evidence history, and change reports.
- Tie the paid plan to 10 active monitors plus a 5,000 evidence-run quota.
- Add expiring, read-only share links with Open Graph metadata, copy/share controls, and shared-report view analytics.
- Add referral attribution from shared reports through landing pages and checkout, with one bonus monitor slot for qualified referrals.
- Track referred first-success activation separately so referral conversion is not lost when an existing client or shared IP has already activated.
- Add HTTPS webhook notifications for detected monitor changes and expose referral/notification funnel counters in `/stats`.

## [0.6.0] - 2026-08-05

- Reposition the product around preflighting unfamiliar APIs, URLs, and claims before agent trust or action.
- Add the composite `preflight_endpoint` tool and PASS/WARN/FAIL evidence to endpoint and security-header checks.
- Replace request-volume-first `/stats` headlines with rolling unique, repeat, paid, and tool-usage metrics.
- Normalize analytics events and make Stripe checkout/subscription events idempotent across success-page and webhook delivery.

- Add centralized tool usage events and funnel metrics to the stable Durable Object so `/stats` reflects actual tool traffic.
- Verify Stripe webhook HMAC signatures before changing billing state, and record checkout/subscription funnel events separately from success-page views.
- Align the public offer with the implemented $9 plan and remove unimplemented alert-tier promises.
- Add a post-activation monitor CTA and make the optional external telemetry sink configurable instead of depending on a missing dashboard deployment.

- Bump the registry/server listing version to 0.5.3 so the updated marketplace copy can republish cleanly.
- Add a no-key 60-second quickstart centered on the first `check_endpoint` tool call.
- Add example first-call input/output, troubleshooting, and marketplace profile copy snippets.
- Update README, API guide, landing-page, package, Smithery, MCP registry, and server-card copy to make first-call activation clearer.
- Add `GTM_PRODUCT_AUDIT.md` with `first_successful_tool_call` as the core activation event.
- Align homepage API examples with the no-key `check_endpoint` first call and emit a first-free-call telemetry event from the quota gateway.
- Switch the first-call sample URL from GitHub API to `https://example.com` after live verification showed GitHub rate limits can block the first success.

## [0.4.5] - 2026-05-15

- Add `smithery.yaml` to enable Smithery Install button config schema and release publishing.
- Expand `server.json` description with all nine tool names for richer MCP registry search matching.
- Expand `package.json` keywords with `mcp-server`, `hypothesis-testing`, `vendor-diligence`, `market-research`, `live-data`, `security-headers`, `pricing-intelligence`, `x402`, and `cloudflare-workers`.
- Remove internal Glama setup note from README.

## [0.4.0] - 2026-04-29

- Add hybrid monetization with x402-compatible pay-per-use and a repositioned team subscription flow.
- Add `inspect_security_headers`, `compare_pricing_pages`, and `assess_compliance_posture`.
- Publish `/.well-known/mcp/server-card.json` for richer MCP directory metadata.
- Allow unpaid paid-tool requests to return MCP payment metadata instead of hard-failing agentic access at the gateway.
- Add paid-response caching for idempotent x402 retries and configurable Stripe/x402 runtime settings.
- Refresh README, API usage, setup, and operational docs for Free / Agentic / Team positioning.
- Remove an unused hard-coded database URL from the Worker runtime.
- Document the `GROUND_TRUTH_TELEMETRY` runtime flag in setup notes.
- Strengthen tool metadata descriptions to improve Glama quality scoring clarity.
- Expand CI to run both typecheck and build, with manual workflow dispatch support.
- Clarify the exact Glama related-server recommendations in the README.

## [0.3.1] - 2026-04-29

- Improve MCP tool metadata with structured outputs, richer descriptions, and clearer usage guidance.
- Add GitHub release automation for stable `v*` tags.
- Expand README guidance for Glama badges, related servers, and release hygiene.

## [0.3.0] - 2026-04-29

- Add free and Pro usage enforcement with monthly quotas.
- Add pricing, claim verification, market sizing, competitor comparison, and hypothesis testing tools.
- Document direct MCP API usage, client setup, and Glama deployment flow.
