export type VerificationVerdict = "PASS" | "WARN" | "FAIL";
export type RecommendedAction = "proceed" | "proceed_with_caution" | "stop";

export const SERVER_VERSION = "0.9.0";
export const FREE_MONITOR_LIMIT = 3;
export const FREE_MONITOR_MONTHLY_QUOTA = 100;
export const FREE_TOOLS = ["check_endpoint", "inspect_security_headers", "preflight_endpoint", "preview_monitor", "verify_claim", "list_resources"] as const;
export const PAID_TOOLS = [
  "check_pricing",
  "estimate_market",
  "compare_competitors",
  "compare_pricing_pages",
  "test_hypothesis",
  "assess_compliance_posture",
  "verify_claim",
] as const;
export const MONITOR_TOOLS = ["create_monitor", "list_monitors", "run_monitor_now", "get_monitor_result", "delete_monitor", "generate_change_report", "create_share_link"] as const;

// --- Good / Better / Best paid plans ---
// The two levers enforced per tier are the active-monitor cap and the monthly
// evidence-run quota. Every paid tier unlocks the same tools; the shared
// capabilities are listed in PAID_PLAN_SHARED_FEATURES so the pricing page
// never advertises a differentiator the code does not actually gate.
export type PaidPlanId = "good" | "better" | "best";

export type BillingInterval = "monthly" | "annual";

/** Months billed up front on the annual plan; 10 means "2 months free". */
export const ANNUAL_MONTHS_CHARGED = 10;

export interface PaidPlanDefinition {
  id: PaidPlanId;
  /** Display name shown on the pricing card. */
  name: string;
  priceUsd: number;
  /** Included evidence runs per calendar month (enforced via record.monthlyQuota). */
  monthlyQuota: number;
  /** Included concurrently-active monitors (enforced in the Durable Object). */
  activeMonitorLimit: number;
  /** Marks the anchored "most popular" middle tier. */
  highlight: boolean;
  /** One-line positioning shown under the price. */
  blurb: string;
  /** Wrangler secret/var that holds this tier's monthly Stripe price ID. */
  stripePriceEnvKey: "STRIPE_PRICE_ID" | "STRIPE_PRICE_ID_BETTER" | "STRIPE_PRICE_ID_BEST";
  /** Wrangler secret/var that holds this tier's annual Stripe price ID (optional deployment). */
  stripePriceEnvKeyAnnual: "STRIPE_PRICE_ID_ANNUAL" | "STRIPE_PRICE_ID_BETTER_ANNUAL" | "STRIPE_PRICE_ID_BEST_ANNUAL";
}

export const PAID_PLANS: Record<PaidPlanId, PaidPlanDefinition> = {
  good: {
    id: "good",
    name: "Monitor",
    priceUsd: 9,
    monthlyQuota: 5000,
    activeMonitorLimit: 10,
    highlight: false,
    blurb: "Keep a handful of critical sources fresh for a single agent.",
    stripePriceEnvKey: "STRIPE_PRICE_ID",
    stripePriceEnvKeyAnnual: "STRIPE_PRICE_ID_ANNUAL",
  },
  better: {
    id: "better",
    name: "Team",
    priceUsd: 29,
    monthlyQuota: 25000,
    activeMonitorLimit: 40,
    highlight: true,
    blurb: "Monitor many sources across an agent fleet or small team.",
    stripePriceEnvKey: "STRIPE_PRICE_ID_BETTER",
    stripePriceEnvKeyAnnual: "STRIPE_PRICE_ID_BETTER_ANNUAL",
  },
  best: {
    id: "best",
    name: "Scale",
    priceUsd: 99,
    monthlyQuota: 100000,
    activeMonitorLimit: 150,
    highlight: false,
    blurb: "High-volume automation and agencies running continuous checks.",
    stripePriceEnvKey: "STRIPE_PRICE_ID_BEST",
    stripePriceEnvKeyAnnual: "STRIPE_PRICE_ID_BEST_ANNUAL",
  },
};

/** Price charged once per year on the annual plan (monthly rate × months charged). */
export function annualPriceUsd(plan: PaidPlanDefinition): number {
  return plan.priceUsd * ANNUAL_MONTHS_CHARGED;
}

/** Map an inbound `interval` query param to a known billing interval. */
export function resolveBillingInterval(intervalParam: string | null | undefined): BillingInterval {
  return intervalParam === "annual" ? "annual" : "monthly";
}

/** Render/checkout order for the paid tiers, cheapest to most expensive. */
export const PAID_PLAN_ORDER: readonly PaidPlanId[] = ["good", "better", "best"] as const;

/** Fallback tier for legacy `plan=paid` links and unrecognized plan params. */
export const DEFAULT_PAID_PLAN_ID: PaidPlanId = "good";

/** Capabilities every paid tier includes; differentiation is monitors + run quota only. */
export const PAID_PLAN_SHARED_FEATURES = [
  "All paid research tools: pricing, market, competitor, hypothesis, and compliance checks",
  "Unlimited verify_claim",
  "Saved monitors with hourly, daily, or weekly schedules",
  "Evidence history and generated change reports",
  "Webhook change notifications",
  "Read-only share links",
] as const;

/**
 * Map an inbound `plan` query param to a known paid tier.
 * Legacy `paid` links and any unknown value resolve to the entry tier.
 */
export function resolvePaidPlanId(planParam: string | null | undefined): PaidPlanId {
  if (planParam === "good" || planParam === "better" || planParam === "best") {
    return planParam;
  }
  return DEFAULT_PAID_PLAN_ID;
}
export const ANALYTICS_EVENT_NAMES = [
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
] as const;

export interface AnalyticsEventRow {
  eventName: string;
  tool: string | null;
  tier: string | null;
  paymentMethod: string | null;
  status: string | null;
  clientHash: string | null;
  referralCode?: string | null;
  ts: number;
}

/** Synthetic marketplace/auth probes must not be treated as product usage. */
export function isSyntheticToolName(tool: string | null | undefined): boolean {
  return typeof tool === "string" && tool.startsWith("__verifymcp_auth_probe_") && tool.endsWith("__");
}

/** Known health checks and maintainer smoke tests are operational traffic, not product adoption. */
export function isSyntheticMcpClientIdentifier(clientId: string | null | undefined): boolean {
  if (!clientId) return false;
  const normalized = clientId.toLowerCase();
  return [
    "activation-test",
    "ground-truth-usage-test",
    "usage-query",
    "usage-query-xpay",
    "ground-truth-quickstart",
    "verifymcp",
    "health-check",
    "smoke-test",
  ].some(marker => normalized.includes(marker));
}

interface EndpointVerdictInput {
  accessible: boolean;
  status?: number;
  authRequired?: boolean;
  rateLimited?: boolean;
  redirected?: boolean;
  error?: string;
}

export function getEndpointVerdict(input: EndpointVerdictInput): {
  verdict: VerificationVerdict;
  summary: string;
  recommended_action: RecommendedAction;
} {
  if (input.error || (!input.accessible && input.status === undefined)) {
    return {
      verdict: "FAIL",
      summary: input.error ? `The endpoint could not be checked: ${input.error}` : "The endpoint did not return a usable response.",
      recommended_action: "stop",
    };
  }

  if (input.status !== undefined && input.status >= 500) {
    return {
      verdict: "FAIL",
      summary: `The endpoint responded with server error HTTP ${input.status}.`,
      recommended_action: "stop",
    };
  }

  if (input.status !== undefined && input.status >= 400 && !input.authRequired && !input.rateLimited) {
    return {
      verdict: "FAIL",
      summary: `The endpoint responded with HTTP ${input.status}; do not rely on it without resolving that response.`,
      recommended_action: "stop",
    };
  }

  if (input.authRequired || input.rateLimited || input.redirected || !input.accessible) {
    const reason = input.authRequired
      ? "it requires authentication"
      : input.rateLimited
        ? "it is rate-limiting requests"
        : input.redirected
          ? "it redirected the request"
          : `it returned HTTP ${input.status ?? "an unexpected status"}`;
    return {
      verdict: "WARN",
      summary: `The endpoint responded, but ${reason}.`,
      recommended_action: "proceed_with_caution",
    };
  }

  return {
    verdict: "PASS",
    summary: `The endpoint responded successfully with HTTP ${input.status ?? 200}.`,
    recommended_action: "proceed",
  };
}

export function getSecurityHeaderVerdict(input: {
  accessible: boolean;
  https: boolean;
  status?: number;
  score?: "strong" | "moderate" | "weak";
  error?: string;
}): {
  verdict: VerificationVerdict;
  summary: string;
  recommended_action: RecommendedAction;
} {
  if (!input.accessible || input.error) {
    return {
      verdict: "FAIL",
      summary: input.error ? `Security headers could not be inspected: ${input.error}` : "Security headers could not be inspected because the response was unavailable.",
      recommended_action: "stop",
    };
  }

  if (input.status !== undefined && input.status >= 500) {
    return {
      verdict: "FAIL",
      summary: `The response returned server error HTTP ${input.status}; header presence does not make the resource usable.`,
      recommended_action: "stop",
    };
  }

  if (input.status !== undefined && input.status >= 400) {
    return {
      verdict: "WARN",
      summary: `The response returned HTTP ${input.status}; header observations are available, but the resource response needs review.`,
      recommended_action: "proceed_with_caution",
    };
  }

  if (!input.https || input.score !== "strong") {
    const reason = !input.https
      ? "the URL was not fetched over HTTPS"
      : `the tracked header baseline is ${input.score ?? "unknown"}`;
    return {
      verdict: "WARN",
      summary: `The response is reachable, but ${reason}; this is not a security guarantee.`,
      recommended_action: "proceed_with_caution",
    };
  }

  return {
    verdict: "PASS",
    summary: "The response used HTTPS and included a strong set of tracked security headers; this is a header check, not a full security review.",
    recommended_action: "proceed",
  };
}

export function normalizeAnalyticsEventName(eventName: string): string {
  switch (eventName) {
    case "tool_call_received":
      return "tool_call_started";
    case "home_page":
      return "homepage_view";
    case "pricing_page":
      return "pricing_view";
    case "checkout_start":
      return "checkout_started";
    case "mcp_tool_call":
      return "tool_call_started";
    default:
      return eventName;
  }
}

export function calculateRollingUsageMetrics(events: AnalyticsEventRow[], now = Date.now()) {
  const cutoff7 = now - 7 * 24 * 60 * 60 * 1000;
  const cutoff30 = now - 30 * 24 * 60 * 60 * 1000;
  const isToolStart = (event: AnalyticsEventRow) =>
    normalizeAnalyticsEventName(event.eventName) === "tool_call_started" && !isSyntheticToolName(event.tool);
  const hasPaidEventFor = (event: AnalyticsEventRow, rows: AnalyticsEventRow[]) => rows.some(candidate =>
    normalizeAnalyticsEventName(candidate.eventName) === "paid_tool_call" &&
    candidate.clientHash === event.clientHash &&
    candidate.tool === event.tool &&
    Math.abs(candidate.ts - event.ts) <= 5_000,
  );
  const isPaidCall = (event: AnalyticsEventRow) => {
    const eventName = normalizeAnalyticsEventName(event.eventName);
    return eventName === "paid_tool_call" ||
      (isToolStart(event) && (event.tier === "team" || event.tier === "x402") && !hasPaidEventFor(event, events));
  };
  const inWindow = (cutoff: number) => events.filter(event => event.ts >= cutoff && event.ts <= now);
  const uniqueClients = (rows: AnalyticsEventRow[]) => new Set(rows.map(event => event.clientHash).filter(Boolean)).size;
  const toolRows = (rows: AnalyticsEventRow[]) => rows.filter(isToolStart);
  const connectionRows = (rows: AnalyticsEventRow[]) => rows.filter(event => {
    const eventName = normalizeAnalyticsEventName(event.eventName);
    return eventName === "mcp_connection" || isToolStart(event);
  });
  const summarize = (rows: AnalyticsEventRow[]) => {
    const calls = toolRows(rows);
    const paidCalls = rows.filter(isPaidCall);
    const monitorPreviewRows = rows.filter(event =>
      (isToolStart(event) && event.tool === "preview_monitor") ||
      normalizeAnalyticsEventName(event.eventName) === "monitor_preview_completed",
    );
    const authorizedMonitorRows = calls.filter(event =>
      Boolean(event.tool) &&
      (MONITOR_TOOLS as readonly string[]).includes(event.tool as string) &&
      (event.tier === "team" || event.tier === "free_monitor"),
    );
    const freeMonitorRows = calls.filter(event =>
      Boolean(event.tool) &&
      (MONITOR_TOOLS as readonly string[]).includes(event.tool as string) &&
      event.tier === "free_monitor",
    );
    return {
      uniqueMcpClients: uniqueClients(connectionRows(rows)),
      uniqueToolUsers: uniqueClients(calls),
      toolCalls: calls.length,
      paidUsers: uniqueClients(paidCalls),
      paidCalls: paidCalls.length,
      paymentRequiredEvents: rows.filter(event => normalizeAnalyticsEventName(event.eventName) === "payment_required").length,
      paidIntentEvents: rows.filter(event => normalizeAnalyticsEventName(event.eventName) === "paid_intent").length,
      monitorIntentEvents: rows.filter(event => normalizeAnalyticsEventName(event.eventName) === "monitor_intent").length,
      monitorPreviewUsers: uniqueClients(monitorPreviewRows),
      authorizedMonitorUsers: uniqueClients(authorizedMonitorRows),
      freeMonitorUsers: uniqueClients(freeMonitorRows),
      persistentMonitorCreators: uniqueClients(rows.filter(event => normalizeAnalyticsEventName(event.eventName) === "persistent_monitor_created")),
      persistentMonitorFirstRunUsers: uniqueClients(rows.filter(event => normalizeAnalyticsEventName(event.eventName) === "persistent_monitor_first_run")),
      qualifiedActivationUsers: uniqueClients([...monitorPreviewRows, ...authorizedMonitorRows]),
      firstSuccessfulToolCallUsers: uniqueClients(rows.filter(event => normalizeAnalyticsEventName(event.eventName) === "first_successful_tool_call")),
      referredToolCalls: calls.filter(event => Boolean(event.referralCode)).length,
      referredFirstSuccessfulToolCallUsers: uniqueClients(rows.filter(event => normalizeAnalyticsEventName(event.eventName) === "referred_first_successful_tool_call")),
    };
  };

  const last7Days = summarize(inWindow(cutoff7));
  const last30Rows = inWindow(cutoff30);
  const last30Days = summarize(last30Rows);
  const daysByClient = new Map<string, Set<string>>();
  for (const event of toolRows(last30Rows)) {
    if (!event.clientHash) continue;
    const days = daysByClient.get(event.clientHash) ?? new Set<string>();
    days.add(new Date(event.ts).toISOString().slice(0, 10));
    daysByClient.set(event.clientHash, days);
  }
  const repeatUsers = [...daysByClient.values()].filter(days => days.size >= 2).length;
  const referredDaysByClient = new Map<string, Set<string>>();
  for (const event of toolRows(last30Rows).filter(row => Boolean(row.referralCode))) {
    if (!event.clientHash) continue;
    const days = referredDaysByClient.get(event.clientHash) ?? new Set<string>();
    days.add(new Date(event.ts).toISOString().slice(0, 10));
    referredDaysByClient.set(event.clientHash, days);
  }
  const referredRepeatUsers = [...referredDaysByClient.values()].filter(days => days.size >= 2).length;
  const byToolLast30Days = last30Rows
    .filter(event => isToolStart(event) && Boolean(event.tool))
    .reduce<Record<string, number>>((result, event) => {
      result[event.tool as string] = (result[event.tool as string] ?? 0) + 1;
      return result;
    }, {});

  return {
    last7Days,
    last30Days: {
      ...last30Days,
      repeatUsers,
      referredRepeatUsers,
      firstPaidCallUsers: last30Days.paidUsers,
      conversionToFirstPaidCall: last30Days.uniqueToolUsers === 0
        ? 0
        : +(last30Days.paidUsers / last30Days.uniqueToolUsers).toFixed(4),
      byTool: byToolLast30Days,
    },
  };
}

export function normalizeCheckoutFunnel(checkoutStarted: number, checkoutCompleted: number) {
  const rawStarts = Math.max(0, checkoutStarted);
  const completed = Math.max(0, checkoutCompleted);
  return {
    checkoutStarts: Math.max(rawStarts, completed),
    checkoutStartsRaw: rawStarts,
    checkoutCompleted: completed,
    checkoutStartCoverage: completed === 0 ? 1 : +(rawStarts / completed).toFixed(4),
  };
}

export function getMcpClientIdentifier(
  request: Request,
  body?: { params?: { clientInfo?: { name?: string; version?: string } } } | null,
): string | null {
  const headerValue = request.headers.get("x-mcp-client-id")?.trim() ||
    request.headers.get("mcp-client-id")?.trim() ||
    request.headers.get("mcp-client-name")?.trim();
  if (headerValue) return headerValue.slice(0, 160);

  const clientInfo = body?.params?.clientInfo;
  if (clientInfo?.name?.trim()) {
    const version = clientInfo.version?.trim();
    return `${clientInfo.name.trim()}${version ? `/${version}` : ""}`.slice(0, 160);
  }

  return null;
}
