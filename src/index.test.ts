import { describe, expect, it } from "vitest";
import {
  ANALYTICS_EVENT_NAMES,
  DEFAULT_PAID_PLAN_ID,
  FREE_MONITOR_LIMIT,
  FREE_MONITOR_MONTHLY_QUOTA,
  FREE_TOOLS,
  MONITOR_TOOLS,
  PAID_PLAN_ORDER,
  PAID_PLANS,
  PAID_TOOLS,
  SERVER_VERSION,
  calculateRollingUsageMetrics,
  getEndpointVerdict,
  getMcpClientIdentifier,
  getSecurityHeaderVerdict,
  isSyntheticMcpClientIdentifier,
  isSyntheticToolName,
  normalizeAnalyticsEventName,
  normalizeCheckoutFunnel,
  resolvePaidPlanId,
  resolveBillingInterval,
  annualPriceUsd,
  ANNUAL_MONTHS_CHARGED,
} from "./product-contract";

describe("Ground Truth product contract", () => {
  it("keeps the existing MCP tool families and publishes the preflight tool", () => {
    expect(SERVER_VERSION).toBe("0.9.0");
    expect(FREE_MONITOR_LIMIT).toBe(3);
    expect(FREE_MONITOR_MONTHLY_QUOTA).toBe(100);
    expect(FREE_TOOLS).toEqual(expect.arrayContaining([
      "check_endpoint",
      "inspect_security_headers",
      "verify_claim",
      "list_resources",
      "preflight_endpoint",
      "preview_monitor",
    ]));
    expect(PAID_TOOLS).toContain("verify_claim");
    expect(MONITOR_TOOLS).toContain("generate_change_report");
    expect(MONITOR_TOOLS).toContain("create_share_link");
  });

  it("defines the canonical analytics taxonomy and normalizes legacy names", () => {
    expect(ANALYTICS_EVENT_NAMES).toEqual(expect.arrayContaining([
      "homepage_view",
      "pricing_view",
      "mcp_connection",
      "tool_call_started",
      "tool_call_completed",
      "tool_call_failed",
      "payment_required",
      "paid_intent",
      "monitor_intent",
      "share_link_created",
      "shared_report_viewed",
      "referral_landing",
      "referral_checkout_started",
      "referral_checkout_completed",
      "referral_reward_credited",
      "monitor_notification_sent",
      "monitor_notification_failed",
      "monitor_preview_started",
      "monitor_preview_completed",
      "free_monitor_access_created",
      "persistent_monitor_created",
      "persistent_monitor_first_run",
      "watch_dashboard_view",
      "first_successful_tool_call",
      "referred_first_successful_tool_call",
      "checkout_started",
      "checkout_completed",
      "subscription_activated",
      "paid_tool_call",
    ]));
    expect(normalizeAnalyticsEventName("tool_call_received")).toBe("tool_call_started");
    expect(normalizeAnalyticsEventName("checkout_start")).toBe("checkout_started");
    expect(normalizeAnalyticsEventName("payment_required")).toBe("payment_required");
    expect(isSyntheticToolName("__verifymcp_auth_probe_abc123__")).toBe(true);
    expect(isSyntheticToolName("check_endpoint")).toBe(false);
    expect(isSyntheticMcpClientIdentifier("ground-truth-usage-test/1.0.0")).toBe(true);
    expect(isSyntheticMcpClientIdentifier("activation-test/1.0.0")).toBe(true);
    expect(isSyntheticMcpClientIdentifier("claude-desktop/2.0")).toBe(false);
  });

  it("returns decision-oriented endpoint verdicts without overstating certainty", () => {
    expect(getEndpointVerdict({ accessible: true, status: 200 })).toMatchObject({
      verdict: "PASS",
      recommended_action: "proceed",
    });
    expect(getEndpointVerdict({ accessible: false, status: 401, authRequired: true })).toMatchObject({
      verdict: "WARN",
      recommended_action: "proceed_with_caution",
    });
    expect(getEndpointVerdict({ accessible: false, status: 503 })).toMatchObject({
      verdict: "FAIL",
      recommended_action: "stop",
    });
  });

  it("returns header verdicts as configuration signals, not security guarantees", () => {
    expect(getSecurityHeaderVerdict({ accessible: true, https: true, score: "strong" })).toMatchObject({
      verdict: "PASS",
      recommended_action: "proceed",
    });
    expect(getSecurityHeaderVerdict({ accessible: true, https: true, score: "weak" })).toMatchObject({
      verdict: "WARN",
      recommended_action: "proceed_with_caution",
    });
    expect(getSecurityHeaderVerdict({ accessible: true, https: true, status: 404, score: "strong" })).toMatchObject({
      verdict: "WARN",
      recommended_action: "proceed_with_caution",
    });
    expect(getSecurityHeaderVerdict({ accessible: false, https: true, error: "timeout" })).toMatchObject({
      verdict: "FAIL",
      recommended_action: "stop",
    });
  });

  it("identifies MCP clients from explicit client metadata without requiring it", () => {
    const request = new Request("https://example.com/mcp");
    expect(getMcpClientIdentifier(request, {
      params: { clientInfo: { name: "test-client", version: "1.2.3" } },
    })).toBe("test-client/1.2.3");

    const headerRequest = new Request("https://example.com/mcp", {
      headers: { "X-MCP-Client-Id": "header-client" },
    });
    expect(getMcpClientIdentifier(headerRequest)).toBe("header-client");
  });

  it("calculates rolling unique, repeat, paid, and tool metrics", () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.parse("2026-08-05T00:00:00.000Z");
    const events = [
      { eventName: "mcp_connection", tool: null, tier: null, paymentMethod: null, status: "started", clientHash: "c1", ts: now - day },
      { eventName: "tool_call_started", tool: "check_endpoint", tier: "free", paymentMethod: null, status: "started", clientHash: "c1", ts: now - day },
      { eventName: "tool_call_completed", tool: "check_endpoint", tier: "free", paymentMethod: null, status: "success", clientHash: "c1", ts: now - day },
      { eventName: "tool_call_started", tool: "inspect_security_headers", tier: "free", paymentMethod: null, status: "started", clientHash: "c1", ts: now - 2 * day },
      { eventName: "tool_call_started", tool: "verify_claim", tier: "team", paymentMethod: "subscription", status: "started", clientHash: "c2", ts: now - 3 * day },
      { eventName: "paid_tool_call", tool: "verify_claim", tier: "team", paymentMethod: "subscription", status: "success", clientHash: "c2", ts: now - 3 * day },
      { eventName: "payment_required", tool: "check_pricing", tier: "paid_gated", paymentMethod: "subscription_or_x402", status: "rejected", clientHash: "c3", ts: now - 4 * day },
      { eventName: "mcp_connection", tool: null, tier: null, paymentMethod: null, status: "started", clientHash: "c3", ts: now - 10 * day },
      { eventName: "tool_call_started", tool: "check_endpoint", tier: "free", paymentMethod: null, status: "started", clientHash: "old", ts: now - 31 * day },
    ];

    const metrics = calculateRollingUsageMetrics(events, now);
    expect(metrics.last7Days).toMatchObject({
      uniqueMcpClients: 2,
      uniqueToolUsers: 2,
      toolCalls: 3,
      paidUsers: 1,
      paidCalls: 1,
      paymentRequiredEvents: 1,
    });
    expect(metrics.last30Days).toMatchObject({
      uniqueMcpClients: 3,
      uniqueToolUsers: 2,
      repeatUsers: 1,
      toolCalls: 3,
      paidUsers: 1,
      paidCalls: 1,
      paymentRequiredEvents: 1,
      firstPaidCallUsers: 1,
      conversionToFirstPaidCall: 0.5,
      byTool: { check_endpoint: 1, inspect_security_headers: 1, verify_claim: 1 },
    });
  });

  it("keeps checkout starts logically at or above completed checkouts", () => {
    expect(normalizeCheckoutFunnel(1, 2)).toEqual({
      checkoutStarts: 2,
      checkoutStartsRaw: 1,
      checkoutCompleted: 2,
      checkoutStartCoverage: 0.5,
    });
    expect(normalizeCheckoutFunnel(3, 2).checkoutStarts).toBe(3);
  });

  it("excludes synthetic probes and exposes activation intent metrics", () => {
    const now = Date.parse("2026-08-05T00:00:00.000Z");
    const events = [
      { eventName: "tool_call_started", tool: "check_endpoint", tier: "free", paymentMethod: null, status: "started", clientHash: "c1", referralCode: "shr_abcdefghijkl", ts: now - 1_000 },
      { eventName: "tool_call_completed", tool: "check_endpoint", tier: "free", paymentMethod: null, status: "success", clientHash: "c1", referralCode: "shr_abcdefghijkl", ts: now - 900 },
      { eventName: "first_successful_tool_call", tool: "check_endpoint", tier: "free", paymentMethod: null, status: "success", clientHash: "c1", referralCode: "shr_abcdefghijkl", ts: now - 800 },
      { eventName: "referred_first_successful_tool_call", tool: "check_endpoint", tier: "free", paymentMethod: null, status: "success", clientHash: "c1", referralCode: "shr_abcdefghijkl", ts: now - 700 },
      { eventName: "paid_intent", tool: "check_pricing", tier: "paid_gated", paymentMethod: "subscription_or_x402", status: "rejected", clientHash: "c1", ts: now - 600 },
      { eventName: "monitor_intent", tool: "create_monitor", tier: "rejected", paymentMethod: null, status: "rejected", clientHash: "c1", ts: now - 500 },
      { eventName: "tool_call_started", tool: "preview_monitor", tier: "free", paymentMethod: null, status: "started", clientHash: "c2", ts: now - 450 },
      { eventName: "monitor_preview_completed", tool: "preview_monitor", tier: "free", paymentMethod: null, status: "success", clientHash: "c3", ts: now - 425 },
      { eventName: "free_monitor_access_created", tool: "create_monitor", tier: "free_monitor", paymentMethod: null, status: "success", clientHash: "c4", ts: now - 420 },
      { eventName: "tool_call_started", tool: "create_monitor", tier: "free_monitor", paymentMethod: null, status: "started", clientHash: "c4", ts: now - 415 },
      { eventName: "persistent_monitor_created", tool: "create_monitor", tier: "free_monitor", paymentMethod: null, status: "success", clientHash: "c4", ts: now - 410 },
      { eventName: "persistent_monitor_first_run", tool: "run_monitor_now", tier: "free_monitor", paymentMethod: null, status: "success", clientHash: "c4", ts: now - 405 },
      { eventName: "tool_call_started", tool: "__verifymcp_auth_probe_abc123__", tier: "free", paymentMethod: null, status: "started", clientHash: "probe", ts: now - 400 },
    ];

    const metrics = calculateRollingUsageMetrics(events, now);
    expect(metrics.last30Days.toolCalls).toBe(3);
    expect(metrics.last30Days.byTool).toEqual({ check_endpoint: 1, preview_monitor: 1, create_monitor: 1 });
    expect(metrics.last30Days.paidIntentEvents).toBe(1);
    expect(metrics.last30Days.monitorIntentEvents).toBe(1);
    expect(metrics.last30Days.firstSuccessfulToolCallUsers).toBe(1);
    expect(metrics.last30Days.referredToolCalls).toBe(1);
    expect(metrics.last30Days.referredFirstSuccessfulToolCallUsers).toBe(1);
    expect(metrics.last30Days.monitorPreviewUsers).toBe(2);
    expect(metrics.last30Days.freeMonitorUsers).toBe(1);
    expect(metrics.last30Days.persistentMonitorCreators).toBe(1);
    expect(metrics.last30Days.persistentMonitorFirstRunUsers).toBe(1);
    expect(metrics.last30Days.authorizedMonitorUsers).toBe(1);
    expect(metrics.last30Days.qualifiedActivationUsers).toBe(3);
  });
});

describe("Good / Better / Best pricing tiers", () => {
  it("defines exactly three paid tiers in ascending price order", () => {
    expect(PAID_PLAN_ORDER).toHaveLength(3);
    const prices = PAID_PLAN_ORDER.map(id => PAID_PLANS[id].priceUsd);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("has exactly one highlighted (most-popular) tier", () => {
    const highlighted = PAID_PLAN_ORDER.filter(id => PAID_PLANS[id].highlight);
    expect(highlighted).toHaveLength(1);
  });

  it("enforces that each tier has strictly more monitors and quota than the previous", () => {
    for (let i = 1; i < PAID_PLAN_ORDER.length; i++) {
      const prev = PAID_PLANS[PAID_PLAN_ORDER[i - 1]];
      const curr = PAID_PLANS[PAID_PLAN_ORDER[i]];
      expect(curr.activeMonitorLimit).toBeGreaterThan(prev.activeMonitorLimit);
      expect(curr.monthlyQuota).toBeGreaterThan(prev.monthlyQuota);
    }
  });

  it("resolves legacy 'paid' and unknown plan params to the default entry tier", () => {
    expect(resolvePaidPlanId("paid")).toBe(DEFAULT_PAID_PLAN_ID);
    expect(resolvePaidPlanId(null)).toBe(DEFAULT_PAID_PLAN_ID);
    expect(resolvePaidPlanId(undefined)).toBe(DEFAULT_PAID_PLAN_ID);
    expect(resolvePaidPlanId("unknown_tier")).toBe(DEFAULT_PAID_PLAN_ID);
  });

  it("resolves valid plan IDs correctly", () => {
    expect(resolvePaidPlanId("good")).toBe("good");
    expect(resolvePaidPlanId("better")).toBe("better");
    expect(resolvePaidPlanId("best")).toBe("best");
  });

  it("validates the Good (entry) tier entitlements match the existing baseline", () => {
    const good = PAID_PLANS.good;
    expect(good.priceUsd).toBe(9);
    expect(good.monthlyQuota).toBe(5000);
    expect(good.activeMonitorLimit).toBe(10);
    expect(good.stripePriceEnvKey).toBe("STRIPE_PRICE_ID");
  });

  it("validates the Better (team) tier entitlements", () => {
    const better = PAID_PLANS.better;
    expect(better.priceUsd).toBe(29);
    expect(better.monthlyQuota).toBe(25000);
    expect(better.activeMonitorLimit).toBe(40);
    expect(better.highlight).toBe(true);
    expect(better.stripePriceEnvKey).toBe("STRIPE_PRICE_ID_BETTER");
  });

  it("validates the Best (scale) tier entitlements", () => {
    const best = PAID_PLANS.best;
    expect(best.priceUsd).toBe(99);
    expect(best.monthlyQuota).toBe(100000);
    expect(best.activeMonitorLimit).toBe(150);
    expect(best.stripePriceEnvKey).toBe("STRIPE_PRICE_ID_BEST");
    expect(best.stripePriceEnvKeyAnnual).toBe("STRIPE_PRICE_ID_BEST_ANNUAL");
  });
});

describe("annual billing", () => {
  it("resolves the billing interval, defaulting unknown values to monthly", () => {
    expect(resolveBillingInterval("annual")).toBe("annual");
    expect(resolveBillingInterval("monthly")).toBe("monthly");
    expect(resolveBillingInterval(null)).toBe("monthly");
    expect(resolveBillingInterval(undefined)).toBe("monthly");
    expect(resolveBillingInterval("yearly")).toBe("monthly");
  });

  it("charges ten months on the annual plan (two months free) for every tier", () => {
    expect(ANNUAL_MONTHS_CHARGED).toBe(10);
    expect(annualPriceUsd(PAID_PLANS.good)).toBe(90);
    expect(annualPriceUsd(PAID_PLANS.better)).toBe(290);
    expect(annualPriceUsd(PAID_PLANS.best)).toBe(990);
  });

  it("gives every paid tier a distinct annual Stripe price env key", () => {
    const annualKeys = PAID_PLAN_ORDER.map(id => PAID_PLANS[id].stripePriceEnvKeyAnnual);
    expect(new Set(annualKeys).size).toBe(annualKeys.length);
  });
});
