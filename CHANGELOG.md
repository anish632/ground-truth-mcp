# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

- No entries yet.

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
