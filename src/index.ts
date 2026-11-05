import { getWatchDashboardHtml } from "./watch-dashboard";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HTTPFacilitatorClient, x402ResourceServer as X402ResourceServer } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
// Import types from the types module
import type { PaymentPayload as X402PaymentPayload, PaymentRequirements as X402PaymentRequirements } from "@x402/core/types";
import { z } from "zod";
import {
  ANALYTICS_EVENT_NAMES,
  FREE_MONITOR_LIMIT,
  FREE_MONITOR_MONTHLY_QUOTA,
  FREE_TOOLS,
  MONITOR_TOOLS,
  PAID_TOOLS,
  PAID_PLANS,
  PAID_PLAN_ORDER,
  PAID_PLAN_SHARED_FEATURES,
  resolvePaidPlanId,
  resolveBillingInterval,
  annualPriceUsd,
  ANNUAL_MONTHS_CHARGED,
  type PaidPlanId,
  SERVER_VERSION,
  calculateRollingUsageMetrics,
  getEndpointVerdict,
  getMcpClientIdentifier,
  getSecurityHeaderVerdict,
  isSyntheticMcpClientIdentifier,
  isSyntheticToolName,
  normalizeAnalyticsEventName,
  normalizeCheckoutFunnel,
  type AnalyticsEventRow,
  type RecommendedAction,
  type VerificationVerdict,
} from "./product-contract";
// --- Environment bindings ---
type WorkerProcess = {
  env?: Record<string, string | undefined>;
  platform?: string;
};

const workerProcess = (globalThis as typeof globalThis & { process?: WorkerProcess }).process;

interface Env extends Cloudflare.Env {
  API_KEYS: KVNamespace;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_ID: string;
  STRIPE_PRICE_ID_BETTER: string;
  STRIPE_PRICE_ID_BEST: string;
  // Annual Stripe price IDs (optional). When present, the pricing page shows an
  // annual option (2 months free) and /api/checkout?interval=annual uses them.
  STRIPE_PRICE_ID_ANNUAL?: string;
  STRIPE_PRICE_ID_BETTER_ANNUAL?: string;
  STRIPE_PRICE_ID_BEST_ANNUAL?: string;
  // Optional bearer token that enables the POST /admin/prune maintenance
  // endpoint (shrinks the analytics Durable Object by deleting old rows).
  ADMIN_TOKEN?: string;
  MCP_OBJECT: DurableObjectNamespace<GroundTruthMCP>;
  // Email change-alerts via Resend (optional). When RESEND_API_KEY is set,
  // monitors may use a `mailto:` destination and receive email alerts.
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  // Cloudflare Monetization Gateway with x402
  MONETIZATION_GATEWAY: boolean;
  X402_NETWORK: string;
  X402_RECIPIENT: string;
  X402_FACILITATOR_URL: string;
}

// --- Cache types ---
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHEABLE_BODY_BYTES = 512 * 1024;

// --- Remote Telemetry Config ---
const TELEMETRY_ENDPOINT = workerProcess?.env?.GROUND_TRUTH_TELEMETRY_ENDPOINT;
const TELEMETRY_ENABLED = workerProcess?.env?.GROUND_TRUTH_TELEMETRY === "true" && Boolean(TELEMETRY_ENDPOINT);
// --- Free tier tools ---
const FREE_MONTHLY_LIMIT = 100;
const FREE_VERIFY_CLAIM_LIMIT = 5;

// --- Paid tiers: Good / Better / Best (see PAID_PLANS in product-contract) ---
// The entry ("good") tier supplies the defaults used wherever a record predates
// tiering or omits explicit entitlements.
const PAID_MONTHLY_LIMIT = PAID_PLANS.good.monthlyQuota;
const PAID_PLAN_PRICE_USD = PAID_PLANS.good.priceUsd;
const PAID_ACTIVE_MONITOR_LIMIT = PAID_PLANS.good.activeMonitorLimit;
const SHARED_REPORT_MAX_TTL_DAYS = 30;
const MONTHLY_PRICE_STR = `from $${PAID_PLANS.good.priceUsd}/mo`;
const CHECKOUT_URL = "https://ground-truth-mcp.anishdasmail.workers.dev/pricing";

// Paid tools unlocked by any paid tier subscription
const PUBLIC_APP_ORIGIN = "https://ground-truth-mcp.anishdasmail.workers.dev";
const SERVER_CARD_ICON_PATH = "/icon.svg";
const SERVER_CARD_DESCRIPTION =
  "Competitive change evidence for B2B SaaS teams and agents. Create three persistent daily monitors free, then add hourly checks, " +
  "more sources, evidence history, alerts, and agent-readable change reports for pricing, packaging, APIs, and public claims.";

// Cloudflare Monetization Gateway with x402 Stablecoin Payments
const X402_PAYMENT_ENABLED = workerProcess?.env?.GROUND_TRUTH_X402_ENABLED !== "false";
const X402_NETWORK_CONFIG = workerProcess?.env?.GROUND_TRUTH_X402_NETWORK ?? "base-sepolia";
const X402_RECIPIENT_CONFIG = workerProcess?.env?.GROUND_TRUTH_X402_RECIPIENT ?? "0xB04BD750b67e7b00c95eAC8995eb9F8441309196";
const X402_FACILITATOR_URL_CONFIG = workerProcess?.env?.GROUND_TRUTH_X402_FACILITATOR_URL ?? 
  (X402_NETWORK_CONFIG === "base" ? "https://api.cdp.coinbase.com/platform/v2/x402" : "https://x402.org/facilitator");

// Normalize network to CAIP-2 format
function normalizeX402Network(network: string): `${string}:${string}` {
  switch (network) {
    case "base-sepolia":
      return "eip155:84532";
    case "base":
      return "eip155:8453";
    case "ethereum":
      return "eip155:1";
    case "sepolia":
      return "eip155:11155111";
    default:
      return network as `${string}:${string}`;
  }
}

// Per-tool x402 pricing in USD for Cloudflare Monetization Gateway
const X402_TOOL_PRICES_USD = {
  check_pricing: 0.01,
  verify_claim: 0.01,
  estimate_market: 0.01,
  compare_competitors: 0.025,
  compare_pricing_pages: 0.035,
  test_hypothesis: 0.05,
  assess_compliance_posture: 0.06,
} as const;

// Cloudflare Monetization Gateway x402 Resource Server
let x402ResourceServer: X402ResourceServer | null = null;

if (X402_PAYMENT_ENABLED) {
  const normalizedNetwork = normalizeX402Network(X402_NETWORK_CONFIG);
  x402ResourceServer = new X402ResourceServer(
    new HTTPFacilitatorClient({ url: X402_FACILITATOR_URL_CONFIG }),
  );
  registerExactEvmScheme(x402ResourceServer);
}

// Use imported types from @x402/core/server

const x402RequirementsCache = new Map<string, Promise<X402PaymentRequirements[]>>();
const REPUTABLE_CRAWLER_USER_AGENTS = [
  "OAI-SearchBot",
  "GPTBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Googlebot",
  "Bingbot",
  "CCBot",
] as const;

const SERVER_CARD_READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
export const SERVER_CARD_TOOLS = [
  {
    name: "check_endpoint",
    title: "Preflight Endpoint Check",
    description:
      "Preflight an unfamiliar public URL or API before an AI agent relies on it. " +
      "Returns a PASS/WARN/FAIL verdict with HTTP status, content type, timing, redirect, auth, rate-limit, and response evidence. " +
      "A PASS proves only that this fetch succeeded at check time; it does not validate authenticated flows or business logic.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description:
            "Public http(s) URL or bare domain to probe. Bare domains like " +
            "google.com are normalized to https:// automatically.",
        },
      },
      required: ["url"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        inputUrl: {
          type: "string",
          description:
            "Original user input when normalization changed it, for example " +
            "when https:// was added.",
        },
        url: {
          type: "string",
          description: "Normalized URL that was actually fetched.",
        },
        accessible: {
          type: "boolean",
          description: "True when the endpoint returned a 2xx HTTP status.",
        },
        status: {
          type: "integer",
          description:
            "HTTP status code returned by the endpoint, when a response was received.",
        },
        contentType: {
          type: ["string", "null"],
          description: "Response Content-Type header, if present.",
        },
        responseTimeMs: {
          type: "integer",
          description: "Elapsed request time in milliseconds.",
        },
        authRequired: {
          type: "boolean",
          description:
            "True when the server responded with 401 or 403, which usually means credentials are required.",
        },
        rateLimited: {
          type: "boolean",
          description: "True when the server responded with 429 Too Many Requests.",
        },
        sampleResponse: {
          type: "string",
          description:
            "First 1,000 characters of the response body for quick inspection. " +
            "Use this as a debugging hint only; it may be truncated and should not be treated as a complete page capture.",
        },
        error: {
          type: "string",
          description: "Validation or network error when the request could not be completed.",
        },
        verdict: {
          type: "string",
          enum: ["PASS", "WARN", "FAIL"],
          description: "Operational preflight verdict. It is evidence for an agent decision, not a security guarantee.",
        },
        summary: {
          type: "string",
          description: "Short explanation of the verdict.",
        },
        evidence: {
          type: "object",
          description: "Structured observations used to produce the verdict.",
        },
        recommended_action: {
          type: "string",
          enum: ["proceed", "proceed_with_caution", "stop"],
          description: "Suggested next step based only on observed response behavior.",
        },
        next_step: {
          type: "string",
          description: "Follow-up for turning a useful one-time check into a free monitor preview.",
        },
      },
      required: ["url", "accessible"],
    },
    annotations: SERVER_CARD_READ_ONLY_ANNOTATIONS,
  },
  {
    name: "preflight_endpoint",
    title: "Endpoint Preflight",
    description:
      "Run the two highest-value preflight checks for an unfamiliar URL or API: reachability/response behavior and security-related HTTP headers. " +
      "Returns one combined PASS/WARN/FAIL verdict plus the evidence from both checks. It does not prove that a service is safe, authenticated, or correct.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description: "Public http(s) URL or bare domain to preflight.",
        },
      },
      required: ["url"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" },
        verdict: { type: "string", enum: ["PASS", "WARN", "FAIL"] },
        summary: { type: "string" },
        evidence: { type: "object" },
        recommended_action: { type: "string", enum: ["proceed", "proceed_with_caution", "stop"] },
        next_step: {
          type: "string",
          description: "A concrete follow-up for the agent after reviewing the evidence.",
        },
      },
      required: ["url", "verdict", "summary", "evidence", "recommended_action", "next_step"],
    },
    annotations: SERVER_CARD_READ_ONLY_ANNOTATIONS,
  },
  {
    name: "preview_monitor",
    title: "Preview Source Monitor",
    description:
      "Call this free tool when a source should remain trustworthy over time. It captures a live baseline for a public endpoint, pricing page, package, vendor claim, or keyword watch without creating an account. " +
      "Use the returned baseline to show the user what Ground Truth would monitor, then offer one of three free persistent monitors.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target_type: {
          type: "string",
          enum: ["url", "endpoint", "pricing_page", "package", "vendor_claim", "custom_prompt"],
        },
        target_value: { type: "string" },
        instructions: { type: "string" },
      },
      required: ["target_type", "target_value"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["baseline_ready", "error"] },
        target_type: { type: "string" },
        target_value: { type: "string" },
        baseline: {},
        evidence: { type: "array", items: { type: "string" } },
        confidence: { type: "number" },
        recommended_schedule: { type: "string", enum: ["hourly", "daily", "weekly"] },
        agent_next_action: { type: "string" },
        persistence: { type: "string", enum: ["preview_only"] },
        upgrade_tool: { type: "string", enum: ["create_monitor"] },
        pricing_url: { type: "string" },
        error: { type: "string" },
      },
      required: ["status", "target_type", "target_value", "evidence", "recommended_schedule", "agent_next_action", "persistence", "upgrade_tool", "pricing_url"],
    },
    annotations: SERVER_CARD_READ_ONLY_ANNOTATIONS,
  },
  {
    name: "estimate_market",
    title: "Package Market Search",
    description:
      "Call this when you have a package category or search phrase and need " +
      "live npm or PyPI result counts before calling a market empty, niche, or crowded.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            "Short registry search phrase to evaluate, for example 'mcp memory server' or 'edge orm'.",
        },
        registry: {
          type: "string",
          enum: ["npm", "pypi"],
          description:
            "Registry to search. Use 'npm' for JavaScript ecosystems and 'pypi' for Python ecosystems.",
        },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Search phrase that was evaluated." },
        registry: {
          type: "string",
          enum: ["npm", "pypi"],
          description: "Registry that was searched.",
        },
        totalResults: {
          type: ["integer", "null"],
          description: "Total number of matching packages reported by the registry search.",
        },
        topResults: {
          type: "array",
          description:
            "Representative top search matches that help interpret the market count.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", description: "Package name returned by the registry." },
              description: {
                type: "string",
                description: "Short package summary from registry metadata.",
              },
              version: {
                type: "string",
                description: "Latest version string returned in the result payload.",
              },
              score: {
                type: "string",
                description: "Registry relevance score when npm provides one.",
              },
            },
            required: ["name", "description", "version"],
          },
        },
      },
      required: ["query", "registry", "totalResults", "topResults"],
    },
    annotations: SERVER_CARD_READ_ONLY_ANNOTATIONS,
  },
  {
    name: "check_pricing",
    title: "Pricing Page Scan",
    description:
      "Call this when you already have a public pricing URL and need visible " +
      "price strings, plan-name hints, and free/free-trial signals before quoting them.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description:
            "Public pricing or plans URL to analyze. Prefer the specific pricing page rather than a generic homepage.",
        },
      },
      required: ["url"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", description: "Pricing page that was analyzed." },
        cached: {
          type: "boolean",
          description: "True when the page body came from the 5-minute cache.",
        },
        pricesFound: {
          type: "array",
          description:
            "Distinct price-like strings extracted from the page text.",
          items: { type: "string" },
        },
        plansDetected: {
          type: "array",
          description:
            "Lowercased heuristic plan labels detected from the page text.",
          items: { type: "string" },
        },
        hasFreeOption: {
          type: "boolean",
          description: "True when the page contains signals that a free plan or $0 option exists.",
        },
        hasFreeTrial: {
          type: "boolean",
          description: "True when the page contains signals that a free trial exists.",
        },
        pageLength: {
          type: "integer",
          description: "Size of the fetched page body in characters.",
        },
        error: {
          type: "string",
          description: "Fetch or parsing error when the pricing page could not be analyzed.",
        },
      },
      required: ["url"],
    },
    annotations: SERVER_CARD_READ_ONLY_ANNOTATIONS,
  },
  {
    name: "inspect_security_headers",
    title: "Security Header Inspection",
    description:
      "Inspect security-related HTTP response headers for an unfamiliar public URL before an agent trusts or recommends it. " +
      "Use this to identify missing or weak HSTS, CSP, framing, referrer, permissions, and cross-origin headers. " +
      "It reports observable configuration only and does not prove that a site is secure or vulnerability-free.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description:
            "Public http(s) URL or bare domain to inspect. Bare domains are normalized to https:// automatically.",
        },
      },
      required: ["url"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        inputUrl: {
          type: "string",
          description: "Original user input when normalization changed it.",
        },
        url: { type: "string", description: "Normalized URL that was fetched." },
        accessible: {
          type: "boolean",
          description: "True when the endpoint returned an HTTP response.",
        },
        status: {
          type: "integer",
          description: "HTTP status code returned by the endpoint.",
        },
        https: {
          type: "boolean",
          description: "True when the normalized URL used https.",
        },
        presentCount: {
          type: "integer",
          description: "Number of tracked security headers that were present.",
        },
        score: {
          type: "string",
          enum: ["strong", "moderate", "weak"],
          description:
            "Heuristic security-header score based on how many tracked headers were present.",
        },
        headers: {
          type: "object",
          additionalProperties: false,
          description: "Tracked response headers and their raw values when present.",
          properties: {
            strictTransportSecurity: { type: ["string", "null"] },
            contentSecurityPolicy: { type: ["string", "null"] },
            xFrameOptions: { type: ["string", "null"] },
            referrerPolicy: { type: ["string", "null"] },
            permissionsPolicy: { type: ["string", "null"] },
            xContentTypeOptions: { type: ["string", "null"] },
            crossOriginOpenerPolicy: { type: ["string", "null"] },
            crossOriginResourcePolicy: { type: ["string", "null"] },
          },
        },
        missingRecommended: {
          type: "array",
          items: { type: "string" },
          description: "Tracked headers that were not present on the response.",
        },
        error: {
          type: "string",
          description: "Validation or network error when the request could not be completed.",
        },
        verdict: {
          type: "string",
          enum: ["PASS", "WARN", "FAIL"],
          description: "Header preflight verdict based on reachability, HTTPS, and tracked header presence.",
        },
        summary: {
          type: "string",
          description: "Short explanation of the header verdict.",
        },
        evidence: {
          type: "object",
          description: "Structured header observations used to produce the verdict.",
        },
        recommended_action: {
          type: "string",
          enum: ["proceed", "proceed_with_caution", "stop"],
          description: "Suggested next step; not a security guarantee.",
        },
        next_step: {
          type: "string",
          description: "Follow-up for sources whose security posture should be checked repeatedly.",
        },
      },
      required: ["url", "accessible", "https"],
    },
    annotations: SERVER_CARD_READ_ONLY_ANNOTATIONS,
  },
  {
    name: "compare_pricing_pages",
    title: "Pricing Page Comparison",
    description:
      "Call this when you need to compare two to five public pricing pages " +
      "before making a competitive pricing or packaging claim.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        pages: {
          type: "array",
          minItems: 2,
          maxItems: 5,
          description: "Two to five named pricing pages to compare side by side.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: {
                type: "string",
                description: "Short vendor or product label to use in the comparison output.",
              },
              url: {
                type: "string",
                description: "Public pricing page URL for that vendor or product.",
              },
            },
            required: ["name", "url"],
          },
        },
      },
      required: ["pages"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        pages: {
          type: "array",
          description: "Per-page pricing signals returned in input order.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              url: {
                type: "string",
                description: "Pricing page URL that was fetched for this named vendor.",
              },
              cached: {
                type: "boolean",
                description: "True when this page body came from the 5-minute cache.",
              },
              pricesFound: {
                type: "array",
                description:
                  "Distinct price-like strings extracted from this page. These are page-level hints and are not mapped to specific plans.",
                items: { type: "string" },
              },
              plansDetected: {
                type: "array",
                description:
                  "Lowercased heuristic plan labels detected on this page, such as free, pro, team, or enterprise.",
                items: { type: "string" },
              },
              hasFreeOption: {
                type: "boolean",
                description:
                  "True when this page contains visible text suggesting a free plan, free tier, or $0 option.",
              },
              hasFreeTrial: {
                type: "boolean",
                description:
                  "True when this page contains visible text suggesting a free trial.",
              },
              pageLength: {
                type: "integer",
                description: "Size of this fetched page body in characters.",
              },
              error: {
                type: "string",
                description:
                  "Fetch or parsing error for this specific pricing page when it could not be analyzed.",
              },
            },
            required: ["name", "url"],
          },
        },
        summary: {
          type: "object",
          additionalProperties: false,
          description: "Aggregate counts across all compared pricing pages.",
          properties: {
            pagesCompared: {
              type: "integer",
              description: "Number of pricing pages included in the comparison.",
            },
            pagesWithVisiblePrices: {
              type: "integer",
              description:
                "Number of pages where at least one price-like string was detected.",
            },
            pagesWithFreeOption: {
              type: "integer",
              description:
                "Number of pages with page-level text suggesting a free plan, free tier, or $0 option.",
            },
            pagesWithFreeTrial: {
              type: "integer",
              description:
                "Number of pages with page-level text suggesting a free trial.",
            },
          },
          required: [
            "pagesCompared",
            "pagesWithVisiblePrices",
            "pagesWithFreeOption",
            "pagesWithFreeTrial",
          ],
        },
      },
      required: ["pages", "summary"],
    },
    annotations: SERVER_CARD_READ_ONLY_ANNOTATIONS,
  },
  {
    name: "compare_competitors",
    title: "Named Package Comparison",
    description:
      "Call this when you already know exact package names and need live npm " +
      "or PyPI metadata side by side.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        packages: {
          type: "array",
          minItems: 2,
          maxItems: 10,
          description:
            "Two to ten exact package names from the same registry. Use exact registry names, not search phrases.",
          items: { type: "string" },
        },
        registry: {
          type: "string",
          enum: ["npm", "pypi"],
          description:
            "Registry that all package names belong to. Returned metadata fields differ slightly between npm and PyPI.",
        },
      },
      required: ["packages"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        packages: {
          type: "array",
          items: { type: "string" },
          description: "Package names that were requested for comparison.",
        },
        registry: {
          type: "string",
          enum: ["npm", "pypi"],
          description: "Registry used for all comparisons.",
        },
        comparisons: {
          type: "array",
          description: "Per-package lookup results returned in input order.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              found: { type: "boolean" },
              description: { type: "string" },
              latestVersion: { type: "string" },
              license: { type: ["string", "null"] },
              lastPublished: { type: ["string", "null"] },
              created: { type: ["string", "null"] },
              totalVersions: { type: "integer" },
              author: { type: "string" },
              keywords: { type: "array", items: { type: "string" } },
              cached: { type: "boolean" },
              error: { type: "string" },
            },
            required: ["name", "found"],
          },
        },
      },
      required: ["packages", "registry", "comparisons"],
    },
    annotations: SERVER_CARD_READ_ONLY_ANNOTATIONS,
  },
  {
    name: "verify_claim",
    title: "Claim Support Check",
    description:
      "Verify a factual claim against specific public evidence URLs before an agent repeats it or acts on it. " +
      "The tool checks whether the supplied keywords appear in each fetched source and reports per-source evidence. " +
      "It does not perform open-ended search, semantic contradiction analysis, or prove that a claim is true when a page is silent; choose direct evidence URLs and interpret the result as a support signal.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        claim: {
          type: "string",
          description:
            "Plain-language claim to verify, for example 'AWS Business support includes 24/7 phone support'.",
        },
        evidence_urls: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          description:
            "One to ten public documentation, pricing, policy, or support URLs that are likely to contain direct evidence for the claim.",
          items: { type: "string" },
        },
        keywords: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          description:
            "Keywords or short phrases that should appear on supporting pages.",
          items: { type: "string" },
        },
      },
      required: ["claim", "evidence_urls", "keywords"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        claim: { type: "string", description: "Claim that was evaluated." },
        sources: {
          type: "array",
          description: "Per-source evidence results.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              url: { type: "string" },
              accessible: { type: "boolean" },
              cached: { type: "boolean" },
              keywordsMatched: { type: "array", items: { type: "string" } },
              keywordsTotal: { type: "integer" },
              matchRatio: { type: "number" },
              supports: { type: "boolean" },
              error: { type: "string" },
            },
            required: ["url", "accessible", "supports"],
          },
        },
        verdict: {
          type: "object",
          additionalProperties: false,
          description: "Aggregate verdict across all supplied sources.",
          properties: {
            supporting: { type: "integer" },
            contradicting: { type: "integer" },
            total: { type: "integer" },
            confidence: { type: "number" },
            summary: {
              type: "string",
              enum: ["CONFIRMED", "UNCONFIRMED", "LIKELY TRUE", "LIKELY FALSE"],
            },
          },
          required: ["supporting", "contradicting", "total", "confidence", "summary"],
        },
      },
      required: ["claim", "sources", "verdict"],
    },
    annotations: SERVER_CARD_READ_ONLY_ANNOTATIONS,
  },
  {
    name: "assess_compliance_posture",
    title: "Compliance Signal Scan",
    description:
      "Call this to scan a public security, trust, compliance, or legal page " +
      "for common enterprise signals before repeating a vendor posture claim.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description: "Public trust, security, compliance, or policy URL to scan.",
        },
      },
      required: ["url"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", description: "Compliance or trust page that was analyzed." },
        cached: {
          type: "boolean",
          description: "True when the page body came from the 5-minute cache.",
        },
        matchedSignals: {
          type: "array",
          items: { type: "string" },
          description: "Signal names that were detected on the page.",
        },
        signals: {
          type: "object",
          additionalProperties: false,
          description:
            "Boolean scan results for common enterprise compliance and security signals.",
          properties: {
            soc2: {
              type: "boolean",
              description:
                "True when the page references SOC 2 or SOC2 compliance language.",
            },
            iso27001: {
              type: "boolean",
              description:
                "True when the page references ISO 27001 certification or compliance language.",
            },
            gdpr: {
              type: "boolean",
              description:
                "True when the page references GDPR or the General Data Protection Regulation.",
            },
            hipaa: {
              type: "boolean",
              description:
                "True when the page references HIPAA compliance language.",
            },
            dpa: {
              type: "boolean",
              description:
                "True when the page references a data processing agreement or DPA.",
            },
            subprocessorList: {
              type: "boolean",
              description:
                "True when the page references subprocessors or a subprocessor list.",
            },
            sso: {
              type: "boolean",
              description:
                "True when the page references SSO or single sign-on.",
            },
            scim: {
              type: "boolean",
              description:
                "True when the page references SCIM provisioning.",
            },
            encryption: {
              type: "boolean",
              description:
                "True when the page references encryption, data encrypted at rest, or data encrypted in transit.",
            },
            dataResidency: {
              type: "boolean",
              description:
                "True when the page references data residency, data regions, or regional storage controls.",
            },
          },
          required: [
            "soc2",
            "iso27001",
            "gdpr",
            "hipaa",
            "dpa",
            "subprocessorList",
            "sso",
            "scim",
            "encryption",
            "dataResidency",
          ],
        },
        pageLength: { type: "integer", description: "Size of the fetched page body in characters." },
        error: {
          type: "string",
          description: "Fetch or parsing error when the page could not be analyzed.",
        },
      },
      required: ["url"],
    },
    annotations: SERVER_CARD_READ_ONLY_ANNOTATIONS,
  },
  {
    name: "test_hypothesis",
    title: "Multi-step Hypothesis Test",
    description:
      "Call this when one hypothesis needs several explicit live checks, such " +
      "as endpoint reachability, npm result counts, or exact page-text matches.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        hypothesis: {
          type: "string",
          description:
            "Claim to test, for example 'there are fewer than 50 MCP email servers on npm'.",
        },
        tests: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          description: "Ordered list of one to ten checks to run.",
          items: {
            type: "object",
            description:
              "One explicit check in the plan. Supported types are endpoint_exists, npm_count_above, npm_count_below, and response_contains.",
          },
        },
      },
      required: ["hypothesis", "tests"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        hypothesis: { type: "string", description: "Hypothesis that was evaluated." },
        tests: {
          type: "array",
          description: "Per-test execution results in input order.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              description: { type: "string" },
              type: {
                type: "string",
                enum: [
                  "endpoint_exists",
                  "npm_count_above",
                  "npm_count_below",
                  "response_contains",
                ],
              },
              passed: { type: "boolean" },
              actual: { type: ["string", "number", "null"] },
            },
            required: ["description", "type", "passed", "actual"],
          },
        },
        verdict: {
          type: "object",
          additionalProperties: false,
          description: "High-level verdict for the hypothesis.",
          properties: {
            passed: { type: "integer" },
            failed: { type: "integer" },
            summary: {
              type: "string",
              enum: ["SUPPORTED", "REFUTED", "PARTIALLY SUPPORTED"],
            },
          },
          required: ["passed", "failed", "summary"],
        },
      },
      required: ["hypothesis", "tests", "verdict"],
    },
    annotations: SERVER_CARD_READ_ONLY_ANNOTATIONS,
  },
  {
    name: "list_resources",
    title: "Server Resource Discovery",
    description:
      "List all available Ground Truth tools and their access tiers. Zero-cost schema discovery. " +
      "Call this to explore what verification tools are available before making a tool call.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        freeTools: {
          type: "array",
          description: "Tools available in the free tier with no API key required.",
          items: { type: "string" },
        },
        paidTools: {
          type: "array",
          description: "Tools requiring team API key or agentic payment.",
          items: { type: "string" },
        },
        monitorTools: {
          type: "array",
          description: "Monitor management tools requiring team API key.",
          items: { type: "string" },
        },
        serverVersion: {
          type: "string",
          description: "Current server version.",
        },
      },
      required: ["freeTools", "paidTools", "monitorTools", "serverVersion"],
    },
    annotations: SERVER_CARD_READ_ONLY_ANNOTATIONS,
  },
];

type ApiKeyRecord = Record<string, unknown> & {
  active?: boolean;
  billingActive?: boolean;
  subscriptionStatus?: string;
  monthlyQuota?: number;
  plan?: PaidPlanId | "free";
  activeMonitorLimit?: number;
  email?: string;
  stripeCustomerId?: string;
  subscriptionId?: string;
  createdAt?: string;
  cancelledAt?: string;
  reactivatedAt?: string;
};

interface UsageRecord {
  month: string;
  subjectType: "free" | "free_verify_claim" | "free_monitor" | "pro";
  subjectId: string;
  total: number;
  byTool: Record<string, number>;
  updatedAt: string;
}

interface TrafficLogRecord {
  kind: string;
  path: string;
  source: string;
  referrer: string | null;
  userAgent: string | null;
  ts: number;
  eventKey?: string | null;
  referralCode?: string | null;
  clientHash?: string | null;
  mcpClientId?: string | null;
  tier?: string | null;
  paymentMethod?: string | null;
  status?: string | null;
  serverVersion?: string;
  deployment?: string;
}

interface UsageEventRecord {
  eventName: string;
  tool: string | null;
  tier: string | null;
  paymentMethod: string | null;
  status: string | null;
  httpStatus: number | null;
  source: string;
  clientHash: string | null;
  ts: number;
  eventKey?: string | null;
  referralCode?: string | null;
  mcpClientId?: string | null;
  serverVersion?: string;
  deployment?: string;
}

interface UsageLimitResult {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  record: UsageRecord | null;
}

interface ProAccessContext {
  apiKey: string;
  apiKeyRecord: ApiKeyRecord;
  limit: number;
  month: string;
  subjectId: string;
  usageKey: string;
}

interface MonitorAccessContext extends ProAccessContext {
  accessTier: "free_monitor" | "team";
  usageSubjectType: "free_monitor" | "pro";
}

interface MonitorRecord {
  id: string;
  owner_key_hash: string;
  name: string;
  target_type: string;
  target_value: string;
  instructions: string | null;
  schedule: string;
  notification_destination: string | null;
  last_run_at: number | null;
  last_run_status: string | null;
  created_at: number;
  updated_at: number;
  active: number;
}

interface MonitorResultRecord {
  id: string;
  monitor_id: string;
  owner_key_hash: string;
  run_at: number;
  status: string;
  changed: number;
  old_value: string | null;
  new_value: string | null;
  confidence: number | null;
  evidence: string | null;
  error_details: string | null;
  raw_metadata: string | null;
}

interface SharedReportRecord {
  id: string;
  monitor_id: string;
  owner_key_hash: string;
  title: string;
  report_json: string;
  created_at: number;
  expires_at: number;
}

interface ReferralRewardRecord {
  code: string;
  owner_key_hash: string;
  bonus_slots: number;
  status: string;
  created_at: number;
}

interface MonitorRunOutcome {
  status: "success" | "error";
  changed: boolean;
  oldValue: string | null;
  newValue: string;
  confidence: number;
  evidence: string[];
  errorDetails: string | null;
  rawMetadata: Record<string, unknown>;
}

interface McpToolCallBody {
  id?: number | string | null;
  method?: string;
  params?: {
    name?: string;
    clientInfo?: { name?: string; version?: string };
    _meta?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

function getCurrentUsageMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function withJsonHeaders(init: ResponseInit = {}): ResponseInit {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return { ...init, headers };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), withJsonHeaders(init));
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(body, { ...init, headers });
}

function getPublicOriginForRequest(url: URL): string {
  return url.origin;
}

function getSitemapUrl(url: URL): string {
  return `${getPublicOriginForRequest(url)}/sitemap.xml`;
}

function getRobotsTxt(url: URL): string {
  const allowRules = REPUTABLE_CRAWLER_USER_AGENTS
    .map(userAgent => `User-agent: ${userAgent}\nAllow: /`)
    .join("\n\n");

  return `${allowRules}

User-agent: *
Allow: /

Sitemap: ${getSitemapUrl(url)}
`;
}

function getLlmsTxt(url: URL): string {
  const publicOrigin = getPublicOriginForRequest(url);
  return `# Ground Truth

> Track competitor pricing, packaging, APIs, and public claims with evidence-backed change signals. Three persistent daily or weekly monitors are free with no card or signup form.

Sitemap: ${getSitemapUrl(url)}

## Primary Pages

- [Home](${publicOrigin}/): Overview, pricing summary, MCP setup, and example verification workflows.
- [Watch Dashboard](${publicOrigin}/watch): Create and run three persistent monitors free.
- [Pricing](${publicOrigin}/pricing): Free monitor limits and self-serve paid plan details.
- [MCP Server Card](${publicOrigin}/.well-known/mcp/server-card.json): Machine-readable tool metadata.
`;
}

function getSitemapXml(url: URL): string {
  const publicOrigin = getPublicOriginForRequest(url);
  const sitemapEntries = [
    { loc: `${publicOrigin}/`, priority: "1.0" },
    { loc: `${publicOrigin}/watch`, priority: "0.9" },
    { loc: `${publicOrigin}/pricing`, priority: "0.8" },
    { loc: `${publicOrigin}/.well-known/mcp/server-card.json`, priority: "0.6" },
    { loc: `${publicOrigin}/llms.txt`, priority: "0.5" },
  ];

  const urls = sitemapEntries
    .map(entry => `  <url>
    <loc>${entry.loc}</loc>
    <priority>${entry.priority}</priority>
  </url>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

function structuredToolResult<T extends Record<string, unknown>>(structuredContent: T) {
  const resultWithAttribution = {
    ...structuredContent,
    poweredBy: "Ground Truth MCP - Preflight external resources before an AI agent trusts or acts on them: https://ground-truth-mcp.anishdasmail.workers.dev",
  };
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(resultWithAttribution, null, 2),
    }],
    structuredContent: resultWithAttribution,
  };
}

function getExtraHeader(
  extra: unknown,
  headerName: string,
): string | undefined {
  const headers = (extra as { requestInfo?: { headers?: Record<string, string | undefined> } } | undefined)
    ?.requestInfo?.headers;
  if (!headers) return undefined;

  const target = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function extractPricingSignals(body: string) {
  const priceRegex = /\$\d[\d,]*(?:\.\d{2})?(?:\s*\/\s*(?:mo(?:nth)?|yr|year|user|seat|req|call|token))?/gi;
  const pricesFound = [...new Set(body.match(priceRegex) || [])].slice(0, 20);
  const planRegex = /(?:free|starter|basic|pro|premium|enterprise|business|team|hobby|growth|scale)\s*(?:plan|tier)?/gi;
  const plansDetected = [...new Set((body.match(planRegex) || []).map((match) => match.trim().toLowerCase()))];

  return {
    pricesFound,
    plansDetected,
    hasFreeOption: /free\s*(?:plan|tier|forever|trial)|(?:\$0|0\.00)/i.test(body),
    hasFreeTrial: /free\s*trial|try\s*(?:it\s*)?free|start\s*free/i.test(body),
    pageLength: body.length,
  };
}

const COMPLIANCE_SIGNAL_PATTERNS = {
  soc2: /\bsoc\s*2\b|\bsoc2\b/i,
  iso27001: /\biso\s*27001\b/i,
  gdpr: /\bgdpr\b|\bgeneral data protection regulation\b/i,
  hipaa: /\bhipaa\b/i,
  dpa: /\bdata processing agreement\b|\bdpa\b/i,
  subprocessorList: /\bsubprocessors?\b/i,
  sso: /\bsingle sign-on\b|\bsso\b/i,
  scim: /\bscim\b/i,
  encryption: /\bencrypt(?:ion|ed)\b|\bat rest\b|\bin transit\b/i,
  dataResidency: /\bdata residency\b|\bdata region\b|\bregion(?:al)? storage\b/i,
} as const;

function extractComplianceSignals(body: string) {
  const signals = Object.fromEntries(
    Object.entries(COMPLIANCE_SIGNAL_PATTERNS).map(([signal, pattern]) => [signal, pattern.test(body)]),
  ) as Record<keyof typeof COMPLIANCE_SIGNAL_PATTERNS, boolean>;

  const matchedSignals = Object.entries(signals)
    .filter(([, matched]) => matched)
    .map(([signal]) => signal);

  return { signals, matchedSignals };
}

function getSecurityHeaderSummary(headers: Headers) {
  const summary = {
    strictTransportSecurity: headers.get("strict-transport-security"),
    contentSecurityPolicy: headers.get("content-security-policy"),
    xFrameOptions: headers.get("x-frame-options"),
    referrerPolicy: headers.get("referrer-policy"),
    permissionsPolicy: headers.get("permissions-policy"),
    xContentTypeOptions: headers.get("x-content-type-options"),
    crossOriginOpenerPolicy: headers.get("cross-origin-opener-policy"),
    crossOriginResourcePolicy: headers.get("cross-origin-resource-policy"),
  };

  const presentCount = Object.values(summary).filter((value) => Boolean(value)).length;
  const missingRecommended = Object.entries(summary)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  const score: SecurityHeaderScore = presentCount >= 6 ? "strong" : presentCount >= 3 ? "moderate" : "weak";

  return {
    headers: summary,
    presentCount,
    missingRecommended,
    score,
  };
}

type SecurityHeaderScore = "strong" | "moderate" | "weak";

interface EndpointVerdictInput {
  accessible: boolean;
  status?: number;
  authRequired?: boolean;
  rateLimited?: boolean;
  redirected?: boolean;
  error?: string;
}

interface EndpointCheckResult {
  inputUrl?: string;
  url: string;
  accessible: boolean;
  status?: number;
  contentType?: string | null;
  responseTimeMs?: number;
  authRequired?: boolean;
  rateLimited?: boolean;
  redirected?: boolean;
  finalUrl?: string;
  sampleResponse?: string;
  error?: string;
}

async function runEndpointCheck(inputUrl: string): Promise<EndpointCheckResult> {
  const normalizedUrl = normalizeHttpUrlInput(inputUrl);
  if (!normalizedUrl) {
    return {
      url: inputUrl,
      accessible: false,
      error: "Invalid URL. Use a public http(s) URL or a bare domain like google.com.",
    };
  }

  const start = Date.now();
  try {
    const resp = await fetch(normalizedUrl, {
      headers: { "User-Agent": `GroundTruth/${SERVER_VERSION}` },
    });
    const body = await resp.text();
    const finalUrl = resp.url || normalizedUrl;
    return {
      ...(normalizedUrl !== inputUrl ? { inputUrl } : {}),
      url: normalizedUrl,
      accessible: resp.ok,
      status: resp.status,
      contentType: resp.headers.get("content-type"),
      responseTimeMs: Date.now() - start,
      authRequired: resp.status === 401 || resp.status === 403,
      rateLimited: resp.status === 429,
      redirected: finalUrl !== normalizedUrl,
      finalUrl,
      sampleResponse: body.slice(0, 1000),
    };
  } catch (e: unknown) {
    return {
      ...(normalizedUrl !== inputUrl ? { inputUrl } : {}),
      url: normalizedUrl,
      accessible: false,
      error: e instanceof Error ? e.message : String(e),
      responseTimeMs: Date.now() - start,
    };
  }
}

interface SecurityHeaderCheckResult {
  inputUrl?: string;
  url: string;
  accessible: boolean;
  status?: number;
  https: boolean;
  headers?: ReturnType<typeof getSecurityHeaderSummary>["headers"];
  presentCount?: number;
  missingRecommended?: string[];
  score?: SecurityHeaderScore;
  error?: string;
}

async function runSecurityHeaderCheck(inputUrl: string): Promise<SecurityHeaderCheckResult> {
  const normalizedUrl = normalizeHttpUrlInput(inputUrl);
  if (!normalizedUrl) {
    return {
      url: inputUrl,
      accessible: false,
      https: false,
      error: "Invalid URL. Use a public http(s) URL or a bare domain like google.com.",
    };
  }

  try {
    const resp = await fetch(normalizedUrl, {
      headers: { "User-Agent": `GroundTruth/${SERVER_VERSION}` },
    });
    const summary = getSecurityHeaderSummary(resp.headers);
    return {
      ...(normalizedUrl !== inputUrl ? { inputUrl } : {}),
      url: normalizedUrl,
      accessible: true,
      status: resp.status,
      https: new URL(normalizedUrl).protocol === "https:",
      ...summary,
    };
  } catch (e: unknown) {
    return {
      ...(normalizedUrl !== inputUrl ? { inputUrl } : {}),
      url: normalizedUrl,
      accessible: false,
      https: new URL(normalizedUrl).protocol === "https:",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// --- Cloudflare Monetization Gateway x402 Helper Functions ---

/**
 * Get x402 payment requirements for a specific tool
 */
async function getX402PaymentRequirements(toolName: string): Promise<X402PaymentRequirements[]> {
  const normalizedNetwork = normalizeX402Network(X402_NETWORK_CONFIG);
  const priceUSD = X402_TOOL_PRICES_USD[toolName as keyof typeof X402_TOOL_PRICES_USD];
  
  if (!priceUSD || !x402ResourceServer) {
    return [];
  }
  
  // Convert USD to atomic units (USDC has 6 decimals)
  // For testnet, we'll use a small amount; for mainnet, actual pricing
  const isTestnet = normalizedNetwork === "eip155:84532"; // base-sepolia
  const amountInAtomicUnits = isTestnet 
    ? "100" // 0.0001 USDC for testing
    : String(Math.round(priceUSD * 1_000_000)); // Convert USD to USDC atomic units (6 decimals)
  
  const asset = isTestnet ? "0x0c9e55395b598813254324832f30322987287449" : "0xA0b86a33E6441b8b24c7e86e32B19C5D82cdDB2c"; // USDC addresses
  
  return [
    {
      scheme: "eip155:eip3009",
      network: normalizedNetwork,
      asset: asset,
      amount: amountInAtomicUnits,
      payTo: X402_RECIPIENT_CONFIG,
      maxTimeoutSeconds: 60,
      extra: {
        facilitatorUrl: X402_FACILITATOR_URL_CONFIG,
      },
    }
  ];
}

/**
 * Check if x402 payment is provided and valid
 */
async function checkX402Payment(
  toolName: string, 
  meta: Record<string, unknown> | undefined,
  env: Env
): Promise<{ valid: boolean; error?: unknown }> {
  if (!X402_PAYMENT_ENABLED || !x402ResourceServer) {
    return { valid: false };
  }
  
  const paymentToken = meta?.["x402/payment"] as string | undefined;
  if (!paymentToken) {
    return { valid: false };
  }
  
  try {
    const paymentRequirements = await getX402PaymentRequirements(toolName);
    if (paymentRequirements.length === 0) {
      return { valid: false };
    }
    
    // Parse the base64-encoded payment payload
    let paymentPayload: X402PaymentPayload;
    try {
      const decoded = JSON.parse(atob(paymentToken));
      paymentPayload = decoded as X402PaymentPayload;
    } catch (e) {
      console.error("Failed to decode x402 payment token:", e);
      return { valid: false, error: "Invalid payment token format" };
    }
    
    // Validate the payment payload using the x402 server
    const validation = await x402ResourceServer.verifyPayment(
      paymentPayload,
      paymentRequirements[0] // Use first requirement
    );
    
    if (validation.isValid) {
      return { valid: true };
    } else {
      return { 
        valid: false, 
        error: validation.invalidMessage || validation.invalidReason || "Payment verification failed"
      };
    }
  } catch (error) {
    console.error("x402 payment validation error:", error);
    return { valid: false, error };
  }
}

/**
 * Get x402 metadata for tool responses
 */
function getX402Metadata(toolName: string): Record<string, unknown> {
  const priceUSD = X402_TOOL_PRICES_USD[toolName as keyof typeof X402_TOOL_PRICES_USD];
  const normalizedNetwork = normalizeX402Network(X402_NETWORK_CONFIG);
  
  if (!priceUSD || !X402_PAYMENT_ENABLED) {
    return {};
  }
  
  return {
    "agents-x402/paymentRequired": true,
    "agents-x402/priceUSD": priceUSD,
    "agents-x402/network": normalizedNetwork,
    "agents-x402/asset": normalizedNetwork === "eip155:84532" ? "Test USDC" : "USDC",
    "agents-x402/priceAmount": priceUSD,
    "agents-x402/priceCurrency": "USD",
    "agents-x402/payTo": X402_RECIPIENT_CONFIG,
  };
}

// --- Error handling functions ---

function getJsonRpcErrorCode(status: number): number {
  switch (status) {
    case 401:
      return -32001;
    case 402:
      return -32002;
    case 429:
      return -32029;
    default:
      return -32000;
  }
}

function normalizeJsonRpcId(value: unknown): number | string | null {
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  return null;
}

function jsonError(
  status: number,
  error: string,
  message: string,
  details: Record<string, unknown> = {},
  requestId?: number | string | null,
): Response {
  const hasRequestId = requestId !== undefined;
  const normalizedRequestId = normalizeJsonRpcId(requestId);
  return jsonResponse(
    hasRequestId
      ? {
          jsonrpc: "2.0",
          error: {
            code: getJsonRpcErrorCode(status),
            message,
            data: {
              error,
              status,
              ...details,
            },
          },
          id: normalizedRequestId,
        }
      : {
          error,
          message,
          status,
          ...details,
        },
    { status },
  );
}

function normalizeHttpUrlInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!parsed.hostname) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeApiKeyRecord(data: unknown): ApiKeyRecord | null {
  if (!data || typeof data !== "object") return null;
  return data as ApiKeyRecord;
}

function isStripeSubscriptionActive(status?: string): boolean {
  return status === "active" || status === "trialing";
}

function isBillingActive(record: ApiKeyRecord): boolean {
  if (typeof record.subscriptionStatus === "string") {
    return isStripeSubscriptionActive(record.subscriptionStatus);
  }
  if (typeof record.billingActive === "boolean") {
    return record.billingActive;
  }
  return record.active === true;
}

function isFreeMonitorAccess(record: ApiKeyRecord): boolean {
  return record.active === true && record.plan === "free" && record.subscriptionStatus === "free";
}

function hasFreeMonitorFallback(record: ApiKeyRecord): boolean {
  return isFreeMonitorAccess(record) || (!isBillingActive(record) && typeof record.stripeCustomerId === "string");
}

function getProQuota(record: ApiKeyRecord): number {
  return typeof record.monthlyQuota === "number" ? record.monthlyQuota : PAID_MONTHLY_LIMIT;
}

function getUsageStorageKey(subjectType: "free" | "free_verify_claim" | "free_monitor" | "pro", month: string, subjectId: string): string {
  return `usage:${subjectType}:${month}:${subjectId}`;
}

function inferTrafficSource(request: Request): string {
  const referrer = request.headers.get("referer") ?? request.headers.get("referrer") ?? "";
  const userAgent = request.headers.get("user-agent") ?? "";
  const composite = `${referrer} ${userAgent}`.toLowerCase();

  if (composite.includes("glama.ai")) return "glama";
  if (composite.includes("smithery.ai")) return "smithery";
  if (composite.includes("xpay")) return "xpay";
  if (composite.includes("localhost") || composite.includes("127.0.0.1") || composite.includes("wrangler")) return "local";
  if (!referrer) return "direct";
  return "referral";
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}

async function verifyStripeWebhookSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string | undefined,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;

  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const timestamp = Number(timestampPart?.slice(2));
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3).toLowerCase())
    .filter(Boolean);

  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const expected = Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

  return signatures.some((signature) => constantTimeEqual(signature, expected));
}

function isLoopbackIp(value: string): boolean {
  return value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1";
}

function isLocalRequest(request: Request, ip?: string): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    (typeof ip === "string" && isLoopbackIp(ip));
}

function getAnonymousClientSource(request: Request): { type: string; value: string } {
  const anonymousClientId = request.headers.get("x-anonymous-client-id")?.trim();
  const cfConnectingIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp && !(anonymousClientId && isLocalRequest(request, cfConnectingIp))) {
    return { type: "ip", value: cfConnectingIp };
  }

  const xForwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xForwardedFor && !(anonymousClientId && isLocalRequest(request, xForwardedFor))) {
    return { type: "ip", value: xForwardedFor };
  }

  const xRealIp = request.headers.get("x-real-ip")?.trim();
  if (xRealIp && !(anonymousClientId && isLocalRequest(request, xRealIp))) {
    return { type: "ip", value: xRealIp };
  }

  if (anonymousClientId) {
    return { type: "anonymous_client_id", value: anonymousClientId };
  }

  return {
    type: "user_agent",
    value: request.headers.get("user-agent")?.trim() || "unknown-client",
  };
}

function inferDeployment(request: Request): string {
  return new URL(request.url).hostname.includes("xpay") ? "xpay" : "main";
}

export function normalizeTrafficEventName(eventName: string): string {
  return normalizeAnalyticsEventName(eventName);
}

async function getApiKeyRecord(kv: KVNamespace, apiKey: string): Promise<ApiKeyRecord | null> {
  try {
    const data = await kv.get(apiKey, "json");
    return normalizeApiKeyRecord(data);
  } catch {
    return null;
  }
}

async function saveApiKeyRecord(kv: KVNamespace, apiKey: string, record: ApiKeyRecord): Promise<void> {
  await kv.put(apiKey, JSON.stringify(record));
}

interface StripeCheckoutSessionRecord {
  id?: string;
  customer?: string;
  customer_details?: { email?: string };
  subscription?: string;
  payment_status?: string;
  status?: string;
  metadata?: {
    plan?: string;
    quota?: string;
    monitor_limit?: string;
    checkout_request_id?: string;
    referral_code?: string;
    upgrade_token?: string;
  };
}

async function provisionApiKeyForStripeSession(
  kv: KVNamespace,
  session: StripeCheckoutSessionRecord,
): Promise<{ apiKey: string; quota: number; activeMonitorLimit: number; planName: string; newlyActivated: boolean } | null> {
  if (!session.customer || !session.subscription) return null;

  let apiKey: string | null = null;
  let existingKeyRecord: ApiKeyRecord | null = null;
  const upgradeToken = typeof session.metadata?.upgrade_token === "string" && /^[a-f0-9]{48}$/i.test(session.metadata.upgrade_token)
    ? session.metadata.upgrade_token.toLowerCase()
    : null;

  if (upgradeToken) {
    const freeKey = await kv.get(`upgrade:${upgradeToken}`);
    if (freeKey?.startsWith("gt_free_")) {
      const record = await getApiKeyRecord(kv, freeKey);
      if (record && hasFreeMonitorFallback(record)) {
        apiKey = freeKey;
        existingKeyRecord = record;
      }
    }
  }

  if (!apiKey) {
    const indexedKey = await kv.get(`stripe_customer:${session.customer}`);
    if (indexedKey) {
      const indexedRecord = await getApiKeyRecord(kv, indexedKey);
      if (indexedRecord?.stripeCustomerId === session.customer) {
        apiKey = indexedKey;
        existingKeyRecord = indexedRecord;
      }
    }
  }

  if (!apiKey) {
    for (const prefix of ["gt_live_", "gt_free_"]) {
      const existingKeysList = await kv.list({ prefix });
      for (const key of existingKeysList.keys) {
        const data = await getApiKeyRecord(kv, key.name);
        if (data?.stripeCustomerId === session.customer) {
          apiKey = key.name;
          existingKeyRecord = data;
          break;
        }
      }
      if (apiKey) break;
    }
  }

  if (!apiKey) apiKey = generateApiKey();
  const alreadyActive = Boolean(
    existingKeyRecord &&
    isBillingActive(existingKeyRecord) &&
    existingKeyRecord.subscriptionId === session.subscription,
  );
  const now = new Date().toISOString();
  const plan = PAID_PLANS[resolvePaidPlanId(session.metadata?.plan)];
  const quota = plan.monthlyQuota;

  await saveApiKeyRecord(kv, apiKey, {
    ...existingKeyRecord,
    active: true,
    billingActive: true,
    subscriptionStatus: "active",
    plan: plan.id,
    monthlyQuota: quota,
    activeMonitorLimit: plan.activeMonitorLimit,
    email: session.customer_details?.email || existingKeyRecord?.email || "unknown",
    stripeCustomerId: session.customer,
    subscriptionId: session.subscription,
    createdAt: existingKeyRecord?.createdAt || now,
    cancelledAt: undefined,
    reactivatedAt: existingKeyRecord ? now : undefined,
  });
  await kv.put(`stripe_customer:${session.customer}`, apiKey);
  if (upgradeToken) await kv.delete(`upgrade:${upgradeToken}`);

  return { apiKey, quota, activeMonitorLimit: plan.activeMonitorLimit, planName: plan.name, newlyActivated: !alreadyActive };
}

async function updateCustomerBillingState(
  kv: KVNamespace,
  customerId: string,
  updates: Partial<ApiKeyRecord>,
): Promise<void> {
  const indexedKey = await kv.get(`stripe_customer:${customerId}`);
  if (indexedKey) {
    const indexedRecord = await getApiKeyRecord(kv, indexedKey);
    if (indexedRecord?.stripeCustomerId === customerId) {
      await saveApiKeyRecord(kv, indexedKey, { ...indexedRecord, ...updates });
      return;
    }
  }

  // Backward-compatible repair path for accounts created before the customer
  // index existed. New billing events remain O(1).
  for (const prefix of ["gt_live_", "gt_free_"]) {
    const keysList = await kv.list({ prefix });
    for (const key of keysList.keys) {
      const data = await getApiKeyRecord(kv, key.name);
      if (!data || data.stripeCustomerId !== customerId) continue;
      await saveApiKeyRecord(kv, key.name, { ...data, ...updates });
      await kv.put(`stripe_customer:${customerId}`, key.name);
      return;
    }
  }
}

async function getUsageRecord(kv: KVNamespace, usageKey: string): Promise<UsageRecord | null> {
  const data = await kv.get(usageKey, "json");
  if (!data || typeof data !== "object") return null;

  const record = data as Partial<UsageRecord>;
  return {
    month: typeof record.month === "string" ? record.month : getCurrentUsageMonth(),
    subjectType: record.subjectType === "pro" || record.subjectType === "free_verify_claim" || record.subjectType === "free_monitor"
      ? record.subjectType
      : "free",
    subjectId: typeof record.subjectId === "string" ? record.subjectId : usageKey,
    total: typeof record.total === "number" ? record.total : 0,
    byTool: typeof record.byTool === "object" && record.byTool !== null
      ? record.byTool as Record<string, number>
      : {},
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
  };
}

async function checkUsageLimit(
  kv: KVNamespace,
  usageKey: string,
  limit: number,
): Promise<UsageLimitResult> {
  const record = await getUsageRecord(kv, usageKey);
  const used = record?.total ?? 0;
  return {
    allowed: used < limit,
    used,
    limit,
    remaining: Math.max(limit - used, 0),
    record,
  };
}

async function incrementUsage(
  kv: KVNamespace,
  usageKey: string,
  subjectType: "free" | "free_verify_claim" | "free_monitor" | "pro",
  subjectId: string,
  month: string,
  toolName: string,
): Promise<UsageRecord> {
  const record = await getUsageRecord(kv, usageKey);
  const nextRecord: UsageRecord = {
    month,
    subjectType,
    subjectId,
    total: (record?.total ?? 0) + 1,
    byTool: {
      ...(record?.byTool ?? {}),
      [toolName]: ((record?.byTool ?? {})[toolName] ?? 0) + 1,
    },
    updatedAt: new Date().toISOString(),
  };

  await kv.put(usageKey, JSON.stringify(nextRecord));
  return nextRecord;
}

async function requireProAccess(
  kv: KVNamespace,
  request: Request,
  toolName: string,
  requestId?: number | string | null,
): Promise<ProAccessContext | Response> {
  const apiKey = request.headers.get("X-API-Key")?.trim();
  if (!apiKey) {
    return jsonError(
      401,
      "missing_api_key",
      `Tool '${toolName}' requires a team API key.`,
      {
        tier: "team",
        tool: toolName,
      },
      requestId,
    );
  }

  const apiKeyRecord = await getApiKeyRecord(kv, apiKey);
  if (!apiKeyRecord) {
    return jsonError(
      401,
      "invalid_api_key",
      "The provided API key is invalid.",
      {
        tier: "team",
        tool: toolName,
      },
      requestId,
    );
  }

  if (!isBillingActive(apiKeyRecord)) {
    return jsonError(
      402,
      "billing_inactive",
      "Billing is inactive for this API key.",
      {
        tier: "team",
        tool: toolName,
        subscriptionStatus: apiKeyRecord.subscriptionStatus ?? "inactive",
      },
      requestId,
    );
  }

  const month = getCurrentUsageMonth();
  const subjectId = await sha256Hex(apiKey);
  const usageKey = getUsageStorageKey("pro", month, subjectId);
  const limit = getProQuota(apiKeyRecord);
  const usage = await checkUsageLimit(kv, usageKey, limit);

  if (!usage.allowed) {
    return jsonError(
      429,
      "quota_exceeded",
      `Monthly quota exceeded for ${month}. You have used ${usage.used} of ${limit} included calls.`,
      {
        tier: "paid",
        tool: toolName,
        month,
        limit,
        used: usage.used,
        remaining: usage.remaining,
      },
      requestId,
    );
  }

  return {
    apiKey,
    apiKeyRecord,
    limit,
    month,
    subjectId,
    usageKey,
  };
}

async function requireMonitorAccess(
  kv: KVNamespace,
  request: Request,
  toolName: string,
  requestId?: number | string | null,
): Promise<MonitorAccessContext | Response> {
  const apiKey = request.headers.get("X-API-Key")?.trim();
  if (!apiKey) {
    return jsonError(401, "missing_api_key", `Tool '${toolName}' requires a free watch key or paid API key.`, {
      tier: "monitor",
      tool: toolName,
      startFreeUrl: `${PUBLIC_APP_ORIGIN}/watch`,
    }, requestId);
  }

  const apiKeyRecord = await getApiKeyRecord(kv, apiKey);
  if (!apiKeyRecord) {
    return jsonError(401, "invalid_api_key", "The provided watch key is invalid.", {
      tier: "monitor",
      tool: toolName,
      startFreeUrl: `${PUBLIC_APP_ORIGIN}/watch`,
    }, requestId);
  }

  const freeAccess = hasFreeMonitorFallback(apiKeyRecord);
  if (!freeAccess && !isBillingActive(apiKeyRecord)) {
    return jsonError(402, "billing_inactive", "Billing is inactive for this API key.", {
      tier: "team",
      tool: toolName,
      subscriptionStatus: apiKeyRecord.subscriptionStatus ?? "inactive",
    }, requestId);
  }

  const month = getCurrentUsageMonth();
  const subjectId = await sha256Hex(apiKey);
  const usageSubjectType = freeAccess ? "free_monitor" as const : "pro" as const;
  const usageKey = getUsageStorageKey(usageSubjectType, month, subjectId);
  const limit = freeAccess
    ? FREE_MONITOR_MONTHLY_QUOTA
    : getProQuota(apiKeyRecord);
  const usage = await checkUsageLimit(kv, usageKey, limit);

  if (!usage.allowed) {
    return jsonError(429, "quota_exceeded", `Monthly monitor action quota exceeded for ${month}.`, {
      tier: freeAccess ? "free_monitor" : "paid",
      tool: toolName,
      month,
      limit,
      used: usage.used,
      remaining: usage.remaining,
      upgradeUrl: `${PUBLIC_APP_ORIGIN}/pricing`,
    }, requestId);
  }

  return {
    apiKey,
    apiKeyRecord,
    limit,
    month,
    subjectId,
    usageKey,
    accessTier: freeAccess ? "free_monitor" : "team",
    usageSubjectType,
  };
}

// --- API Key helpers ---
function randomHex(bytes = 16): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, value => value.toString(16).padStart(2, "0")).join("");
}

function generateApiKey(prefix = "gt_live_"): string {
  return `${prefix}${randomHex(16)}`;
}

// --- Remote telemetry logger ---
type TelemetryMetadata = Record<string, string | number | boolean | null>;

async function logRemoteUsage(
  tool: string,
  success: boolean,
  eventName = "tool_call_completed",
  metadata: TelemetryMetadata = {},
): Promise<void> {
  if (!TELEMETRY_ENABLED) return;
  
  try {
    const platform = workerProcess?.platform ?? "unknown";
    
    // Optional external sink. Stable Worker analytics are the source of truth;
    // an unavailable external dashboard must not create noisy failed requests.
    fetch(TELEMETRY_ENDPOINT as string, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_name: eventName,
        tool_name: tool,
        success,
        server_version: SERVER_VERSION,
        os_platform: platform,
        metadata,
        timestamp: new Date().toISOString(),
      }),
    }).catch(() => {}); // Silently fail - telemetry should never break the app
  } catch {
    // Ignore telemetry errors
  }
}

type SqlTagFn = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

// --- Cache helpers using Durable Object SQLite tagged template ---
function cacheGet(sql: SqlTagFn, key: string): string | null {
  const rows = sql<{ data: string; ts: number }>`SELECT data, ts FROM cache WHERE key = ${key}`;
  if (rows.length === 0) return null;
  const row = rows[0];
  if (Date.now() - row.ts > CACHE_TTL_MS) {
    sql`DELETE FROM cache WHERE key = ${key}`;
    return null;
  }
  return row.data;
}

function cacheSet(sql: SqlTagFn, key: string, data: string): void {
  if (data.length > MAX_CACHEABLE_BODY_BYTES) return;

  const ts = Date.now();
  try {
    sql`INSERT OR REPLACE INTO cache (key, data, ts) VALUES (${key}, ${data}, ${ts})`;
  } catch {
    // Cache writes should never take down a verification request.
  }
}

// --- Cached fetch wrapper ---
async function cachedFetch(sql: SqlTagFn, url: string): Promise<{ body: string; fromCache: boolean }> {
  const cached = cacheGet(sql, url);
  if (cached) return { body: cached, fromCache: true };
  const resp = await fetch(url, { headers: { "User-Agent": "GroundTruth/0.3" }, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`Source returned HTTP ${resp.status}. Choose an accessible public page.`);
  const body = await resp.text();
  if (resp.ok) cacheSet(sql, url, body);
  return { body, fromCache: false };
}

// --- Monitor helpers ---
function generateMonitorId(): string {
  return `mon_${randomHex(12)}`;
}

function generateResultId(): string {
  return `res_${randomHex(12)}`;
}

function generateShareId(): string {
  return `shr_${randomHex(16)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character] ?? character));
}

function normalizeReferralCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const code = value.trim();
  return /^shr_[a-z0-9]{12,64}$/i.test(code) ? code : null;
}

type NotificationChannel = "webhook" | "slack" | "email";

interface NotificationTarget {
  channel: NotificationChannel;
  /** Normalized value: an HTTPS URL for webhook/slack, an email address for email. */
  destination: string;
}

/**
 * Validate and classify a monitor's change-alert destination.
 *
 * Supported destinations:
 *   - `https://...`                 → generic webhook (JSON POST)
 *   - `https://hooks.slack.com/...` → Slack Incoming Webhook (Slack message)
 *   - `mailto:name@domain`          → email alert (requires RESEND_API_KEY)
 *
 * Returns null for anything unsafe (non-HTTPS, private/internal hosts,
 * credentials in the URL, malformed email). Returning the normalized string
 * keeps backward compatibility with callers that only need "is this valid".
 */
function getNotificationDestination(value: string | null): string | null {
  return classifyNotificationDestination(value)?.destination ?? null;
}

function classifyNotificationDestination(value: string | null): NotificationTarget | null {
  if (!value) return null;
  const trimmed = value.trim();

  // Email: mailto:someone@example.com
  if (/^mailto:/i.test(trimmed)) {
    const address = trimmed.replace(/^mailto:/i, "").trim();
    // Pragmatic single-address RFC-ish check; no display names or lists.
    if (/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(address)) {
      return { channel: "email", destination: address.toLowerCase() };
    }
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.toLowerCase();
    const privateIpv4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(hostname);
    const privateIpv6 = hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:");
    if (parsed.username || parsed.password || hostname === "localhost" || hostname === "0.0.0.0" || hostname.endsWith(".internal") || privateIpv4 || privateIpv6) return null;
    const channel: NotificationChannel = hostname === "hooks.slack.com" ? "slack" : "webhook";
    return { channel, destination: parsed.toString() };
  } catch {
    return null;
  }
}

/** Human-readable change summary shared by Slack and email alerts. */
function buildChangeAlertText(monitor: MonitorRecord, outcome: MonitorRunOutcome, publicOrigin: string): { subject: string; body: string } {
  const subject = `Ground Truth: "${monitor.name}" changed`;
  const lines = [
    `Monitor "${monitor.name}" detected a change.`,
    ``,
    `Target: ${monitor.target_type} — ${monitor.target_value}`,
    `Confidence: ${Math.round(outcome.confidence * 100)}%`,
    ``,
    `Previous:`,
    (outcome.oldValue ?? "(no prior baseline)").slice(0, 800),
    ``,
    `Now:`,
    outcome.newValue.slice(0, 800),
  ];
  if (outcome.evidence.length > 0) {
    lines.push(``, `Evidence:`, ...outcome.evidence.slice(0, 5).map(e => `• ${e}`));
  }
  lines.push(``, `Full history: ${publicOrigin}/watch`);
  return { subject, body: lines.join("\n") };
}

async function sendEmailNotification(env: Env, toAddress: string, subject: string, body: string): Promise<boolean> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return false;
  const from = env.RESEND_FROM || "Ground Truth <alerts@ground-truth-mcp.anishdasmail.workers.dev>";
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to: [toAddress], subject, text: body }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function sendMonitorNotification(
  env: Env,
  monitor: MonitorRecord,
  outcome: MonitorRunOutcome,
  resultId: string,
  publicOrigin = PUBLIC_APP_ORIGIN,
): Promise<boolean> {
  const target = classifyNotificationDestination(monitor.notification_destination);
  if (!target || !outcome.changed) return false;

  if (target.channel === "email") {
    const { subject, body } = buildChangeAlertText(monitor, outcome, publicOrigin);
    return sendEmailNotification(env, target.destination, subject, body);
  }

  if (target.channel === "slack") {
    const { subject, body } = buildChangeAlertText(monitor, outcome, publicOrigin);
    try {
      const response = await fetch(target.destination, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `*${subject}*\n${body}` }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // Generic webhook (default): structured JSON payload for agents/automations.
  try {
    const response = await fetch(target.destination, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ground-Truth-Event": "monitor.changed" },
      body: JSON.stringify({
        event: "monitor.changed",
        monitor_id: monitor.id,
        monitor_name: monitor.name,
        target_type: monitor.target_type,
        target_value: monitor.target_value,
        result_id: resultId,
        changed: true,
        old_value: outcome.oldValue?.slice(0, 2000) ?? null,
        new_value: outcome.newValue.slice(0, 2000),
        confidence: outcome.confidence,
        evidence: outcome.evidence.slice(0, 20),
        occurred_at: new Date().toISOString(),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function isDueForRun(monitor: MonitorRecord, now = Date.now()): boolean {
  if (monitor.schedule === "manual" || monitor.active === 0) return false;
  if (monitor.last_run_at === null) return true;
  const intervals: Record<string, number> = {
    hourly: 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
  };
  const interval = intervals[monitor.schedule];
  return typeof interval === "number" && (now - monitor.last_run_at) >= interval;
}

function detectMonitorChanges(
  oldValue: string | null,
  newValue: string,
): { changed: boolean; confidence: number } {
  if (!oldValue) return { changed: false, confidence: 1.0 };
  if (oldValue === newValue) return { changed: false, confidence: 1.0 };
  try {
    const oldObj = JSON.parse(oldValue) as Record<string, unknown>;
    const newObj = JSON.parse(newValue) as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
    let diffCount = 0;
    for (const key of allKeys) {
      if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) diffCount++;
    }
    return diffCount > 0 ? { changed: true, confidence: 0.95 } : { changed: false, confidence: 1.0 };
  } catch {
    return { changed: true, confidence: 0.7 };
  }
}

async function runMonitorVerification(
  sql: SqlTagFn,
  monitor: MonitorRecord,
): Promise<MonitorRunOutcome> {
  const { target_type, target_value, instructions } = monitor;
  const evidence: string[] = [];
  try {
    if (target_type === "url" || target_type === "endpoint") {
      const start = Date.now();
      try {
        const resp = await fetch(target_value, {
          headers: { "User-Agent": "GroundTruth/0.4" },
          signal: AbortSignal.timeout(15000),
        });
        const newValue = JSON.stringify({
          status: resp.status,
          accessible: resp.ok,
          contentType: resp.headers.get("content-type"),
        });
        evidence.push(target_value);
        const prev = sql<{ new_value: string | null }>`SELECT new_value FROM monitor_results WHERE monitor_id = ${monitor.id} ORDER BY run_at DESC LIMIT 1`;
        const oldValue = prev[0]?.new_value ?? null;
        const { changed, confidence } = detectMonitorChanges(oldValue, newValue);
        return { status: "success", changed, oldValue, newValue, confidence, evidence, errorDetails: null, rawMetadata: { responseTimeMs: Date.now() - start } };
      } catch (e) {
        return { status: "error", changed: false, oldValue: null, newValue: "", confidence: 0, evidence: [], errorDetails: e instanceof Error ? e.message : String(e), rawMetadata: { responseTimeMs: Date.now() - start } };
      }
    }

    if (target_type === "pricing_page") {
      const { body, fromCache } = await cachedFetch(sql, target_value);
      const signals = extractPricingSignals(body);
      const newValue = JSON.stringify({
        pricesFound: signals.pricesFound,
        plansDetected: signals.plansDetected,
        hasFreeOption: signals.hasFreeOption,
        hasFreeTrial: signals.hasFreeTrial,
      });
      evidence.push(target_value);
      const prev = sql<{ new_value: string | null }>`SELECT new_value FROM monitor_results WHERE monitor_id = ${monitor.id} ORDER BY run_at DESC LIMIT 1`;
      const oldValue = prev[0]?.new_value ?? null;
      const { changed, confidence } = detectMonitorChanges(oldValue, newValue);
      return { status: "success", changed, oldValue, newValue, confidence, evidence, errorDetails: null, rawMetadata: { fromCache, pageLength: body.length } };
    }

    if (target_type === "package") {
      const colonIdx = target_value.indexOf(":");
      const registry = colonIdx > 0 ? target_value.slice(0, colonIdx) : "npm";
      const pkg = colonIdx > 0 ? target_value.slice(colonIdx + 1) : target_value;
      let newValue: string;
      if (registry === "pypi") {
        const apiUrl = `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`;
        const { body } = await cachedFetch(sql, apiUrl);
        const data = JSON.parse(body) as { info?: { version?: string; name?: string } };
        newValue = JSON.stringify({ version: data.info?.version ?? null, name: data.info?.name ?? pkg });
        evidence.push(apiUrl);
      } else {
        const apiUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
        const { body } = await cachedFetch(sql, apiUrl);
        const data = JSON.parse(body) as { version?: string; name?: string };
        newValue = JSON.stringify({ version: data.version ?? null, name: data.name ?? pkg });
        evidence.push(apiUrl);
      }
      const prev = sql<{ new_value: string | null }>`SELECT new_value FROM monitor_results WHERE monitor_id = ${monitor.id} ORDER BY run_at DESC LIMIT 1`;
      const oldValue = prev[0]?.new_value ?? null;
      const { changed, confidence } = detectMonitorChanges(oldValue, newValue);
      return { status: "success", changed, oldValue, newValue, confidence, evidence, errorDetails: null, rawMetadata: { registry, pkg } };
    }

    if (target_type === "vendor_claim") {
      const checkUrl = instructions?.trim() ?? "";
      if (!checkUrl) {
        return { status: "error", changed: false, oldValue: null, newValue: "", confidence: 0, evidence: [], errorDetails: "vendor_claim requires instructions to contain the evidence URL", rawMetadata: {} };
      }
      const { body } = await cachedFetch(sql, checkUrl);
      const escaped = target_value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const supported = new RegExp(escaped, "i").test(body);
      const words = target_value.split(/\s+/).filter(w => w.length > 3);
      const keywordMatches = words.filter(w => body.toLowerCase().includes(w.toLowerCase())).length;
      const newValue = JSON.stringify({ supported, keywordMatches, claim: target_value.slice(0, 200) });
      evidence.push(checkUrl);
      const prev = sql<{ new_value: string | null }>`SELECT new_value FROM monitor_results WHERE monitor_id = ${monitor.id} ORDER BY run_at DESC LIMIT 1`;
      const oldValue = prev[0]?.new_value ?? null;
      const { changed, confidence } = detectMonitorChanges(oldValue, newValue);
      return { status: "success", changed, oldValue, newValue, confidence, evidence, errorDetails: null, rawMetadata: { supported, keywordMatches } };
    }

    if (target_type === "custom_prompt") {
      const { body, fromCache } = await cachedFetch(sql, target_value);
      const keywords = (instructions ?? "").split(",").map(k => k.trim()).filter(Boolean);
      const matchResults = keywords.map(k => ({ keyword: k, found: body.toLowerCase().includes(k.toLowerCase()) }));
      const newValue = JSON.stringify({
        allFound: matchResults.every(m => m.found),
        anyFound: matchResults.some(m => m.found),
        matchResults,
        pageLength: body.length,
      });
      evidence.push(target_value);
      const prev = sql<{ new_value: string | null }>`SELECT new_value FROM monitor_results WHERE monitor_id = ${monitor.id} ORDER BY run_at DESC LIMIT 1`;
      const oldValue = prev[0]?.new_value ?? null;
      const { changed, confidence } = detectMonitorChanges(oldValue, newValue);
      return { status: "success", changed, oldValue, newValue, confidence, evidence, errorDetails: null, rawMetadata: { fromCache, keywords } };
    }

    return { status: "error", changed: false, oldValue: null, newValue: "", confidence: 0, evidence: [], errorDetails: `Unknown target_type: ${target_type}`, rawMetadata: {} };
  } catch (e) {
    return { status: "error", changed: false, oldValue: null, newValue: "", confidence: 0, evidence, errorDetails: e instanceof Error ? e.message : String(e), rawMetadata: {} };
  }
}

function getRecommendedMonitorSchedule(targetType: string): "hourly" | "daily" | "weekly" {
  if (targetType === "endpoint" || targetType === "url") return "hourly";
  if (targetType === "package") return "weekly";
  return "daily";
}

function parseMonitorBaseline(value: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function buildMonitorPreviewResult(
  targetType: string,
  targetValue: string,
  outcome: MonitorRunOutcome,
) {
  const recommendedSchedule = getRecommendedMonitorSchedule(targetType);
  if (outcome.status === "error") {
    return {
      status: "error" as const,
      target_type: targetType,
      target_value: targetValue,
      baseline: null,
      evidence: outcome.evidence,
      confidence: outcome.confidence,
      recommended_schedule: recommendedSchedule,
      agent_next_action: "Explain the baseline error and ask for a different public source. Do not recommend checkout until a preview succeeds.",
      persistence: "preview_only" as const,
      upgrade_tool: "create_monitor" as const,
      pricing_url: `${PUBLIC_APP_ORIGIN}/pricing`,
      error: outcome.errorDetails ?? "The source baseline could not be created.",
    };
  }

  return {
    status: "baseline_ready" as const,
    target_type: targetType,
    target_value: targetValue,
    baseline: parseMonitorBaseline(outcome.newValue),
    evidence: outcome.evidence,
    confidence: outcome.confidence,
    recommended_schedule: recommendedSchedule,
    agent_next_action:
      `Show this baseline to the user. If they need the source kept fresh automatically, offer a free watch key from ${PUBLIC_APP_ORIGIN}/watch and call create_monitor with schedule=${recommendedSchedule === "hourly" ? "daily" : recommendedSchedule}. Upgrade is only required for hourly checks or higher limits.`,
    persistence: "preview_only" as const,
    upgrade_tool: "create_monitor" as const,
    pricing_url: `${PUBLIC_APP_ORIGIN}/pricing`,
  };
}

async function analyzePricingPage(sql: SqlTagFn, url: string) {
  const { body, fromCache } = await cachedFetch(sql, url);
  return {
    url,
    cached: fromCache,
    ...extractPricingSignals(body),
  };
}

// --- npm helpers ---
interface NpmSearchResult {
  objects?: { package: { name: string; description?: string; version: string }; score?: { final?: number } }[];
  total?: number;
}

async function searchNpm(sql: SqlTagFn, query: string, size = 10): Promise<NpmSearchResult> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${size}`;
  const { body } = await cachedFetch(sql, url);
  return JSON.parse(body);
}

// --- PyPI helpers ---
async function searchPyPI(sql: SqlTagFn, query: string): Promise<{ total: number; results: { name: string; description: string; version: string }[] }> {
  const url = `https://pypi.org/search/?q=${encodeURIComponent(query)}&o=`;
  const { body } = await cachedFetch(sql, url);
  const results: { name: string; description: string; version: string }[] = [];
  const nameRegex = /class="package-snippet__name">([^<]+)<\/span>/g;
  const versionRegex = /class="package-snippet__version">([^<]+)<\/span>/g;
  const descRegex = /class="package-snippet__description">([^<]*)<\/p>/g;
  const names: string[] = [];
  const versions: string[] = [];
  const descriptions: string[] = [];
  let match;
  while ((match = nameRegex.exec(body)) !== null) names.push(match[1].trim());
  while ((match = versionRegex.exec(body)) !== null) versions.push(match[1].trim());
  while ((match = descRegex.exec(body)) !== null) descriptions.push(match[1].trim());
  for (let i = 0; i < Math.min(names.length, 10); i++) {
    results.push({
      name: names[i],
      description: (descriptions[i] || "").slice(0, 120),
      version: versions[i] || "unknown",
    });
  }
  return { total: names.length, results };
}

// --- MCP Server ---
// Returned to every client in the `initialize` result and injected into the
// connecting agent's context. This is the single highest-leverage activation
// surface: it tells a cold agent the exact first call (the activation event)
// and the no-signup path to recurring value before any paid prompt.
const SERVER_INSTRUCTIONS = [
  "Ground Truth gives agents evidence-backed signals about competitor and vendor changes (pricing, packaging, APIs, packages, public claims).",
  "",
  "START HERE (no API key, no signup): call `check_endpoint` with a public URL, e.g. url=\"https://example.com\". A PASS confirms you are connected and returns live evidence (status, content type, timing, redirects, auth/rate-limit signals).",
  "",
  "PROVE RECURRING VALUE: if a source should stay trustworthy over time, call `preview_monitor` (still free, no key) to capture a baseline for a pricing page, endpoint, package, or vendor claim. Then create a persistent monitor with `create_monitor` using a free watch key from /watch — 3 monitors, daily/weekly checks, evidence history, change reports, and webhook/Slack/email alerts, with no card.",
  "",
  "Only suggest a paid plan after a preview or monitor has shown value. Paid plans add hourly checks, higher limits, and the research tools (pricing, market, competitor, hypothesis, compliance). Do not answer from memory — call a tool and use its evidence.",
].join("\n");

export class GroundTruthMCP extends McpAgent<Env> {
  server = new McpServer({ name: "ground-truth", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });

  private ensureAnalyticsSchema(): void {
    this.sql`CREATE TABLE IF NOT EXISTS traffic_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, path TEXT, source TEXT, referrer TEXT, user_agent TEXT, ts INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_name TEXT NOT NULL, tool TEXT, tier TEXT, payment_method TEXT, status TEXT, http_status INTEGER, source TEXT, client_hash TEXT, ts INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS shared_reports (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, owner_key_hash TEXT NOT NULL, title TEXT NOT NULL, report_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS referral_rewards (code TEXT PRIMARY KEY, owner_key_hash TEXT NOT NULL, bonus_slots INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, created_at INTEGER NOT NULL)`;
    const trafficColumns = new Set(this.sql<{ name: string }>`PRAGMA table_info(traffic_log)`.map(column => column.name));
    const usageColumns = new Set(this.sql<{ name: string }>`PRAGMA table_info(usage_events)`.map(column => column.name));
    const migrations: Array<{ columns: Set<string>; name: string; statement: () => unknown }> = [
      { columns: trafficColumns, name: "event_key", statement: () => this.sql`ALTER TABLE traffic_log ADD COLUMN event_key TEXT` },
      { columns: trafficColumns, name: "client_hash", statement: () => this.sql`ALTER TABLE traffic_log ADD COLUMN client_hash TEXT` },
      { columns: trafficColumns, name: "mcp_client_id", statement: () => this.sql`ALTER TABLE traffic_log ADD COLUMN mcp_client_id TEXT` },
      { columns: trafficColumns, name: "tier", statement: () => this.sql`ALTER TABLE traffic_log ADD COLUMN tier TEXT` },
      { columns: trafficColumns, name: "payment_method", statement: () => this.sql`ALTER TABLE traffic_log ADD COLUMN payment_method TEXT` },
      { columns: trafficColumns, name: "status", statement: () => this.sql`ALTER TABLE traffic_log ADD COLUMN status TEXT` },
      { columns: trafficColumns, name: "server_version", statement: () => this.sql`ALTER TABLE traffic_log ADD COLUMN server_version TEXT` },
      { columns: trafficColumns, name: "deployment", statement: () => this.sql`ALTER TABLE traffic_log ADD COLUMN deployment TEXT` },
      { columns: trafficColumns, name: "referral_code", statement: () => this.sql`ALTER TABLE traffic_log ADD COLUMN referral_code TEXT` },
      { columns: usageColumns, name: "event_key", statement: () => this.sql`ALTER TABLE usage_events ADD COLUMN event_key TEXT` },
      { columns: usageColumns, name: "mcp_client_id", statement: () => this.sql`ALTER TABLE usage_events ADD COLUMN mcp_client_id TEXT` },
      { columns: usageColumns, name: "server_version", statement: () => this.sql`ALTER TABLE usage_events ADD COLUMN server_version TEXT` },
      { columns: usageColumns, name: "deployment", statement: () => this.sql`ALTER TABLE usage_events ADD COLUMN deployment TEXT` },
      { columns: usageColumns, name: "referral_code", statement: () => this.sql`ALTER TABLE usage_events ADD COLUMN referral_code TEXT` },
    ];
    for (const migration of migrations) {
      if (migration.columns.has(migration.name)) continue;
      try {
        migration.statement();
        migration.columns.add(migration.name);
      } catch (_) {
        // Another serialized request may have applied the same migration.
      }
    }
  }

  /**
   * Shrink the analytics Durable Object by deleting rows older than the
   * retention window. These are DELETEs — shrinking writes — which Cloudflare
   * permits even when the account is over its DO storage cap, so this both
   * recovers from an over-cap outage and keeps storage bounded going forward.
   *
   * High-volume, low-value tables only (per-request logs and ephemeral caches);
   * user-owned data (monitors, monitor_results, shared_reports, referral
   * rewards) is never touched. Retention is floored at 31 days so the rolling
   * 30-day funnel on /stats always has its window.
   */
  pruneAnalytics(retentionDays = 45): {
    retentionDays: number;
    trafficDeleted: number;
    usageDeleted: number;
    trafficRemaining: number;
    usageRemaining: number;
  } {
    this.ensureAnalyticsSchema();
    this.sql`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, data TEXT, ts INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT, ts INTEGER, success INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS paid_result_cache (key TEXT PRIMARY KEY, response TEXT, ts INTEGER)`;
    const days = Math.max(31, Math.floor(retentionDays));
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const trafficBefore = this.sql<{ c: number }>`SELECT COUNT(*) as c FROM traffic_log`[0]?.c ?? 0;
    const usageBefore = this.sql<{ c: number }>`SELECT COUNT(*) as c FROM usage_events`[0]?.c ?? 0;
    // Per-request logs: keep the retention window.
    this.sql`DELETE FROM traffic_log WHERE ts < ${cutoff}`;
    this.sql`DELETE FROM usage_events WHERE ts < ${cutoff}`;
    this.sql`DELETE FROM usage_log WHERE ts < ${cutoff}`;
    // Ephemeral caches: anything older than a day is already stale.
    this.sql`DELETE FROM cache WHERE ts < ${oneDayAgo}`;
    this.sql`DELETE FROM paid_result_cache WHERE ts < ${oneDayAgo}`;
    const trafficRemaining = this.sql<{ c: number }>`SELECT COUNT(*) as c FROM traffic_log`[0]?.c ?? 0;
    const usageRemaining = this.sql<{ c: number }>`SELECT COUNT(*) as c FROM usage_events`[0]?.c ?? 0;
    return {
      retentionDays: days,
      trafficDeleted: trafficBefore - trafficRemaining,
      usageDeleted: usageBefore - usageRemaining,
      trafficRemaining,
      usageRemaining,
    };
  }

  private getActiveMonitorLimit(ownerKeyHash: string, planLimit?: number): number {
    const base = planLimit ?? PAID_ACTIVE_MONITOR_LIMIT;
    const bonuses = this.sql<{ bonus_slots: number }>`SELECT COALESCE(SUM(bonus_slots), 0) as bonus_slots FROM referral_rewards WHERE owner_key_hash = ${ownerKeyHash} AND status = ${"credited"}`;
    return base + (bonuses[0]?.bonus_slots ?? 0);
  }

  private completeReferral(code: string, referredKeyHash: string | null): Response {
    try {
      this.ensureAnalyticsSchema();
      const reports = this.sql<SharedReportRecord>`SELECT * FROM shared_reports WHERE id = ${code} LIMIT 1`;
      const report = reports[0];
      if (!report || report.expires_at <= Date.now()) {
        return jsonResponse({ ok: false, rewarded: false, reason: "referral_not_found_or_expired" }, { status: 404 });
      }
      if (!referredKeyHash || referredKeyHash === report.owner_key_hash) {
        return jsonResponse({ ok: false, rewarded: false, reason: "self_referral_not_allowed" }, { status: 409 });
      }
      const existing = this.sql<ReferralRewardRecord>`SELECT * FROM referral_rewards WHERE code = ${code} LIMIT 1`;
      if (existing.length > 0) return jsonResponse({ ok: true, rewarded: false, already_rewarded: true });
      this.sql`INSERT INTO referral_rewards (code, owner_key_hash, bonus_slots, status, created_at) VALUES (${code}, ${report.owner_key_hash}, ${1}, ${"credited"}, ${Date.now()})`;
      this.sql`INSERT INTO traffic_log (kind, path, source, status, ts, server_version, deployment) VALUES (${"referral_reward_credited"}, ${`/share/${code}`}, ${"share"}, ${"success"}, ${Date.now()}, ${SERVER_VERSION}, ${"main"})`;
      return jsonResponse({ ok: true, rewarded: true, bonus_monitor_slots: 1 });
    } catch (e) {
      return jsonError(500, "referral_unavailable", e instanceof Error ? e.message : String(e));
    }
  }

  async init() {
    // Initialize cache table
    this.sql`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, data TEXT, ts INTEGER)`;
    // Initialize usage log table
    this.sql`CREATE TABLE IF NOT EXISTS usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT, ts INTEGER, success INTEGER)`;
    // Stable, source-aware tool events are written by the outer Worker wrapper.
    this.ensureAnalyticsSchema();
    // Initialize paid-response cache for idempotent paid-tool retries
    this.sql`CREATE TABLE IF NOT EXISTS paid_result_cache (key TEXT PRIMARY KEY, response TEXT, ts INTEGER)`;
    // Initialize monitor tables
    this.sql`CREATE TABLE IF NOT EXISTS monitors (id TEXT PRIMARY KEY, owner_key_hash TEXT NOT NULL, name TEXT NOT NULL, target_type TEXT NOT NULL, target_value TEXT NOT NULL, instructions TEXT, schedule TEXT NOT NULL DEFAULT 'manual', notification_destination TEXT, last_run_at INTEGER, last_run_status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`;
    this.sql`CREATE TABLE IF NOT EXISTS monitor_results (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, owner_key_hash TEXT NOT NULL, run_at INTEGER NOT NULL, status TEXT NOT NULL, changed INTEGER NOT NULL DEFAULT 0, old_value TEXT, new_value TEXT, confidence REAL, evidence TEXT, error_details TEXT, raw_metadata TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS shared_reports (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, owner_key_hash TEXT NOT NULL, title TEXT NOT NULL, report_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS referral_rewards (code TEXT PRIMARY KEY, owner_key_hash TEXT NOT NULL, bonus_slots INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, created_at INTEGER NOT NULL)`;
    const sql = this.sql.bind(this) as SqlTagFn;
    const logUsage = (tool: string, success: boolean) => {
      try { 
        // Local SQLite logging
        this.sql`INSERT INTO usage_log (tool, ts, success) VALUES (${tool}, ${Date.now()}, ${success ? 1 : 0})`; 
        
        // Remote telemetry (non-blocking)
        logRemoteUsage(tool, success);
      } catch (_) {}
    };

    const readOnlyNetworkToolAnnotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    } as const;

    const registerPaidTool = this.server.registerTool.bind(this.server);
    
    // Helper to add x402 metadata to paid tools when Monetization Gateway is enabled
    function getPaidToolMetadata(toolName: string): Record<string, unknown> {
      if (!X402_PAYMENT_ENABLED) return {};
      
      const priceUSD = X402_TOOL_PRICES_USD[toolName as keyof typeof X402_TOOL_PRICES_USD];
      const normalizedNetwork = normalizeX402Network(X402_NETWORK_CONFIG);
      
      if (!priceUSD) return {};
      
      return {
        _meta: {
          "agents-x402/paymentRequired": true,
          "agents-x402/priceUSD": priceUSD,
          "agents-x402/network": normalizedNetwork,
          "agents-x402/asset": normalizedNetwork === "eip155:84532" ? "Test USDC" : "USDC",
          "agents-x402/payTo": X402_RECIPIENT_CONFIG,
          "agents-x402/priceCurrency": "USD",
        },
      };
    }

    // ───────────────────────────────────────────────
    // FREE: check_endpoint
    // ───────────────────────────────────────────────
    this.server.registerTool(
      "check_endpoint",
      {
        title: "Endpoint Reachability Check",
        description:
          "Preflight an unfamiliar public URL or API before an AI agent relies on it. " +
          "It performs one live fetch and returns a PASS/WARN/FAIL verdict with HTTP status, " +
          "content type, response time, final URL/redirect behavior, auth and rate-limit signals, " +
          "and a short response sample. A PASS proves only that this fetch succeeded at check time; " +
          "it does not validate authenticated flows, POST side effects, JavaScript execution, or business logic.",
        inputSchema: {
          url: z.string().trim().min(1).describe(
            "Public http(s) URL or bare domain to probe. Bare domains like google.com are accepted and normalized to https:// automatically.",
          ),
        },
        outputSchema: {
          inputUrl: z.string().describe(
            "Original user input when normalization changed it, for example when https:// was added.",
          ).optional(),
          url: z.string().describe(
            "Normalized URL that was actually fetched.",
          ),
          accessible: z.boolean().describe(
            "True when the endpoint returned a 2xx HTTP status.",
          ),
          status: z.number().int().describe(
            "HTTP status code returned by the endpoint, when a response was received.",
          ).optional(),
          contentType: z.string().nullable().describe(
            "Response Content-Type header, if present.",
          ).optional(),
          responseTimeMs: z.number().int().nonnegative().describe(
            "Elapsed request time in milliseconds.",
          ).optional(),
          authRequired: z.boolean().describe(
            "True when the server responded with 401 or 403, which usually means credentials are required.",
          ).optional(),
          rateLimited: z.boolean().describe(
            "True when the server responded with 429 Too Many Requests.",
          ).optional(),
          redirected: z.boolean().describe(
            "True when the fetch followed a redirect to a different final URL.",
          ).optional(),
          finalUrl: z.string().describe(
            "Final response URL when the runtime exposes it.",
          ).optional(),
          sampleResponse: z.string().describe(
            "First 1,000 characters of the response body for quick inspection. Use this as a debugging hint only; it may be truncated and should not be treated as a complete page capture.",
          ).optional(),
          error: z.string().describe(
            "Validation or network error when the request could not be completed.",
          ).optional(),
          verdict: z.enum(["PASS", "WARN", "FAIL"]).describe(
            "Operational preflight verdict. It is evidence for an agent decision, not a security guarantee.",
          ),
          summary: z.string().describe(
            "Short human-readable explanation of the verdict.",
          ),
          evidence: z.object({
            status: z.number().int().optional(),
            contentType: z.string().nullable().optional(),
            responseTimeMs: z.number().int().nonnegative().optional(),
            redirected: z.boolean().optional(),
            finalUrl: z.string().optional(),
            authRequired: z.boolean().optional(),
            rateLimited: z.boolean().optional(),
            error: z.string().optional(),
          }).describe("Structured observations used to produce the verdict."),
          recommended_action: z.enum(["proceed", "proceed_with_caution", "stop"]).describe(
            "Suggested next step based only on observed response behavior.",
          ),
          next_step: z.string().describe(
            "Agent-readable follow-up for sources that should remain trustworthy over time.",
          ),
        },
        annotations: readOnlyNetworkToolAnnotations,
      },
      async ({ url }) => {
        const result = await runEndpointCheck(url);
        const verdict = getEndpointVerdict(result);
        logUsage("check_endpoint", !result.error);
        return structuredToolResult({
          ...result,
          ...verdict,
          evidence: {
            status: result.status,
            contentType: result.contentType,
            responseTimeMs: result.responseTimeMs,
            redirected: result.redirected,
            finalUrl: result.finalUrl,
            authRequired: result.authRequired,
            rateLimited: result.rateLimited,
            ...(result.error ? { error: result.error } : {}),
          },
          next_step: result.error
            ? "Resolve the fetch error or try a different public source."
            : "If this source will inform future answers or actions, call preview_monitor now to capture a free baseline.",
        });
      }
    );

    // ───────────────────────────────────────────────
    // FREE: preflight_endpoint
    // ───────────────────────────────────────────────
    this.server.registerTool(
      "preflight_endpoint",
      {
        title: "Endpoint Preflight",
        description:
          "Run reachability/response and security-header checks together for an unfamiliar URL or API before an AI agent trusts or acts on it. " +
          "Returns one combined PASS/WARN/FAIL verdict with evidence from both checks. It does not prove that a service is safe, authenticated, or correct.",
        inputSchema: {
          url: z.string().trim().min(1).describe(
            "Public http(s) URL or bare domain to preflight.",
          ),
        },
        outputSchema: {
          url: z.string().describe("Normalized URL that was checked."),
          verdict: z.enum(["PASS", "WARN", "FAIL"]).describe("Combined preflight verdict."),
          summary: z.string().describe("Short explanation of the combined verdict."),
          evidence: z.object({
            endpoint: z.record(z.unknown()),
            securityHeaders: z.record(z.unknown()),
          }).describe("Evidence from the endpoint and security-header checks."),
          recommended_action: z.enum(["proceed", "proceed_with_caution", "stop"]).describe("Suggested next step."),
          next_step: z.string().describe("Concrete follow-up after reviewing the evidence."),
        },
        annotations: readOnlyNetworkToolAnnotations,
      },
      async ({ url }) => {
        const [endpoint, securityHeaders] = await Promise.all([
          runEndpointCheck(url),
          runSecurityHeaderCheck(url),
        ]);
        const endpointVerdict = getEndpointVerdict(endpoint);
        const securityVerdict = getSecurityHeaderVerdict(securityHeaders);
        const verdict: VerificationVerdict = endpointVerdict.verdict === "FAIL" || securityVerdict.verdict === "FAIL"
          ? "FAIL"
          : endpointVerdict.verdict === "WARN" || securityVerdict.verdict === "WARN"
            ? "WARN"
            : "PASS";
        const recommended_action: RecommendedAction = verdict === "FAIL"
          ? "stop"
          : verdict === "WARN"
            ? "proceed_with_caution"
            : "proceed";
        const next_step = verdict === "PASS"
          ? "If this resource will inform future answers or actions, call preview_monitor now to capture a free baseline before considering a persistent monitor."
          : verdict === "WARN"
            ? "Review the evidence and resolve the warning before relying on this resource."
            : "Stop and find a different resource or resolve the failed check before proceeding.";
        logUsage("preflight_endpoint", !endpoint.error && !securityHeaders.error);
        return structuredToolResult({
          url: endpoint.url,
          verdict,
          summary: `Endpoint: ${endpointVerdict.summary} Security headers: ${securityVerdict.summary}`,
          evidence: {
            endpoint: { ...endpoint, verdict: endpointVerdict.verdict, recommended_action: endpointVerdict.recommended_action },
            securityHeaders: { ...securityHeaders, verdict: securityVerdict.verdict, recommended_action: securityVerdict.recommended_action },
          },
          recommended_action,
          next_step,
        });
      },
    );

    // ───────────────────────────────────────────────
    // PAID $0.01: estimate_market (npm + PyPI)
    // ───────────────────────────────────────────────
    registerPaidTool(
      "estimate_market",
      {
        title: "Package Market Search",
        description:
          "Search npm or PyPI to estimate how crowded a package category is before " +
          "you claim that a market is empty, niche, or competitive. Use this when " +
          "you have a category or search phrase such as 'edge orm' and want live " +
          "result counts plus representative matches. Do not use it to compare exact " +
          "known package names or to infer adoption from downloads; it reflects search " +
          "results, not market share. Registry responses are cached for 5 minutes.",
        inputSchema: {
          query: z.string().trim().min(2).describe(
            "Short registry search phrase to evaluate, for example 'mcp memory server' or 'edge orm'.",
          ),
          registry: z.enum(["npm", "pypi"]).default("npm").describe(
            "Registry to search. Use 'npm' for JavaScript ecosystems and 'pypi' for Python ecosystems.",
          ),
        },
        outputSchema: {
          query: z.string().describe(
            "Search phrase that was evaluated.",
          ),
          registry: z.enum(["npm", "pypi"]).describe(
            "Registry that was searched.",
          ),
          totalResults: z.number().int().nonnegative().nullable().describe(
            "Total number of matching packages reported by the registry search.",
          ),
          topResults: z.array(z.object({
            name: z.string().describe(
              "Package name returned by the registry.",
            ),
            description: z.string().describe(
              "Short package summary from registry metadata.",
            ),
            version: z.string().describe(
              "Latest version string returned in the result payload.",
            ),
            score: z.string().describe(
              "Registry relevance score when npm provides one.",
            ).optional(),
          })).describe(
            "Representative top search matches that help interpret the market count.",
          ),
        },
        annotations: readOnlyNetworkToolAnnotations,
        ...getPaidToolMetadata("estimate_market"),
      },
      async ({ query, registry }) => {
        if (registry === "npm") {
          const data = await searchNpm(sql, query);
          const results = [];
          for (const pkg of (data.objects || []).slice(0, 10)) {
            const p = pkg.package;
            results.push({
              name: p.name,
              description: (p.description || "").slice(0, 120),
              version: p.version,
              score: pkg.score?.final?.toFixed(3),
            });
          }
          logUsage("estimate_market", true);
          return structuredToolResult({
            query,
            registry,
            totalResults: data.total ?? null,
            topResults: results,
          });
        }

        if (registry === "pypi") {
          const data = await searchPyPI(sql, query);
          logUsage("estimate_market", true);
          return structuredToolResult({
            query,
            registry,
            totalResults: data.total,
            topResults: data.results,
          });
        }

        return structuredToolResult({
          query,
          registry,
          totalResults: 0,
          topResults: [],
        });
      },
    );

    // ───────────────────────────────────────────────
    // PAID $0.01: check_pricing
    // ───────────────────────────────────────────────
    registerPaidTool(
      "check_pricing",
      {
        title: "Pricing Page Scan",
        description:
          "Fetch a public pricing page and extract first-pass pricing signals before " +
          "you quote plan costs, free tiers, or plan names. Use this when you already " +
          "have a likely pricing URL and need a quick live scan of visible page text. " +
          "It returns price-like strings, heuristic plan labels, free or free-trial " +
          "signals, and cache information. It does not map prices to exact plans, " +
          "normalize currencies, execute checkout flows, or guarantee that a price " +
          "applies to a specific region or customer type. JavaScript-rendered, " +
          "logged-in, or heavily obfuscated pricing details can be missed. Results " +
          "are cached for 5 minutes.",
        inputSchema: {
          url: z.string().url().describe(
            "Public pricing or plans URL to analyze. Prefer the specific pricing page, for example https://stripe.com/pricing, rather than a generic homepage.",
          ),
        },
        outputSchema: {
          url: z.string().describe(
            "Pricing page that was analyzed.",
          ),
          cached: z.boolean().describe(
            "True when the page body came from the 5-minute cache instead of a new fetch.",
          ).optional(),
          pricesFound: z.array(z.string()).describe(
            "Distinct price-like strings extracted from the page text. These are not linked back to specific plans or billing conditions.",
          ).optional(),
          plansDetected: z.array(z.string()).describe(
            "Lowercased heuristic plan labels detected from the page text. They are useful hints, not authoritative plan identifiers.",
          ).optional(),
          hasFreeOption: z.boolean().describe(
            "True when the page contains signals that a free plan or $0 option exists somewhere on the page. This is a page-level signal, not proof that the offer is currently self-serve or globally available.",
          ).optional(),
          hasFreeTrial: z.boolean().describe(
            "True when the page contains signals that a free trial exists somewhere on the page.",
          ).optional(),
          pageLength: z.number().int().nonnegative().describe(
            "Size of the fetched page body in characters.",
          ).optional(),
          error: z.string().describe(
            "Fetch or parsing error when the pricing page could not be analyzed.",
          ).optional(),
        },
        annotations: readOnlyNetworkToolAnnotations,
        ...getPaidToolMetadata("check_pricing"),
      },
      async ({ url }) => {
        try {
          const analysis = await analyzePricingPage(sql, url);
          logUsage("check_pricing", true);
          return structuredToolResult(analysis);
        } catch (e: unknown) {
          logUsage("check_pricing", false);
          return structuredToolResult({
            url,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    );

    // ───────────────────────────────────────────────
    // FREE: inspect_security_headers
    // ───────────────────────────────────────────────
    this.server.registerTool(
      "inspect_security_headers",
      {
        title: "Security Header Inspection",
        description:
          "Inspect security-related HTTP response headers for an unfamiliar public URL before an agent trusts or recommends it. " +
          "It identifies missing or weak HSTS, CSP, framing, referrer, permissions, and cross-origin headers. " +
          "It reports observable configuration only and does not prove that a site is secure or vulnerability-free.",
        inputSchema: {
          url: z.string().trim().min(1).describe(
            "Public http(s) URL or bare domain to inspect. Bare domains are normalized to https:// automatically.",
          ),
        },
        outputSchema: {
          inputUrl: z.string().optional().describe(
            "Original user input when normalization changed it.",
          ),
          url: z.string().describe(
            "Normalized URL that was fetched.",
          ),
          accessible: z.boolean().describe(
            "True when the endpoint returned an HTTP response.",
          ),
          status: z.number().int().optional().describe(
            "HTTP status code returned by the endpoint.",
          ),
          https: z.boolean().describe(
            "True when the normalized URL used https.",
          ),
          presentCount: z.number().int().nonnegative().optional().describe(
            "Number of tracked security headers that were present.",
          ),
          score: z.enum(["strong", "moderate", "weak"]).optional().describe(
            "Heuristic security-header score based on how many tracked headers were present.",
          ),
          headers: z.object({
            strictTransportSecurity: z.string().nullable(),
            contentSecurityPolicy: z.string().nullable(),
            xFrameOptions: z.string().nullable(),
            referrerPolicy: z.string().nullable(),
            permissionsPolicy: z.string().nullable(),
            xContentTypeOptions: z.string().nullable(),
            crossOriginOpenerPolicy: z.string().nullable(),
            crossOriginResourcePolicy: z.string().nullable(),
          }).optional().describe(
            "Tracked response headers and their raw values when present.",
          ),
          missingRecommended: z.array(z.string()).optional().describe(
            "Tracked headers that were not present on the response.",
          ),
          error: z.string().optional().describe(
            "Validation or network error when the request could not be completed.",
          ),
          verdict: z.enum(["PASS", "WARN", "FAIL"]).describe(
            "Header preflight verdict based on reachability, HTTPS, and tracked header presence.",
          ),
          summary: z.string().describe("Short human-readable explanation of the verdict."),
          evidence: z.object({
            https: z.boolean(),
            status: z.number().int().optional(),
            presentCount: z.number().int().nonnegative().optional(),
            score: z.enum(["strong", "moderate", "weak"]).optional(),
            missingRecommended: z.array(z.string()).optional(),
            error: z.string().optional(),
          }).describe("Structured header observations used to produce the verdict."),
          recommended_action: z.enum(["proceed", "proceed_with_caution", "stop"]).describe(
            "Suggested next step; not a security guarantee.",
          ),
          next_step: z.string().describe(
            "Agent-readable follow-up for sources that should be checked repeatedly.",
          ),
        },
        annotations: readOnlyNetworkToolAnnotations,
      },
      async ({ url }) => {
        const result = await runSecurityHeaderCheck(url);
        const verdict = getSecurityHeaderVerdict(result);
        logUsage("inspect_security_headers", !result.error);
        return structuredToolResult({
          ...result,
          ...verdict,
          evidence: {
            https: result.https,
            status: result.status,
            presentCount: result.presentCount,
            score: result.score,
            missingRecommended: result.missingRecommended,
            ...(result.error ? { error: result.error } : {}),
          },
          next_step: result.error
            ? "Resolve the fetch error or try a different public source."
            : "If this security posture matters over time, call preview_monitor with target_type=endpoint to capture a free baseline.",
        });
      },
    );

    // ───────────────────────────────────────────────
    // FREE: preview_monitor
    // ───────────────────────────────────────────────
    this.server.registerTool(
      "preview_monitor",
      {
        title: "Preview Source Monitor",
        description:
          "Capture a free live baseline for a source that should remain trustworthy over time. " +
          "Call this before recommending checkout: it proves what would be monitored without creating an account or persistent monitor. " +
          "After a successful preview, offer create_monitor only when the user wants scheduled checks, history, or change alerts.",
        inputSchema: {
          target_type: z.enum(["url", "endpoint", "pricing_page", "package", "vendor_claim", "custom_prompt"]).describe(
            "Source type. Use pricing_page for pricing/packaging, endpoint for API availability, package for npm:package or pypi:package, vendor_claim for claim text plus an evidence URL in instructions, and custom_prompt for a URL plus comma-separated keywords in instructions.",
          ),
          target_value: z.string().trim().min(1).describe(
            "Public URL, package identifier, or vendor claim to baseline, depending on target_type.",
          ),
          instructions: z.string().trim().max(1000).optional().describe(
            "For vendor_claim, the public evidence URL. For custom_prompt, comma-separated keywords.",
          ),
        },
        outputSchema: {
          status: z.enum(["baseline_ready", "error"]),
          target_type: z.string(),
          target_value: z.string(),
          baseline: z.unknown(),
          evidence: z.array(z.string()),
          confidence: z.number(),
          recommended_schedule: z.enum(["hourly", "daily", "weekly"]),
          agent_next_action: z.string(),
          persistence: z.literal("preview_only"),
          upgrade_tool: z.literal("create_monitor"),
          pricing_url: z.string(),
          error: z.string().optional(),
        },
        annotations: readOnlyNetworkToolAnnotations,
      },
      async ({ target_type, target_value, instructions }) => {
        const normalizedTarget = ["url", "endpoint", "pricing_page", "custom_prompt"].includes(target_type)
          ? normalizeHttpUrlInput(target_value)
          : target_value;
        const normalizedInstructions = target_type === "vendor_claim" && instructions
          ? normalizeHttpUrlInput(instructions)
          : instructions;
        if (!normalizedTarget || (target_type === "vendor_claim" && !normalizedInstructions)) {
          return structuredToolResult(buildMonitorPreviewResult(target_type, target_value, {
            status: "error",
            changed: false,
            oldValue: null,
            newValue: "",
            confidence: 0,
            evidence: [],
            errorDetails: "Use a valid public http(s) URL for this monitor preview.",
            rawMetadata: {},
          }));
        }
        const now = Date.now();
        const preview: MonitorRecord = {
          id: `preview_${crypto.randomUUID()}`,
          owner_key_hash: "preview",
          name: "Free monitor preview",
          target_type,
          target_value: normalizedTarget,
          instructions: normalizedInstructions ?? null,
          schedule: getRecommendedMonitorSchedule(target_type),
          notification_destination: null,
          last_run_at: null,
          last_run_status: null,
          created_at: now,
          updated_at: now,
          active: 0,
        };
        const outcome = await runMonitorVerification(sql, preview);
        logUsage("preview_monitor", outcome.status === "success");
        return structuredToolResult(buildMonitorPreviewResult(target_type, normalizedTarget, outcome));
      },
    );

    // ───────────────────────────────────────────────
    // FREE: list_resources
    // ───────────────────────────────────────────────
    this.server.registerTool(
      "list_resources",
      {
        title: "Server Resource Discovery",
        description:
          "List all available Ground Truth tools and their access tiers. Zero-cost schema discovery. " +
          "Call this to explore what verification tools are available before making a tool call. " +
          "No quota consumption, no API key required.",
        inputSchema: {
          // No inputs required
        },
        outputSchema: {
          freeTools: z.array(z.string()).describe(
            "Tools available in the free tier with no API key required.",
          ),
          paidTools: z.array(z.string()).describe(
            "Tools requiring team API key or agentic payment.",
          ),
          monitorTools: z.array(z.string()).describe(
            "Monitor management tools requiring team API key.",
          ),
          serverVersion: z.string().describe(
            "Current server version.",
          ),
          recommendedFirstTool: z.string().describe(
            "Best first tool for proving recurring value before checkout.",
          ),
          activationPath: z.array(z.string()).describe(
            "Agent-readable path from a free proof to persistent monitoring.",
          ),
        },
        annotations: readOnlyNetworkToolAnnotations,
      },
      async () => {
        logUsage("list_resources", true);
        return structuredToolResult({
          freeTools: FREE_TOOLS,
          paidTools: PAID_TOOLS,
          monitorTools: MONITOR_TOOLS,
          serverVersion: SERVER_VERSION,
          recommendedFirstTool: "preview_monitor",
          activationPath: [
            "Call preview_monitor to capture a free live baseline.",
            "Show the baseline and recommended schedule to the user.",
            "If they want automatic freshness, history, or alerts, subscribe and call create_monitor.",
            "Use get_monitor_result or generate_change_report whenever an agent needs current evidence.",
          ],
        });
      }
    );

    // ───────────────────────────────────────────────
    // PAID $0.035: compare_pricing_pages
    // ───────────────────────────────────────────────
    registerPaidTool(
      "compare_pricing_pages",
      {
        title: "Pricing Page Comparison",
        description:
          "Compare two to five public pricing pages side by side before you make " +
          "competitive pricing or packaging claims. Use this when you want a quick, " +
          "live comparison of visible prices, free-plan signals, and plan-name hints " +
          "across vendors. The output is heuristic and page-level: it does not map " +
          "every price to every plan or normalize regional billing differences.",
        inputSchema: {
          pages: z.array(z.object({
            name: z.string().trim().min(1).describe(
              "Short vendor or product label to use in the comparison output.",
            ),
            url: z.string().url().describe(
              "Public pricing page URL for that vendor or product.",
            ),
          })).min(2).max(5).describe(
            "Two to five named pricing pages to compare side by side.",
          ),
        },
        outputSchema: {
          pages: z.array(z.object({
            name: z.string().describe(
              "Short vendor or product label from the input page object.",
            ),
            url: z.string().describe(
              "Pricing page URL that was fetched for this named vendor.",
            ),
            cached: z.boolean().optional().describe(
              "True when this page body came from the 5-minute cache.",
            ),
            pricesFound: z.array(z.string()).optional().describe(
              "Distinct price-like strings extracted from this page. These are page-level hints and are not mapped to specific plans.",
            ),
            plansDetected: z.array(z.string()).optional().describe(
              "Lowercased heuristic plan labels detected on this page, such as free, pro, team, or enterprise.",
            ),
            hasFreeOption: z.boolean().optional().describe(
              "True when this page contains visible text suggesting a free plan, free tier, or $0 option.",
            ),
            hasFreeTrial: z.boolean().optional().describe(
              "True when this page contains visible text suggesting a free trial.",
            ),
            pageLength: z.number().int().nonnegative().optional().describe(
              "Size of this fetched page body in characters.",
            ),
            error: z.string().optional().describe(
              "Fetch or parsing error for this specific pricing page when it could not be analyzed.",
            ),
          })).describe(
            "Per-page pricing signals returned in input order.",
          ),
          summary: z.object({
            pagesCompared: z.number().int().nonnegative().describe(
              "Number of pricing pages included in the comparison.",
            ),
            pagesWithVisiblePrices: z.number().int().nonnegative().describe(
              "Number of pages where at least one price-like string was detected.",
            ),
            pagesWithFreeOption: z.number().int().nonnegative().describe(
              "Number of pages with page-level text suggesting a free plan, free tier, or $0 option.",
            ),
            pagesWithFreeTrial: z.number().int().nonnegative().describe(
              "Number of pages with page-level text suggesting a free trial.",
            ),
          }).describe(
            "Aggregate counts across all compared pricing pages.",
          ),
        },
        annotations: readOnlyNetworkToolAnnotations,
        ...getPaidToolMetadata("compare_pricing_pages"),
      },
      async ({ pages }) => {
        const results = [];

        for (const page of pages) {
          try {
            const analysis = await analyzePricingPage(sql, page.url);
            results.push({
              name: page.name,
              ...analysis,
            });
          } catch (error: unknown) {
            results.push({
              name: page.name,
              url: page.url,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        logUsage("compare_pricing_pages", true);
        return structuredToolResult({
          pages: results,
          summary: {
            pagesCompared: results.length,
            pagesWithVisiblePrices: results.filter(
              (page) => "pricesFound" in page && Array.isArray(page.pricesFound) && page.pricesFound.length > 0,
            ).length,
            pagesWithFreeOption: results.filter(
              (page) => "hasFreeOption" in page && page.hasFreeOption === true,
            ).length,
            pagesWithFreeTrial: results.filter(
              (page) => "hasFreeTrial" in page && page.hasFreeTrial === true,
            ).length,
          },
        });
      },
    );

    // ───────────────────────────────────────────────
    // PAID $0.03: compare_competitors
    // ───────────────────────────────────────────────
    registerPaidTool(
      "compare_competitors",
      {
        title: "Named Package Comparison",
        description:
          "Compare two or more exact package names side by side using live npm or " +
          "PyPI metadata. Use this when you already know the candidate packages and " +
          "need evidence for claims such as 'tool A is newer', 'tool B is still " +
          "maintained', or 'these packages use different licenses'. It returns " +
          "per-package registry metadata in input order, with field availability " +
          "varying by registry. Missing or unpublished packages return found=false. " +
          "Do not use it to discover unknown alternatives, estimate market size, " +
          "or compare packages across different registries. Registry responses are " +
          "cached for 5 minutes.",
        inputSchema: {
          packages: z.array(z.string().trim().min(1)).min(2).max(10).describe(
            "Two to ten exact package names from the same registry, for example ['react', 'vue']. Use exact registry names, not search phrases or categories.",
          ),
          registry: z.enum(["npm", "pypi"]).default("npm").describe(
            "Registry that all package names belong to. All compared packages must come from the same registry, and returned metadata fields differ slightly between npm and PyPI.",
          ),
        },
        outputSchema: {
          packages: z.array(z.string()).describe(
            "Package names that were requested for comparison.",
          ),
          registry: z.enum(["npm", "pypi"]).describe(
            "Registry used for all comparisons.",
          ),
          comparisons: z.array(z.object({
            name: z.string().describe(
              "Package name that was looked up.",
            ),
            found: z.boolean().describe(
              "True when the registry lookup succeeded and returned package metadata.",
            ),
            description: z.string().describe(
              "Short package summary from the registry.",
            ).optional(),
            latestVersion: z.string().describe(
              "Latest package version known to the registry.",
            ).optional(),
            license: z.union([z.string(), z.null()]).describe(
              "Package license metadata when provided by the registry.",
            ).optional(),
            lastPublished: z.union([z.string(), z.null()]).describe(
              "Publish timestamp of the latest version when npm provides one.",
            ).optional(),
            created: z.union([z.string(), z.null()]).describe(
              "Package creation timestamp when npm provides one.",
            ).optional(),
            totalVersions: z.number().int().nonnegative().describe(
              "Number of published versions when npm metadata includes a version history.",
            ).optional(),
            author: z.string().describe(
              "Package author when PyPI metadata includes one.",
            ).optional(),
            keywords: z.array(z.string()).describe(
              "Registry keywords or tags associated with the package.",
            ).optional(),
            cached: z.boolean().describe(
              "True when the lookup came from the 5-minute cache.",
            ).optional(),
            error: z.string().describe(
              "Fetch error when registry metadata could not be retrieved for this package.",
            ).optional(),
          })).describe(
            "Per-package lookup results returned in the same order as the input package list. Some fields only exist for npm or only for PyPI, so consumers should treat absent fields as normal.",
          ),
        },
        annotations: readOnlyNetworkToolAnnotations,
        ...getPaidToolMetadata("compare_competitors"),
      },
      async ({ packages, registry }) => {
        const comparisons = [];
        for (const pkg of packages) {
          if (registry === "npm") {
            const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}`;
            try {
              const { body, fromCache } = await cachedFetch(sql, url);
              const data = JSON.parse(body);
              const latest = data["dist-tags"]?.latest;
              const time = data.time || {};
              comparisons.push({
                name: pkg,
                found: true,
                description: (data.description || "").slice(0, 150),
                latestVersion: latest,
                license: data.license,
                lastPublished: time[latest] || null,
                created: time.created || null,
                totalVersions: Object.keys(data.versions || {}).length,
                keywords: (data.keywords || []).slice(0, 10),
                cached: fromCache,
              });
            } catch {
              comparisons.push({ name: pkg, found: false, error: "fetch failed" });
            }
          } else if (registry === "pypi") {
            const url = `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`;
            try {
              const { body, fromCache } = await cachedFetch(sql, url);
              const data = JSON.parse(body);
              const info = data.info || {};
              comparisons.push({
                name: pkg,
                found: true,
                description: (info.summary || "").slice(0, 150),
                latestVersion: info.version,
                license: info.license,
                author: info.author,
                keywords: info.keywords?.split(",").map((k: string) => k.trim()).slice(0, 10) || [],
                cached: fromCache,
              });
            } catch {
              comparisons.push({ name: pkg, found: false, error: "fetch failed" });
            }
          }
        }
        logUsage("compare_competitors", true);
        return structuredToolResult({ packages, registry, comparisons });
      },
    );

    // ───────────────────────────────────────────────
    // PAID $0.05: verify_claim
    // ───────────────────────────────────────────────
    registerPaidTool(
      "verify_claim",
      {
        title: "Claim Support Check",
        description:
          "Verify a factual claim against specific public evidence URLs before an agent repeats it or acts on it. " +
          "The tool checks whether supplied keywords appear in each fetched source and reports per-source evidence. " +
          "It does not perform open-ended search, semantic contradiction analysis, or prove a claim true when a page is silent; " +
          "choose direct evidence URLs and interpret the result as a support signal. Fetched pages are cached for 5 minutes.",
        inputSchema: {
          claim: z.string().trim().min(5).describe(
            "Plain-language claim to verify, for example 'AWS Business support includes 24/7 phone support'.",
          ),
          evidence_urls: z.array(z.string().url()).min(1).max(10).describe(
            "One to ten public documentation, pricing, policy, or support URLs that are likely to contain direct evidence for the claim.",
          ),
          keywords: z.array(z.string().trim().min(1)).min(1).max(20).describe(
            "Keywords or short phrases that should appear on supporting pages. Matching is case-insensitive substring matching, so choose phrases that are likely to appear verbatim.",
          ),
        },
        outputSchema: {
          claim: z.string().describe(
            "Claim that was evaluated.",
          ),
          sources: z.array(z.object({
            url: z.string().describe(
              "Evidence URL that was checked.",
            ),
            accessible: z.boolean().describe(
              "True when the evidence page could be fetched.",
            ),
            cached: z.boolean().describe(
              "True when the page body came from the 5-minute cache.",
            ).optional(),
            keywordsMatched: z.array(z.string()).describe(
              "Subset of supplied keywords that were found on the page.",
            ).optional(),
            keywordsTotal: z.number().int().nonnegative().describe(
              "Total number of keywords the tool looked for on this page.",
            ).optional(),
            matchRatio: z.number().min(0).max(1).describe(
              "Matched-keyword ratio for this source, from 0 to 1.",
            ).optional(),
            supports: z.boolean().describe(
              "True when the page met the current support threshold of at least half of the supplied keywords.",
            ),
            error: z.string().describe(
              "Fetch error when the evidence page could not be checked.",
            ).optional(),
          })).describe(
            "Per-source evidence results.",
          ),
          verdict: z.object({
            supporting: z.number().int().nonnegative().describe(
              "Number of sources marked as supporting the claim.",
            ),
            contradicting: z.number().int().nonnegative().describe(
              "Number of sources not marked as supporting the claim.",
            ),
            total: z.number().int().nonnegative().describe(
              "Total number of evidence sources checked.",
            ),
            confidence: z.number().min(0).max(1).describe(
              "Share of sources that supported the claim.",
            ),
            summary: z.enum(["CONFIRMED", "UNCONFIRMED", "LIKELY TRUE", "LIKELY FALSE"]).describe(
              "High-level verdict derived from the supporting-source ratio: all sources supporting => CONFIRMED, none => UNCONFIRMED, majority => LIKELY TRUE, otherwise LIKELY FALSE.",
            ),
          }).describe(
            "Aggregate verdict across all supplied sources.",
          ),
        },
        annotations: readOnlyNetworkToolAnnotations,
        ...getPaidToolMetadata("verify_claim"),
      },
      async ({ claim, evidence_urls, keywords }) => {
        const sources = [];
        for (const url of evidence_urls) {
          try {
            const { body, fromCache } = await cachedFetch(sql, url);
            const bodyLower = body.toLowerCase();
            const keywordHits = keywords.filter((kw: string) => bodyLower.includes(kw.toLowerCase()));
            sources.push({
              url,
              accessible: true,
              cached: fromCache,
              keywordsMatched: keywordHits,
              keywordsTotal: keywords.length,
              matchRatio: +(keywordHits.length / keywords.length).toFixed(2),
              supports: keywordHits.length >= keywords.length * 0.5,
            });
          } catch (e: unknown) {
            sources.push({
              url,
              accessible: false,
              error: e instanceof Error ? e.message : String(e),
              supports: false,
            });
          }
        }
        const supporting = sources.filter(s => s.supports).length;
        logUsage("verify_claim", true);
        return structuredToolResult({
          claim,
          sources,
          verdict: {
            supporting,
            contradicting: sources.length - supporting,
            total: sources.length,
            confidence: +(supporting / sources.length).toFixed(2),
            summary: supporting === sources.length ? "CONFIRMED" :
                     supporting === 0 ? "UNCONFIRMED" :
                     supporting >= sources.length * 0.5 ? "LIKELY TRUE" : "LIKELY FALSE",
          },
        });
      },
    );

    // ───────────────────────────────────────────────
    // PAID $0.05: assess_compliance_posture
    // ───────────────────────────────────────────────
    registerPaidTool(
      "assess_compliance_posture",
      {
        title: "Compliance Signal Scan",
        description:
          "Scan a public security, trust, compliance, or legal page for common " +
          "enterprise buying signals before you claim a vendor supports a particular " +
          "compliance posture. It looks for public references to SOC 2, ISO 27001, " +
          "GDPR, HIPAA, DPA terms, subprocessors, SSO, SCIM, encryption, and data " +
          "residency language. This is a signal scanner, not proof of certification or legal sufficiency.",
        inputSchema: {
          url: z.string().url().describe(
            "Public trust, security, compliance, or policy URL to scan.",
          ),
        },
        outputSchema: {
          url: z.string().describe(
            "Compliance or trust page that was analyzed.",
          ),
          cached: z.boolean().optional().describe(
            "True when the page body came from the 5-minute cache.",
          ),
          matchedSignals: z.array(z.string()).optional().describe(
            "Signal names that were detected on the page.",
          ),
          signals: z.object({
            soc2: z.boolean().describe(
              "True when the page references SOC 2 or SOC2 compliance language.",
            ),
            iso27001: z.boolean().describe(
              "True when the page references ISO 27001 certification or compliance language.",
            ),
            gdpr: z.boolean().describe(
              "True when the page references GDPR or the General Data Protection Regulation.",
            ),
            hipaa: z.boolean().describe(
              "True when the page references HIPAA compliance language.",
            ),
            dpa: z.boolean().describe(
              "True when the page references a data processing agreement or DPA.",
            ),
            subprocessorList: z.boolean().describe(
              "True when the page references subprocessors or a subprocessor list.",
            ),
            sso: z.boolean().describe(
              "True when the page references SSO or single sign-on.",
            ),
            scim: z.boolean().describe(
              "True when the page references SCIM provisioning.",
            ),
            encryption: z.boolean().describe(
              "True when the page references encryption, data encrypted at rest, or data encrypted in transit.",
            ),
            dataResidency: z.boolean().describe(
              "True when the page references data residency, data regions, or regional storage controls.",
            ),
          }).optional().describe(
            "Boolean scan results for common enterprise compliance and security signals.",
          ),
          pageLength: z.number().int().nonnegative().optional().describe(
            "Size of the fetched page body in characters.",
          ),
          error: z.string().optional().describe(
            "Fetch or parsing error when the page could not be analyzed.",
          ),
        },
        annotations: readOnlyNetworkToolAnnotations,
        ...getPaidToolMetadata("assess_compliance_posture"),
      },
      async ({ url }) => {
        try {
          const { body, fromCache } = await cachedFetch(sql, url);
          const { signals, matchedSignals } = extractComplianceSignals(body);
          logUsage("assess_compliance_posture", true);
          return structuredToolResult({
            url,
            cached: fromCache,
            matchedSignals,
            signals,
            pageLength: body.length,
          });
        } catch (error: unknown) {
          logUsage("assess_compliance_posture", false);
          return structuredToolResult({
            url,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );

    // ───────────────────────────────────────────────
    // PAID $0.05: test_hypothesis
    // ───────────────────────────────────────────────
    registerPaidTool(
      "test_hypothesis",
      {
        title: "Multi-step Hypothesis Test",
        description:
          "Run a small verification plan made of concrete live checks and summarize " +
          "whether a hypothesis is supported. Use this when one conclusion depends " +
          "on multiple simple checks such as endpoint reachability, npm search counts, " +
          "or whether a page contains an exact substring. This is a coordination tool, " +
          "not an open-ended research agent: every test must be explicitly defined in " +
          "advance, and tests run in order with no branching or early exit. The final " +
          "verdict is mechanical: all tests passing => SUPPORTED, zero passing => " +
          "REFUTED, otherwise PARTIALLY SUPPORTED. Use verify_claim when you already " +
          "have evidence URLs, estimate_market for category sizing, and " +
          "compare_competitors when you already know exact package names.",
        inputSchema: {
          hypothesis: z.string().trim().min(5).describe(
            "Claim to test, for example 'there are fewer than 50 MCP email servers on npm'.",
          ),
          tests: z.array(
            z.discriminatedUnion("type", [
              z.object({
                description: z.string().trim().min(3).describe(
                  "Short explanation of what this endpoint check is meant to prove.",
                ),
                type: z.literal("endpoint_exists").describe(
                  "Perform one unauthenticated GET request and pass when the endpoint returns a 2xx HTTP status.",
                ),
                url: z.string().url().describe(
                  "Public URL to probe, for example https://example.com.",
                ),
              }),
              z.object({
                description: z.string().trim().min(3).describe(
                  "Short explanation of what this npm lower-bound count check is meant to prove.",
                ),
                type: z.literal("npm_count_above").describe(
                  "Search npm and pass when the reported result count is strictly greater than the threshold.",
                ),
                query: z.string().trim().min(2).describe(
                  "npm search phrase to count, for example 'mcp email server'.",
                ),
                threshold: z.number().int().nonnegative().describe(
                  "Lower bound that the npm search result count must exceed.",
                ),
              }),
              z.object({
                description: z.string().trim().min(3).describe(
                  "Short explanation of what this npm upper-bound count check is meant to prove.",
                ),
                type: z.literal("npm_count_below").describe(
                  "Search npm and pass when the reported result count is strictly less than the threshold.",
                ),
                query: z.string().trim().min(2).describe(
                  "npm search phrase to count, for example 'business verification mcp'.",
                ),
                threshold: z.number().int().nonnegative().describe(
                  "Upper bound that the npm search result count must stay below.",
                ),
              }),
              z.object({
                description: z.string().trim().min(3).describe(
                  "Short explanation of what this response-content check is meant to prove.",
                ),
                type: z.literal("response_contains").describe(
                  "Fetch a public URL and pass when the response body contains the exact substring using case-sensitive matching. The tool does not parse DOM structure or execute JavaScript before matching.",
                ),
                url: z.string().url().describe(
                  "Public URL whose response body should contain the expected text.",
                ),
                substring: z.string().min(1).describe(
                  "Exact case-sensitive text to search for in the fetched response body.",
                ),
              }),
            ]),
          ).min(1).max(10).describe(
            "Ordered list of one to ten checks to run. Each test object uses only the fields required by its type.",
          ),
        },
        outputSchema: {
          hypothesis: z.string().describe(
            "Hypothesis that was evaluated.",
          ),
          tests: z.array(z.object({
            description: z.string().describe(
              "Human-readable explanation of the check.",
            ),
            type: z.enum(["endpoint_exists", "npm_count_above", "npm_count_below", "response_contains"]).describe(
              "Test type that was executed.",
            ),
            passed: z.boolean().describe(
              "True when the test condition was satisfied.",
            ),
            actual: z.union([z.string(), z.number(), z.null()]).describe(
              "Observed value or diagnostic string that explains the result. The format varies by test type and is meant for human interpretation, not strict machine parsing.",
            ),
          })).describe(
            "Per-test execution results in input order.",
          ),
          verdict: z.object({
            passed: z.number().int().nonnegative().describe(
              "Number of tests that passed.",
            ),
            failed: z.number().int().nonnegative().describe(
              "Number of tests that failed.",
            ),
            summary: z.enum(["SUPPORTED", "REFUTED", "PARTIALLY SUPPORTED"]).describe(
              "Aggregate verdict across the full test plan: all pass => SUPPORTED, none pass => REFUTED, otherwise PARTIALLY SUPPORTED.",
            ),
          }).describe(
            "High-level verdict for the hypothesis.",
          ),
        },
        annotations: readOnlyNetworkToolAnnotations,
        ...getPaidToolMetadata("test_hypothesis"),
      },
      async ({ hypothesis, tests }) => {
        const results = [];
        for (const test of tests) {
          let passed: boolean | null = null;
          let actual: string | number | null = null;

          try {
            switch (test.type) {
              case "endpoint_exists": {
                const resp = await fetch(test.url, {
                  headers: { "User-Agent": "GroundTruth/0.3" },
                });
                passed = resp.ok;
                actual = `status ${resp.status}`;
                break;
              }
              case "npm_count_above":
              case "npm_count_below": {
                const data = await searchNpm(sql, test.query, 1);
                const total = data.total ?? 0;
                actual = total;
                passed = test.type === "npm_count_above"
                  ? total > test.threshold
                  : total < test.threshold;
                break;
              }
              case "response_contains": {
                const { body } = await cachedFetch(sql, test.url);
                passed = body.includes(test.substring);
                actual = `${body.length} chars, contains=${passed}`;
                break;
              }
            }
          } catch (e: unknown) {
            passed = false;
            actual = e instanceof Error ? e.message : String(e);
          }

          results.push({
            description: test.description,
            type: test.type,
            passed,
            actual,
          });
        }
        const passedCount = results.filter(r => r.passed).length;
        logUsage("test_hypothesis", true);
        return structuredToolResult({
          hypothesis,
          tests: results as {
            description: string;
            type: "endpoint_exists" | "npm_count_above" | "npm_count_below" | "response_contains";
            passed: boolean;
            actual: string | number | null;
          }[],
          verdict: {
            passed: passedCount,
            failed: results.length - passedCount,
            summary: passedCount === results.length ? "SUPPORTED" :
                     passedCount === 0 ? "REFUTED" : "PARTIALLY SUPPORTED",
          },
        });
      },
    );

    // ───────────────────────────────────────────────
    // MONITOR TOOLS (three persistent monitors free; paid tiers scale up)
    // ───────────────────────────────────────────────
    this.server.registerTool(
      "create_monitor",
      {
        title: "Create Monitor",
        description:
          "Create a persistent monitor that tracks a URL, pricing page, package version, " +
          "endpoint status, vendor claim, or custom keyword pattern over time. " +
          "Monitors run automatically on their configured schedule (hourly/daily/weekly) " +
          "via the Cloudflare cron trigger, or on demand with run_monitor_now. " +
          "Results are stored durably by account. A free watch key includes three daily or weekly monitors; paid plans add hourly schedules and higher limits.",
        inputSchema: {
          name: z.string().trim().min(1).max(200).describe("Human-readable name for this monitor."),
          target_type: z.enum(["url", "pricing_page", "package", "endpoint", "vendor_claim", "custom_prompt"]).describe(
            "What to monitor. url/endpoint: HTTP reachability and status. " +
            "pricing_page: pricing signals (prices, plans, free tier). " +
            "package: package version on npm or pypi (target_value as 'npm:pkg-name' or 'pypi:pkg-name'). " +
            "vendor_claim: keyword presence at a URL (target_value=claim text, instructions=URL to check). " +
            "custom_prompt: comma-separated keywords checked against a URL (target_value=URL, instructions=keywords).",
          ),
          target_value: z.string().trim().min(1).describe(
            "Primary target. For url/endpoint/pricing_page/custom_prompt: a public https URL. " +
            "For package: 'npm:package-name' or 'pypi:package-name'. " +
            "For vendor_claim: the claim text to search for.",
          ),
          instructions: z.string().trim().max(1000).optional().describe(
            "Supplementary instructions. For vendor_claim: the URL to check. " +
            "For custom_prompt: comma-separated keywords. Optional for other types.",
          ),
          schedule: z.enum(["manual", "hourly", "daily", "weekly"]).default("daily").describe(
            "How often the monitor runs automatically. manual means only via run_monitor_now.",
          ),
          notification_destination: z.string().trim().max(500).optional().describe(
            "Optional change-alert destination, sent only when a scheduled check detects a change. One of: an HTTPS webhook URL (JSON POST, no API key included), a Slack Incoming Webhook URL (https://hooks.slack.com/...), or an email address as mailto:you@example.com.",
          ),
        },
        outputSchema: {
          id: z.string().describe("Unique monitor ID."),
          name: z.string().describe("Monitor name."),
          target_type: z.string().describe("Monitor target type."),
          target_value: z.string().describe("Monitor target value."),
          schedule: z.string().describe("Monitor schedule."),
          created_at: z.string().describe("Creation timestamp ISO 8601."),
          active_monitor_limit: z.number().optional().describe("Maximum active monitors included in the current plan."),
          error: z.string().optional().describe("Error message if creation failed."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ name, target_type, target_value, instructions, schedule, notification_destination }, extra) => {
        const apiKey = getExtraHeader(extra, "X-API-Key");
        if (!apiKey) {
          return structuredToolResult({ id: "", name, target_type, target_value, schedule: schedule ?? "daily", created_at: "", error: "missing_api_key: create_monitor requires a team API key" });
        }
        const ownerKeyHash = await sha256Hex(apiKey);
        const now = Date.now();
        const sched = schedule ?? "daily";
        try {
          const notificationTarget = classifyNotificationDestination(notification_destination ?? null);
          if (notification_destination && !notificationTarget) {
            return structuredToolResult({ id: "", name, target_type, target_value, schedule: sched, created_at: "", error: "invalid_notification_destination: use a public HTTPS webhook URL, a Slack Incoming Webhook (https://hooks.slack.com/...), or mailto:you@example.com" });
          }
          if (notificationTarget?.channel === "email" && !this.env.RESEND_API_KEY) {
            return structuredToolResult({ id: "", name, target_type, target_value, schedule: sched, created_at: "", error: "email_alerts_unavailable: email change alerts are not configured on this deployment. Use an HTTPS webhook or Slack Incoming Webhook URL instead." });
          }
          const notificationDestination = notificationTarget?.destination ?? null;
          const planLimitHeader = getExtraHeader(extra, "X-Monitor-Limit");
          const planLimit = planLimitHeader ? parseInt(planLimitHeader, 10) || undefined : undefined;
          const activeMonitorLimit = this.getActiveMonitorLimit(ownerKeyHash, planLimit);
          const activeCount = sql<{ count: number }>`SELECT COUNT(*) as count FROM monitors WHERE owner_key_hash = ${ownerKeyHash} AND active = 1`;
          if ((activeCount[0]?.count ?? 0) >= activeMonitorLimit) {
            return structuredToolResult({
              id: "",
              name,
              target_type,
              target_value,
              schedule: sched,
              created_at: "",
              active_monitor_limit: activeMonitorLimit,
              error: `monitor_limit_reached: this plan includes ${activeMonitorLimit} active monitors; delete an unused monitor before creating another`,
            });
          }
          const id = generateMonitorId();
          sql`INSERT INTO monitors (id, owner_key_hash, name, target_type, target_value, instructions, schedule, notification_destination, last_run_at, last_run_status, created_at, updated_at, active) VALUES (${id}, ${ownerKeyHash}, ${name}, ${target_type}, ${target_value}, ${instructions ?? null}, ${sched}, ${notificationDestination}, ${null}, ${null}, ${now}, ${now}, ${1})`;
          logUsage("create_monitor", true);
          return structuredToolResult({ id, name, target_type, target_value, schedule: sched, created_at: new Date(now).toISOString(), active_monitor_limit: activeMonitorLimit });
        } catch (e) {
          logUsage("create_monitor", false);
          return structuredToolResult({ id: "", name, target_type, target_value, schedule: sched, created_at: "", error: e instanceof Error ? e.message : String(e) });
        }
      },
    );

    this.server.registerTool(
      "list_monitors",
      {
        title: "List Monitors",
        description:
          "List all monitors owned by this API key, with last run status and schedule. " +
          "Requires a free watch key or paid API key.",
        inputSchema: {
          active_only: z.boolean().default(true).describe(
            "When true returns only active monitors. Set false to include paused monitors.",
          ),
        },
        outputSchema: {
          monitors: z.array(z.object({
            id: z.string(),
            name: z.string(),
            target_type: z.string(),
            target_value: z.string(),
            schedule: z.string(),
            last_run_at: z.string().nullable(),
            last_run_status: z.string().nullable(),
            created_at: z.string(),
            active: z.boolean(),
          })).describe("List of monitors belonging to this API key."),
          total: z.number().describe("Total number of monitors returned."),
          active_monitor_limit: z.number().describe("Maximum active monitors included in the current plan."),
          remaining_active_slots: z.number().describe("Active monitor slots remaining for this API key."),
          error: z.string().optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ active_only }, extra) => {
        const apiKey = getExtraHeader(extra, "X-API-Key");
        if (!apiKey) {
          return structuredToolResult({ monitors: [], total: 0, active_monitor_limit: PAID_ACTIVE_MONITOR_LIMIT, remaining_active_slots: 0, error: "missing_api_key: list_monitors requires a team API key" });
        }
        const ownerKeyHash = await sha256Hex(apiKey);
        try {
          const planLimitHeader = getExtraHeader(extra, "X-Monitor-Limit");
          const planLimit = planLimitHeader ? parseInt(planLimitHeader, 10) || undefined : undefined;
          const activeMonitorLimit = this.getActiveMonitorLimit(ownerKeyHash, planLimit);
          const rows = active_only
            ? sql<MonitorRecord>`SELECT * FROM monitors WHERE owner_key_hash = ${ownerKeyHash} AND active = 1 ORDER BY created_at DESC`
            : sql<MonitorRecord>`SELECT * FROM monitors WHERE owner_key_hash = ${ownerKeyHash} ORDER BY created_at DESC`;
          const activeCount = sql<{ count: number }>`SELECT COUNT(*) as count FROM monitors WHERE owner_key_hash = ${ownerKeyHash} AND active = 1`;
          const monitors = rows.map(r => ({
            id: r.id,
            name: r.name,
            target_type: r.target_type,
            target_value: r.target_value,
            schedule: r.schedule,
            last_run_at: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
            last_run_status: r.last_run_status,
            created_at: new Date(r.created_at).toISOString(),
            active: r.active === 1,
          }));
          logUsage("list_monitors", true);
          const active = activeCount[0]?.count ?? 0;
          return structuredToolResult({ monitors, total: monitors.length, active_monitor_limit: activeMonitorLimit, remaining_active_slots: Math.max(0, activeMonitorLimit - active) });
        } catch (e) {
          logUsage("list_monitors", false);
          return structuredToolResult({ monitors: [], total: 0, active_monitor_limit: PAID_ACTIVE_MONITOR_LIMIT, remaining_active_slots: 0, error: e instanceof Error ? e.message : String(e) });
        }
      },
    );

    this.server.registerTool(
      "run_monitor_now",
      {
        title: "Run Monitor Now",
        description:
          "Immediately run a monitor's verification check outside its normal schedule. " +
          "Records the result and returns whether the observed value changed since the last run. " +
          "Counts against your monthly quota. Requires a free watch key or paid API key.",
        inputSchema: {
          monitor_id: z.string().trim().min(1).describe("The monitor ID returned by create_monitor."),
        },
        outputSchema: {
          monitor_id: z.string(),
          result_id: z.string(),
          status: z.enum(["changed", "unchanged", "error"]),
          changed: z.boolean(),
          old_value: z.string().nullable(),
          new_value: z.string().nullable(),
          confidence: z.number().nullable(),
          evidence: z.array(z.string()),
          run_at: z.string(),
          error: z.string().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ monitor_id }, extra) => {
        const apiKey = getExtraHeader(extra, "X-API-Key");
        if (!apiKey) {
          return structuredToolResult({ monitor_id, result_id: "", status: "error" as const, changed: false, old_value: null, new_value: null, confidence: null, evidence: [], run_at: new Date().toISOString(), error: "missing_api_key: run_monitor_now requires a team API key" });
        }
        const ownerKeyHash = await sha256Hex(apiKey);
        const monitors = sql<MonitorRecord>`SELECT * FROM monitors WHERE id = ${monitor_id} AND owner_key_hash = ${ownerKeyHash} AND active = 1`;
        if (monitors.length === 0) {
          return structuredToolResult({ monitor_id, result_id: "", status: "error" as const, changed: false, old_value: null, new_value: null, confidence: null, evidence: [], run_at: new Date().toISOString(), error: "Monitor not found or not owned by this API key" });
        }
        const monitor = monitors[0];
        const outcome = await runMonitorVerification(sql, monitor);
        const resultId = generateResultId();
        const runAt = Date.now();
        const finalStatus: "changed" | "unchanged" | "error" = outcome.status === "error" ? "error" : outcome.changed ? "changed" : "unchanged";
        try {
          sql`INSERT INTO monitor_results (id, monitor_id, owner_key_hash, run_at, status, changed, old_value, new_value, confidence, evidence, error_details, raw_metadata) VALUES (${resultId}, ${monitor_id}, ${ownerKeyHash}, ${runAt}, ${finalStatus}, ${outcome.changed ? 1 : 0}, ${outcome.oldValue ?? null}, ${outcome.newValue || null}, ${outcome.confidence}, ${JSON.stringify(outcome.evidence)}, ${outcome.errorDetails ?? null}, ${JSON.stringify(outcome.rawMetadata)})`;
          sql`UPDATE monitors SET last_run_at = ${runAt}, last_run_status = ${finalStatus}, updated_at = ${runAt} WHERE id = ${monitor_id}`;
          if (outcome.changed && getNotificationDestination(monitor.notification_destination)) {
            const notified = await sendMonitorNotification(this.env, monitor, outcome, resultId);
            this.sql`INSERT INTO traffic_log (kind, path, source, status, ts, server_version, deployment) VALUES (${notified ? "monitor_notification_sent" : "monitor_notification_failed"}, ${`/monitor/${monitor.id}`}, ${"monitor"}, ${notified ? "success" : "failed"}, ${Date.now()}, ${SERVER_VERSION}, ${"main"})`;
          }
          logUsage("run_monitor_now", outcome.status !== "error");
          return structuredToolResult({ monitor_id, result_id: resultId, status: finalStatus, changed: outcome.changed, old_value: outcome.oldValue, new_value: outcome.newValue || null, confidence: outcome.confidence, evidence: outcome.evidence, run_at: new Date(runAt).toISOString() });
        } catch (e) {
          logUsage("run_monitor_now", false);
          return structuredToolResult({ monitor_id, result_id: "", status: "error" as const, changed: false, old_value: null, new_value: null, confidence: null, evidence: [], run_at: new Date(runAt).toISOString(), error: e instanceof Error ? e.message : String(e) });
        }
      },
    );

    this.server.registerTool(
      "get_monitor_result",
      {
        title: "Get Monitor Results",
        description:
          "Retrieve the most recent run results for a monitor, including change details, " +
          "confidence score, evidence URLs, and any error information. Requires a free watch key or paid API key.",
        inputSchema: {
          monitor_id: z.string().trim().min(1).describe("The monitor ID to retrieve results for."),
          limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of results to return, newest first."),
        },
        outputSchema: {
          monitor_id: z.string(),
          results: z.array(z.object({
            id: z.string(),
            status: z.string(),
            changed: z.boolean(),
            old_value: z.string().nullable(),
            new_value: z.string().nullable(),
            confidence: z.number().nullable(),
            evidence: z.array(z.string()),
            error_details: z.string().nullable(),
            run_at: z.string(),
          })),
          total: z.number(),
          error: z.string().optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ monitor_id, limit }, extra) => {
        const apiKey = getExtraHeader(extra, "X-API-Key");
        if (!apiKey) {
          return structuredToolResult({ monitor_id, results: [], total: 0, error: "missing_api_key: get_monitor_result requires a team API key" });
        }
        const ownerKeyHash = await sha256Hex(apiKey);
        try {
          const lim = limit ?? 10;
          const rows = sql<MonitorResultRecord>`SELECT * FROM monitor_results WHERE monitor_id = ${monitor_id} AND owner_key_hash = ${ownerKeyHash} ORDER BY run_at DESC LIMIT ${lim}`;
          const results = rows.map(r => ({
            id: r.id,
            status: r.status,
            changed: r.changed === 1,
            old_value: r.old_value,
            new_value: r.new_value,
            confidence: r.confidence,
            evidence: r.evidence ? (JSON.parse(r.evidence) as string[]) : [],
            error_details: r.error_details,
            run_at: new Date(r.run_at).toISOString(),
          }));
          logUsage("get_monitor_result", true);
          return structuredToolResult({ monitor_id, results, total: results.length });
        } catch (e) {
          logUsage("get_monitor_result", false);
          return structuredToolResult({ monitor_id, results: [], total: 0, error: e instanceof Error ? e.message : String(e) });
        }
      },
    );

    this.server.registerTool(
      "delete_monitor",
      {
        title: "Delete Monitor",
        description:
          "Permanently delete a monitor and all its stored results. " +
          "This action cannot be undone. Requires a free watch key or paid API key.",
        inputSchema: {
          monitor_id: z.string().trim().min(1).describe("The monitor ID to delete."),
        },
        outputSchema: {
          monitor_id: z.string(),
          deleted: z.boolean(),
          results_deleted: z.number().describe("Number of result records also deleted."),
          error: z.string().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ monitor_id }, extra) => {
        const apiKey = getExtraHeader(extra, "X-API-Key");
        if (!apiKey) {
          return structuredToolResult({ monitor_id, deleted: false, results_deleted: 0, error: "missing_api_key: delete_monitor requires a team API key" });
        }
        const ownerKeyHash = await sha256Hex(apiKey);
        const existing = sql<{ id: string }>`SELECT id FROM monitors WHERE id = ${monitor_id} AND owner_key_hash = ${ownerKeyHash}`;
        if (existing.length === 0) {
          return structuredToolResult({ monitor_id, deleted: false, results_deleted: 0, error: "Monitor not found or not owned by this API key" });
        }
        const countRows = sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM monitor_results WHERE monitor_id = ${monitor_id}`;
        const count = countRows[0]?.cnt ?? 0;
        sql`DELETE FROM monitor_results WHERE monitor_id = ${monitor_id}`;
        sql`DELETE FROM monitors WHERE id = ${monitor_id} AND owner_key_hash = ${ownerKeyHash}`;
        logUsage("delete_monitor", true);
        return structuredToolResult({ monitor_id, deleted: true, results_deleted: count });
      },
    );

    this.server.registerTool(
      "generate_change_report",
      {
        title: "Generate Change Report",
        description:
          "Generate a summary report of monitor activity for a time window. " +
          "Shows monitors run, changes detected, failures, risk levels, and recommended follow-up actions. " +
          "Requires a free watch key or paid API key.",
        inputSchema: {
          period: z.enum(["daily", "weekly"]).default("daily").describe(
            "Report period. daily covers the past 24 hours, weekly covers the past 7 days.",
          ),
          include_unchanged: z.boolean().default(false).describe(
            "When true also lists monitors with no detected changes.",
          ),
        },
        outputSchema: {
          period: z.string(),
          from: z.string(),
          to: z.string(),
          summary: z.object({
            monitors_run: z.number(),
            changes_detected: z.number(),
            failed_checks: z.number(),
            unchanged: z.number(),
          }),
          changes: z.array(z.object({
            monitor_id: z.string(),
            monitor_name: z.string(),
            target_type: z.string(),
            target_value: z.string(),
            run_at: z.string(),
            old_value: z.string().nullable(),
            new_value: z.string().nullable(),
            confidence: z.number().nullable(),
            risk_level: z.string(),
          })),
          failures: z.array(z.object({
            monitor_id: z.string(),
            monitor_name: z.string(),
            run_at: z.string(),
            error_details: z.string().nullable(),
          })),
          recommended_actions: z.array(z.string()),
          error: z.string().optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ period, include_unchanged }, extra) => {
        const apiKey = getExtraHeader(extra, "X-API-Key");
        if (!apiKey) {
          return structuredToolResult({ period: period ?? "daily", from: "", to: "", summary: { monitors_run: 0, changes_detected: 0, failed_checks: 0, unchanged: 0 }, changes: [], failures: [], recommended_actions: [], error: "missing_api_key: generate_change_report requires a team API key" });
        }
        const ownerKeyHash = await sha256Hex(apiKey);
        const now = Date.now();
        const windowMs = (period ?? "daily") === "weekly" ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
        const fromTs = now - windowMs;
        try {
          type ResultRow = MonitorResultRecord & { monitor_name: string; target_type_m: string; target_value_m: string };
          const rows = sql<ResultRow>`
            SELECT mr.id, mr.monitor_id, mr.owner_key_hash, mr.run_at, mr.status, mr.changed,
                   mr.old_value, mr.new_value, mr.confidence, mr.evidence, mr.error_details, mr.raw_metadata,
                   m.name as monitor_name, m.target_type as target_type_m, m.target_value as target_value_m
            FROM monitor_results mr
            JOIN monitors m ON mr.monitor_id = m.id
            WHERE mr.owner_key_hash = ${ownerKeyHash} AND mr.run_at >= ${fromTs}
            ORDER BY mr.run_at DESC
          `;

          const changes = rows
            .filter(r => r.changed === 1)
            .map(r => ({
              monitor_id: r.monitor_id,
              monitor_name: r.monitor_name,
              target_type: r.target_type_m,
              target_value: r.target_value_m,
              run_at: new Date(r.run_at).toISOString(),
              old_value: r.old_value,
              new_value: r.new_value,
              confidence: r.confidence,
              risk_level: r.target_type_m === "pricing_page" || r.target_type_m === "vendor_claim"
                ? "high"
                : r.target_type_m === "package" ? "medium" : "low",
            }));

          const failures = rows
            .filter(r => r.status === "error")
            .map(r => ({
              monitor_id: r.monitor_id,
              monitor_name: r.monitor_name,
              run_at: new Date(r.run_at).toISOString(),
              error_details: r.error_details,
            }));

          const unchangedCount = rows.filter(r => r.status === "unchanged").length;
          const uniqueMonitors = new Set(rows.map(r => r.monitor_id)).size;

          const actions: string[] = [];
          if (changes.some(c => c.risk_level === "high")) {
            actions.push("Review high-risk pricing and claim changes before communicating to stakeholders.");
          }
          if (changes.some(c => c.target_type === "package")) {
            actions.push("A monitored package version changed — review changelog and update dependencies.");
          }
          if (changes.some(c => c.target_type === "endpoint" || c.target_type === "url")) {
            actions.push("An endpoint status changed — verify the service is operating correctly.");
          }
          if (failures.length > 0) {
            actions.push(`${failures.length} monitor check(s) failed — verify the target URLs are still reachable.`);
          }
          if (actions.length === 0) {
            actions.push("No changes or failures detected. All monitored targets appear stable.");
          }

          void include_unchanged;
          logUsage("generate_change_report", true);
          return structuredToolResult({
            period: period ?? "daily",
            from: new Date(fromTs).toISOString(),
            to: new Date(now).toISOString(),
            summary: { monitors_run: uniqueMonitors, changes_detected: changes.length, failed_checks: failures.length, unchanged: unchangedCount },
            changes,
            failures,
            recommended_actions: actions,
          });
        } catch (e) {
          logUsage("generate_change_report", false);
          return structuredToolResult({ period: period ?? "daily", from: new Date(fromTs).toISOString(), to: new Date(now).toISOString(), summary: { monitors_run: 0, changes_detected: 0, failed_checks: 0, unchanged: 0 }, changes: [], failures: [], recommended_actions: [], error: e instanceof Error ? e.message : String(e) });
        }
      },
    );

    this.server.registerTool(
      "create_share_link",
      {
        title: "Create Shareable Evidence Link",
        description:
          "Create a read-only public link to the latest result for one of your monitors. " +
          "The link contains monitor metadata and evidence, never the API key, and expires automatically. " +
          "Use it to share a verified change with a teammate, customer, or agent. Requires a free watch key or paid API key.",
        inputSchema: {
          monitor_id: z.string().trim().min(1).describe("The monitor ID whose latest evidence should be shared."),
          title: z.string().trim().max(160).optional().describe("Optional human-readable title for the shared report."),
          expires_in_days: z.number().int().min(1).max(SHARED_REPORT_MAX_TTL_DAYS).default(SHARED_REPORT_MAX_TTL_DAYS).describe("Link lifetime in days, up to 30 days."),
        },
        outputSchema: {
          report_id: z.string(),
          monitor_id: z.string(),
          share_url: z.string(),
          expires_at: z.string(),
          error: z.string().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ monitor_id, title, expires_in_days }, extra) => {
        const apiKey = getExtraHeader(extra, "X-API-Key");
        if (!apiKey) {
          return structuredToolResult({ report_id: "", monitor_id, share_url: "", expires_at: "", error: "missing_api_key: create_share_link requires a team API key" });
        }
        const ownerKeyHash = await sha256Hex(apiKey);
        try {
          const monitors = sql<MonitorRecord>`SELECT * FROM monitors WHERE id = ${monitor_id} AND owner_key_hash = ${ownerKeyHash} AND active = 1 LIMIT 1`;
          const monitor = monitors[0];
          if (!monitor) {
            return structuredToolResult({ report_id: "", monitor_id, share_url: "", expires_at: "", error: "monitor_not_found: the monitor does not exist or is not owned by this API key" });
          }
          const results = sql<MonitorResultRecord>`SELECT * FROM monitor_results WHERE monitor_id = ${monitor_id} AND owner_key_hash = ${ownerKeyHash} ORDER BY run_at DESC LIMIT 1`;
          const latest = results[0];
          if (!latest) {
            return structuredToolResult({ report_id: "", monitor_id, share_url: "", expires_at: "", error: "no_evidence: run_monitor_now before creating a share link" });
          }

          const now = Date.now();
          const ttlDays = expires_in_days ?? SHARED_REPORT_MAX_TTL_DAYS;
          const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000;
          const reportId = generateShareId();
          const reportTitle = title || `${monitor.name} evidence report`;
          const report = {
            title: reportTitle,
            monitor: {
              id: monitor.id,
              name: monitor.name,
              target_type: monitor.target_type,
              target_value: monitor.target_value,
              schedule: monitor.schedule,
            },
            latest_result: {
              id: latest.id,
              run_at: new Date(latest.run_at).toISOString(),
              status: latest.status,
              changed: latest.changed === 1,
              old_value: latest.old_value?.slice(0, 8000) ?? null,
              new_value: latest.new_value?.slice(0, 8000) ?? null,
              confidence: latest.confidence,
              evidence: latest.evidence ? latest.evidence.slice(0, 12000) : null,
              error_details: latest.error_details?.slice(0, 2000) ?? null,
            },
            shared_at: new Date(now).toISOString(),
            expires_at: new Date(expiresAt).toISOString(),
          };
          sql`INSERT INTO shared_reports (id, monitor_id, owner_key_hash, title, report_json, created_at, expires_at) VALUES (${reportId}, ${monitor.id}, ${ownerKeyHash}, ${reportTitle}, ${JSON.stringify(report)}, ${now}, ${expiresAt})`;
          logUsage("create_share_link", true);
          return structuredToolResult({ report_id: reportId, monitor_id, share_url: `${PUBLIC_APP_ORIGIN}/share/${reportId}`, expires_at: new Date(expiresAt).toISOString() });
        } catch (e) {
          logUsage("create_share_link", false);
          return structuredToolResult({ report_id: "", monitor_id, share_url: "", expires_at: "", error: e instanceof Error ? e.message : String(e) });
        }
      },
    );

  }

  private ensureMonitorTables(): void {
    this.ensureAnalyticsSchema();
    // Browser account actions bypass MCP init(), which normally creates this table.
    this.sql`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, data TEXT, ts INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS monitors (id TEXT PRIMARY KEY, owner_key_hash TEXT NOT NULL, name TEXT NOT NULL, target_type TEXT NOT NULL, target_value TEXT NOT NULL, instructions TEXT, schedule TEXT NOT NULL DEFAULT 'manual', notification_destination TEXT, last_run_at INTEGER, last_run_status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`;
    this.sql`CREATE TABLE IF NOT EXISTS monitor_results (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, owner_key_hash TEXT NOT NULL, run_at INTEGER NOT NULL, status TEXT NOT NULL, changed INTEGER NOT NULL DEFAULT 0, old_value TEXT, new_value TEXT, confidence REAL, evidence TEXT, error_details TEXT, raw_metadata TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS shared_reports (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, owner_key_hash TEXT NOT NULL, title TEXT NOT NULL, report_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`;
  }

  private async syncAccountMonitorSchedule(): Promise<void> {
    const scheduledMonitors = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM monitors WHERE active = 1 AND schedule != 'manual'`;
    const schedules = this.getSchedules().filter(schedule => schedule.callback === "runAccountMonitors");
    if ((scheduledMonitors[0]?.count ?? 0) > 0 && schedules.length === 0) {
      await this.scheduleEvery(60 * 60, "runAccountMonitors", null);
    } else if ((scheduledMonitors[0]?.count ?? 0) === 0) {
      await Promise.all(schedules.map(schedule => this.cancelSchedule(schedule.id)));
    }
  }

  async runAccountMonitors(): Promise<void> {
    await this.handleRunDueMonitors();
  }

  private async handleMonitorAction(request: Request): Promise<Response> {
    this.ensureMonitorTables();
    const payload = await request.json().catch(() => null) as {
      action?: string;
      arguments?: Record<string, unknown>;
      ownerKeyHash?: string;
      activeMonitorLimit?: number;
    } | null;
    const action = typeof payload?.action === "string" ? payload.action : "";
    const args = payload?.arguments && typeof payload.arguments === "object" ? payload.arguments : {};
    const ownerKeyHash = typeof payload?.ownerKeyHash === "string" && /^[a-f0-9]{64}$/i.test(payload.ownerKeyHash)
      ? payload.ownerKeyHash.toLowerCase()
      : "";
    const activeMonitorLimit = typeof payload?.activeMonitorLimit === "number"
      ? Math.max(1, Math.min(10_000, Math.floor(payload.activeMonitorLimit)))
      : FREE_MONITOR_LIMIT;
    if (!ownerKeyHash) return jsonError(400, "invalid_monitor_owner", "A valid monitor owner is required.");

    if (action === "create_monitor") {
      const name = typeof args.name === "string" ? args.name.trim().slice(0, 200) : "";
      const targetType = typeof args.target_type === "string" ? args.target_type.trim() : "";
      const allowedTypes = ["url", "pricing_page", "package", "endpoint", "vendor_claim", "custom_prompt"];
      const rawTarget = typeof args.target_value === "string" ? args.target_value.trim() : "";
      const rawInstructions = typeof args.instructions === "string" ? args.instructions.trim().slice(0, 1000) : null;
      const schedule = typeof args.schedule === "string" && ["manual", "hourly", "daily", "weekly"].includes(args.schedule)
        ? args.schedule
        : "daily";
      if (!name || !allowedTypes.includes(targetType) || !rawTarget) {
        return jsonError(400, "invalid_monitor", "Provide a name, supported target type, and target value.");
      }
      const targetValue = ["url", "endpoint", "pricing_page", "custom_prompt"].includes(targetType)
        ? normalizeHttpUrlInput(rawTarget)
        : rawTarget;
      const instructions = targetType === "vendor_claim" && rawInstructions
        ? normalizeHttpUrlInput(rawInstructions)
        : rawInstructions;
      if (!targetValue || (targetType === "vendor_claim" && !instructions)) {
        return jsonError(400, "invalid_monitor_url", "Use a valid public http(s) URL for this monitor.");
      }
      const requestedDestination = typeof args.notification_destination === "string" ? args.notification_destination : null;
      const notificationTarget = classifyNotificationDestination(requestedDestination);
      if (requestedDestination && !notificationTarget) {
        return jsonError(400, "invalid_notification_destination", "Use a public HTTPS webhook URL, a Slack Incoming Webhook (https://hooks.slack.com/...), or mailto:you@example.com.");
      }
      if (notificationTarget?.channel === "email" && !this.env.RESEND_API_KEY) {
        return jsonError(400, "email_alerts_unavailable", "Email change alerts are not configured on this deployment. Use an HTTPS webhook or Slack Incoming Webhook URL instead.");
      }
      const notificationDestination = notificationTarget?.destination ?? null;
      const active = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM monitors WHERE owner_key_hash = ${ownerKeyHash} AND active = 1`[0]?.count ?? 0;
      if (active >= activeMonitorLimit) {
        return jsonResponse({
          error: "monitor_limit_reached",
          message: `This plan includes ${activeMonitorLimit} active monitors. Delete an unused monitor or upgrade.`,
          active_monitor_limit: activeMonitorLimit,
          upgrade_url: `${PUBLIC_APP_ORIGIN}/pricing`,
        }, { status: 409 });
      }
      const now = Date.now();
      const id = generateMonitorId();
      this.sql`INSERT INTO monitors (id, owner_key_hash, name, target_type, target_value, instructions, schedule, notification_destination, last_run_at, last_run_status, created_at, updated_at, active) VALUES (${id}, ${ownerKeyHash}, ${name}, ${targetType}, ${targetValue}, ${instructions}, ${schedule}, ${notificationDestination}, ${null}, ${null}, ${now}, ${now}, ${1})`;
      await this.syncAccountMonitorSchedule();
      return jsonResponse({ id, name, target_type: targetType, target_value: targetValue, schedule, created_at: new Date(now).toISOString(), active_monitor_limit: activeMonitorLimit });
    }

    if (action === "list_monitors") {
      const activeOnly = args.active_only !== false;
      const rows = activeOnly
        ? this.sql<MonitorRecord>`SELECT * FROM monitors WHERE owner_key_hash = ${ownerKeyHash} AND active = 1 ORDER BY created_at DESC`
        : this.sql<MonitorRecord>`SELECT * FROM monitors WHERE owner_key_hash = ${ownerKeyHash} ORDER BY created_at DESC`;
      const active = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM monitors WHERE owner_key_hash = ${ownerKeyHash} AND active = 1`[0]?.count ?? 0;
      return jsonResponse({
        monitors: rows.map(row => ({
          id: row.id,
          name: row.name,
          target_type: row.target_type,
          target_value: row.target_value,
          schedule: row.schedule,
          last_run_at: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
          last_run_status: row.last_run_status,
          created_at: new Date(row.created_at).toISOString(),
          active: row.active === 1,
        })),
        total: rows.length,
        active_monitor_limit: activeMonitorLimit,
        remaining_active_slots: Math.max(0, activeMonitorLimit - active),
      });
    }

    if (action === "run_monitor_now") {
      const monitorId = typeof args.monitor_id === "string" ? args.monitor_id.trim() : "";
      const monitor = this.sql<MonitorRecord>`SELECT * FROM monitors WHERE id = ${monitorId} AND owner_key_hash = ${ownerKeyHash} AND active = 1 LIMIT 1`[0];
      if (!monitor) return jsonError(404, "monitor_not_found", "Monitor not found or not owned by this key.");
      const outcome = await runMonitorVerification(this.sql.bind(this) as SqlTagFn, monitor);
      const resultId = generateResultId();
      const runAt = Date.now();
      const status: "changed" | "unchanged" | "error" = outcome.status === "error" ? "error" : outcome.changed ? "changed" : "unchanged";
      this.sql`INSERT INTO monitor_results (id, monitor_id, owner_key_hash, run_at, status, changed, old_value, new_value, confidence, evidence, error_details, raw_metadata) VALUES (${resultId}, ${monitorId}, ${ownerKeyHash}, ${runAt}, ${status}, ${outcome.changed ? 1 : 0}, ${outcome.oldValue ?? null}, ${outcome.newValue || null}, ${outcome.confidence}, ${JSON.stringify(outcome.evidence)}, ${outcome.errorDetails ?? null}, ${JSON.stringify(outcome.rawMetadata)})`;
      this.sql`UPDATE monitors SET last_run_at = ${runAt}, last_run_status = ${status}, updated_at = ${runAt} WHERE id = ${monitorId}`;
      if (outcome.changed && getNotificationDestination(monitor.notification_destination)) {
        const notified = await sendMonitorNotification(this.env, monitor, outcome, resultId);
        this.sql`INSERT INTO traffic_log (kind, path, source, status, ts, server_version, deployment) VALUES (${notified ? "monitor_notification_sent" : "monitor_notification_failed"}, ${`/monitor/${monitor.id}`}, ${"monitor"}, ${notified ? "success" : "failed"}, ${Date.now()}, ${SERVER_VERSION}, ${"main"})`;
      }
      return jsonResponse({ monitor_id: monitorId, result_id: resultId, status, changed: outcome.changed, old_value: outcome.oldValue, new_value: outcome.newValue || null, confidence: outcome.confidence, evidence: outcome.evidence, run_at: new Date(runAt).toISOString(), ...(outcome.errorDetails ? { error: outcome.errorDetails } : {}) });
    }

    if (action === "get_monitor_result") {
      const monitorId = typeof args.monitor_id === "string" ? args.monitor_id.trim() : "";
      const owned = this.sql<{ id: string }>`SELECT id FROM monitors WHERE id = ${monitorId} AND owner_key_hash = ${ownerKeyHash} LIMIT 1`[0];
      if (!owned) return jsonError(404, "monitor_not_found", "Monitor not found or not owned by this key.");
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 10;
      const rows = this.sql<MonitorResultRecord>`SELECT * FROM monitor_results WHERE monitor_id = ${monitorId} AND owner_key_hash = ${ownerKeyHash} ORDER BY run_at DESC LIMIT ${limit}`;
      return jsonResponse({
        monitor_id: monitorId,
        results: rows.map(row => ({
          id: row.id,
          status: row.status,
          changed: row.changed === 1,
          old_value: row.old_value,
          new_value: row.new_value,
          confidence: row.confidence,
          evidence: row.evidence ? JSON.parse(row.evidence) as string[] : [],
          error_details: row.error_details,
          run_at: new Date(row.run_at).toISOString(),
        })),
        total: rows.length,
      });
    }

    if (action === "delete_monitor") {
      const monitorId = typeof args.monitor_id === "string" ? args.monitor_id.trim() : "";
      const owned = this.sql<{ id: string }>`SELECT id FROM monitors WHERE id = ${monitorId} AND owner_key_hash = ${ownerKeyHash} LIMIT 1`[0];
      if (!owned) return jsonError(404, "monitor_not_found", "Monitor not found or not owned by this key.");
      const resultCount = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM monitor_results WHERE monitor_id = ${monitorId} AND owner_key_hash = ${ownerKeyHash}`[0]?.count ?? 0;
      this.sql`DELETE FROM monitor_results WHERE monitor_id = ${monitorId} AND owner_key_hash = ${ownerKeyHash}`;
      this.sql`DELETE FROM monitors WHERE id = ${monitorId} AND owner_key_hash = ${ownerKeyHash}`;
      await this.syncAccountMonitorSchedule();
      return jsonResponse({ monitor_id: monitorId, deleted: true, results_deleted: resultCount });
    }

    if (action === "generate_change_report") {
      const period = args.period === "weekly" ? "weekly" : "daily";
      const now = Date.now();
      const fromTs = now - (period === "weekly" ? 7 : 1) * 24 * 60 * 60 * 1000;
      type ResultRow = MonitorResultRecord & { monitor_name: string; target_type_m: string; target_value_m: string };
      const rows = this.sql<ResultRow>`
        SELECT mr.id, mr.monitor_id, mr.owner_key_hash, mr.run_at, mr.status, mr.changed,
               mr.old_value, mr.new_value, mr.confidence, mr.evidence, mr.error_details, mr.raw_metadata,
               m.name as monitor_name, m.target_type as target_type_m, m.target_value as target_value_m
        FROM monitor_results mr
        JOIN monitors m ON mr.monitor_id = m.id
        WHERE mr.owner_key_hash = ${ownerKeyHash} AND mr.run_at >= ${fromTs}
        ORDER BY mr.run_at DESC
      `;
      const changes = rows.filter(row => row.changed === 1).map(row => ({
        monitor_id: row.monitor_id,
        monitor_name: row.monitor_name,
        target_type: row.target_type_m,
        target_value: row.target_value_m,
        run_at: new Date(row.run_at).toISOString(),
        old_value: row.old_value,
        new_value: row.new_value,
        confidence: row.confidence,
        risk_level: row.target_type_m === "pricing_page" || row.target_type_m === "vendor_claim"
          ? "high"
          : row.target_type_m === "package" ? "medium" : "low",
      }));
      const failures = rows.filter(row => row.status === "error").map(row => ({
        monitor_id: row.monitor_id,
        monitor_name: row.monitor_name,
        run_at: new Date(row.run_at).toISOString(),
        error_details: row.error_details,
      }));
      const recommendedActions: string[] = [];
      if (changes.some(change => change.risk_level === "high")) recommendedActions.push("Review high-risk pricing and claim changes before communicating to stakeholders.");
      if (changes.some(change => change.target_type === "package")) recommendedActions.push("Review the changed package changelog and update dependencies if appropriate.");
      if (failures.length > 0) recommendedActions.push(`${failures.length} monitor check(s) failed — verify that the targets are still reachable.`);
      if (recommendedActions.length === 0) recommendedActions.push("No changes or failures detected. Monitored targets appear stable.");
      return jsonResponse({
        period,
        from: new Date(fromTs).toISOString(),
        to: new Date(now).toISOString(),
        summary: {
          monitors_run: new Set(rows.map(row => row.monitor_id)).size,
          changes_detected: changes.length,
          failed_checks: failures.length,
          unchanged: rows.filter(row => row.status === "unchanged").length,
        },
        changes,
        failures,
        recommended_actions: recommendedActions,
      });
    }

    if (action === "create_share_link") {
      const monitorId = typeof args.monitor_id === "string" ? args.monitor_id.trim() : "";
      const monitor = this.sql<MonitorRecord>`SELECT * FROM monitors WHERE id = ${monitorId} AND owner_key_hash = ${ownerKeyHash} AND active = 1 LIMIT 1`[0];
      if (!monitor) return jsonError(404, "monitor_not_found", "Monitor not found or not owned by this key.");
      const latest = this.sql<MonitorResultRecord>`SELECT * FROM monitor_results WHERE monitor_id = ${monitorId} AND owner_key_hash = ${ownerKeyHash} ORDER BY run_at DESC LIMIT 1`[0];
      if (!latest) return jsonError(409, "no_evidence", "Run this monitor before creating a share link.");
      const now = Date.now();
      const ttlDays = typeof args.expires_in_days === "number" ? Math.max(1, Math.min(SHARED_REPORT_MAX_TTL_DAYS, Math.floor(args.expires_in_days))) : SHARED_REPORT_MAX_TTL_DAYS;
      const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000;
      const reportId = generateShareId();
      const title = typeof args.title === "string" && args.title.trim() ? args.title.trim().slice(0, 160) : `${monitor.name} evidence report`;
      const report = {
        title,
        monitor: { id: monitor.id, name: monitor.name, target_type: monitor.target_type, target_value: monitor.target_value, schedule: monitor.schedule },
        latest_result: {
          id: latest.id,
          run_at: new Date(latest.run_at).toISOString(),
          status: latest.status,
          changed: latest.changed === 1,
          old_value: latest.old_value?.slice(0, 8000) ?? null,
          new_value: latest.new_value?.slice(0, 8000) ?? null,
          confidence: latest.confidence,
          evidence: latest.evidence ? latest.evidence.slice(0, 12000) : null,
          error_details: latest.error_details?.slice(0, 2000) ?? null,
        },
        shared_at: new Date(now).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
      };
      this.sql`INSERT INTO shared_reports (id, monitor_id, owner_key_hash, title, report_json, created_at, expires_at) VALUES (${reportId}, ${monitorId}, ${ownerKeyHash}, ${title}, ${JSON.stringify(report)}, ${now}, ${expiresAt})`;
      return jsonResponse({ report_id: reportId, monitor_id: monitorId, share_url: `${PUBLIC_APP_ORIGIN}/share/${reportId}`, expires_at: new Date(expiresAt).toISOString() });
    }

    return jsonError(400, "unsupported_monitor_action", "This monitor action is not supported by the self-serve API.");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "internal" && url.pathname === "/monitor-action" && request.method === "POST") {
      return this.handleMonitorAction(request);
    }
    if (url.hostname === "internal" && url.pathname === "/run-due-monitors" && request.method === "POST") {
      return this.handleRunDueMonitors();
    }
    if (url.hostname === "internal" && url.pathname === "/preview-monitor" && request.method === "POST") {
      return this.handlePreviewMonitor(request);
    }
    if (url.hostname === "internal" && url.pathname === "/track-traffic" && request.method === "POST") {
      return this.handleTrackTraffic(request);
    }
    if (url.hostname === "internal" && url.pathname === "/track-usage" && request.method === "POST") {
      return this.handleTrackUsage(request);
    }
    if (url.hostname === "internal" && url.pathname.startsWith("/share/") && request.method === "GET") {
      return this.handleSharedReport(url.pathname.slice("/share/".length), url.searchParams.get("format") === "json");
    }
    if (url.hostname === "internal" && url.pathname === "/referral/complete" && request.method === "POST") {
      const payload = await request.json().catch(() => null) as { code?: string; referredKeyHash?: string } | null;
      const code = normalizeReferralCode(payload?.code);
      const referredKeyHash = typeof payload?.referredKeyHash === "string" && /^[a-f0-9]{64}$/i.test(payload.referredKeyHash)
        ? payload.referredKeyHash.toLowerCase()
        : null;
      return code ? this.completeReferral(code, referredKeyHash) : jsonError(400, "invalid_referral_code", "A valid referral code is required.");
    }
    if (url.hostname === "internal" && url.pathname === "/stats") {
      return this.handleStats();
    }
    if (url.hostname === "internal" && url.pathname === "/prune-analytics" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { retentionDays?: number; reset?: boolean } | null;
      const diag = () => {
        const out: Record<string, number | string> = {};
        try { out.databaseSizeBytes = (this.ctx.storage.sql as SqlStorage).databaseSize; } catch (e) { out.databaseSizeErr = e instanceof Error ? e.message : String(e); }
        try { out.pageCount = this.sql<{ page_count: number }>`PRAGMA page_count`[0]?.page_count ?? -1; } catch { /* ignore */ }
        try { out.freelistCount = this.sql<{ freelist_count: number }>`PRAGMA freelist_count`[0]?.freelist_count ?? -1; } catch { /* ignore */ }
        try { out.pageSize = this.sql<{ page_size: number }>`PRAGMA page_size`[0]?.page_size ?? -1; } catch { /* ignore */ }
        try { out.autoVacuum = this.sql<{ auto_vacuum: number }>`PRAGMA auto_vacuum`[0]?.auto_vacuum ?? -1; } catch { /* ignore */ }
        return out;
      };
      const before = diag();
      const result = this.pruneAnalytics(typeof body?.retentionDays === "number" ? body.retentionDays : 45);
      // Best-effort page reclamation (only reclaims when auto_vacuum=INCREMENTAL).
      let reclaim = "none";
      try { this.sql`PRAGMA incremental_vacuum`; reclaim = "incremental_vacuum_attempted"; } catch { /* not incremental */ }
      // Hard reset: truncates the whole analytics DO to physically reclaim space
      // when DELETE alone cannot (SQLite keeps freed pages). Analytics-only DO,
      // so this loses only logs/caches (and negligible referral rows), never monitors.
      let didReset = false;
      if (body?.reset === true) {
        try {
          await this.ctx.storage.deleteAll();
          this.ensureAnalyticsSchema();
          this.sql`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, data TEXT, ts INTEGER)`;
          this.sql`CREATE TABLE IF NOT EXISTS usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT, ts INTEGER, success INTEGER)`;
          this.sql`CREATE TABLE IF NOT EXISTS paid_result_cache (key TEXT PRIMARY KEY, response TEXT, ts INTEGER)`;
          didReset = true;
        } catch (e) {
          return jsonResponse({ ok: false, stage: "reset", error: e instanceof Error ? e.message : String(e), before });
        }
      }
      return jsonResponse({ ok: true, ...result, reclaim, didReset, before, after: diag() });
    }
    return super.fetch(request);
  }

  async handlePreviewMonitor(request: Request): Promise<Response> {
    this.sql`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, data TEXT, ts INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS monitor_results (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, owner_key_hash TEXT NOT NULL, run_at INTEGER NOT NULL, status TEXT NOT NULL, changed INTEGER NOT NULL DEFAULT 0, old_value TEXT, new_value TEXT, confidence REAL, evidence TEXT, error_details TEXT, raw_metadata TEXT)`;
    const payload = await request.json().catch(() => null) as {
      target_type?: string;
      target_value?: string;
      instructions?: string;
    } | null;
    const allowedTypes = ["url", "endpoint", "pricing_page", "package", "vendor_claim", "custom_prompt"];
    const targetType = typeof payload?.target_type === "string" ? payload.target_type.trim() : "";
    const rawTarget = typeof payload?.target_value === "string" ? payload.target_value.trim() : "";
    const rawInstructions = typeof payload?.instructions === "string" ? payload.instructions.trim().slice(0, 1000) : null;
    if (!allowedTypes.includes(targetType) || !rawTarget) {
      return jsonError(400, "invalid_preview", "Choose a supported source type and provide a target.");
    }
    const targetValue = ["url", "endpoint", "pricing_page", "custom_prompt"].includes(targetType)
      ? normalizeHttpUrlInput(rawTarget)
      : rawTarget;
    const instructions = targetType === "vendor_claim" && rawInstructions
      ? normalizeHttpUrlInput(rawInstructions)
      : rawInstructions;
    if (!targetValue || (targetType === "vendor_claim" && !instructions)) {
      return jsonError(400, "invalid_preview_url", "Use a valid public http(s) URL for this preview.");
    }

    const now = Date.now();
    const preview: MonitorRecord = {
      id: `preview_${crypto.randomUUID()}`,
      owner_key_hash: "web_preview",
      name: "Monitor Lab preview",
      target_type: targetType,
      target_value: targetValue,
      instructions,
      schedule: getRecommendedMonitorSchedule(targetType),
      notification_destination: null,
      last_run_at: null,
      last_run_status: null,
      created_at: now,
      updated_at: now,
      active: 0,
    };
    const sql = this.sql.bind(this) as SqlTagFn;
    const outcome = await runMonitorVerification(sql, preview);
    return jsonResponse(buildMonitorPreviewResult(targetType, targetValue, outcome));
  }

  async handleSharedReport(reportId: string, asJson = false): Promise<Response> {
    try {
      this.ensureAnalyticsSchema();
      const sql = this.sql.bind(this) as SqlTagFn;
      const rows = sql<SharedReportRecord>`SELECT * FROM shared_reports WHERE id = ${reportId} LIMIT 1`;
      const report = rows[0];
      if (!report) return jsonError(404, "share_not_found", "This shared evidence report does not exist.");
      if (report.expires_at <= Date.now()) return jsonError(410, "share_expired", "This shared evidence report has expired.");
      this.sql`INSERT INTO traffic_log (kind, path, source, status, ts, server_version, deployment) VALUES (${"shared_report_viewed"}, ${`/share/${reportId}`}, ${"share"}, ${"success"}, ${Date.now()}, ${SERVER_VERSION}, ${"main"})`;

      let payload: Record<string, any>;
      try {
        payload = JSON.parse(report.report_json) as Record<string, any>;
      } catch {
        return jsonError(500, "share_invalid", "This shared evidence report could not be read.");
      }
      if (asJson) {
        return jsonResponse({ report_id: report.id, ...payload }, { headers: { "Cache-Control": "public, max-age=300" } });
      }

      const monitor = payload.monitor ?? {};
      const result = payload.latest_result ?? {};
      const evidence = typeof result.evidence === "string" ? result.evidence : JSON.stringify(result.evidence ?? null, null, 2);
      const statusColor = result.status === "changed" ? "#b54708" : result.status === "error" ? "#b42318" : "#027a48";
      return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta property="og:title" content="${escapeHtml(String(payload.title ?? report.title))}"><meta property="og:description" content="Shared evidence from Ground Truth monitor ${escapeHtml(String(monitor.name ?? ""))}"><meta property="og:type" content="article"><title>${escapeHtml(String(payload.title ?? report.title))}</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:820px;margin:0 auto;padding:32px;color:#172033;background:#f7f9fc}main{background:#fff;border:1px solid #dbe3ef;border-radius:16px;padding:28px;box-shadow:0 8px 30px #17203312}h1{margin:0 0 8px;font-size:28px}h2{margin-top:28px;font-size:17px}p{line-height:1.55}.meta{color:#536173;font-size:14px}.status{display:inline-block;color:#fff;background:${statusColor};border-radius:999px;padding:6px 12px;font-weight:700}.evidence{white-space:pre-wrap;background:#f4f7fb;border-radius:10px;padding:16px;overflow:auto;font-size:13px}a{color:#175cd3}</style></head>
<body><main><p class="meta">Shared Ground Truth evidence report</p><h1>${escapeHtml(String(payload.title ?? report.title))}</h1>
<p><span class="status">${escapeHtml(String(result.status ?? "unknown").toUpperCase())}</span> ${result.changed ? "A change was detected." : "No change was detected."}</p>
<h2>Monitored source</h2><p><strong>${escapeHtml(String(monitor.name ?? "Unnamed monitor"))}</strong><br>${escapeHtml(String(monitor.target_type ?? "source"))}: ${escapeHtml(String(monitor.target_value ?? ""))}</p>
<h2>Latest result</h2><p>Observed at ${escapeHtml(String(result.run_at ?? "unknown"))}. Confidence: ${escapeHtml(String(result.confidence ?? "not reported"))}</p>
${result.old_value || result.new_value ? `<h2>Observed values</h2><p><strong>Previous:</strong> ${escapeHtml(String(result.old_value ?? "none"))}<br><strong>Current:</strong> ${escapeHtml(String(result.new_value ?? "none"))}</p>` : ""}
${evidence && evidence !== "null" ? `<h2>Evidence</h2><div class="evidence">${escapeHtml(evidence)}</div>` : ""}
${result.error_details ? `<p><strong>Check details:</strong> ${escapeHtml(String(result.error_details))}</p>` : ""}
<p class="meta">Created ${escapeHtml(String(payload.shared_at ?? ""))}. Expires ${escapeHtml(String(payload.expires_at ?? new Date(report.expires_at).toISOString()))}.</p>
<p><button id="share" type="button">Share this report</button> <button id="copy" type="button">Copy link</button></p>
<p><a href="${PUBLIC_APP_ORIGIN}/?ref=${encodeURIComponent(report.id)}">Run your own free preflight</a> · <a href="${PUBLIC_APP_ORIGIN}/pricing?ref=${encodeURIComponent(report.id)}">Get monitoring access</a></p>
<p class="meta">To preserve referral attribution in an MCP client, add this header to the first request:</p><div class="evidence">X-Ground-Truth-Referral: ${escapeHtml(report.id)}</div>
<script>const link=location.href;document.getElementById('copy').onclick=()=>navigator.clipboard?.writeText(link);document.getElementById('share').onclick=()=>navigator.share?navigator.share({title:document.title,url:link}):navigator.clipboard?.writeText(link);</script>
</main></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    } catch (e) {
      return jsonError(500, "share_unavailable", e instanceof Error ? e.message : String(e));
    }
  }

  async handleTrackTraffic(request: Request): Promise<Response> {
    const sql = this.sql.bind(this) as SqlTagFn;
    try {
      this.ensureAnalyticsSchema();
      const payload = (await request.json().catch(() => null)) as Partial<TrafficLogRecord> | null;
      const kind = normalizeTrafficEventName(typeof payload?.kind === "string" && payload.kind.trim() ? payload.kind.trim() : "unknown");
      const path = typeof payload?.path === "string" && payload.path.trim() ? payload.path.trim() : "/";
      const source = typeof payload?.source === "string" && payload.source.trim() ? payload.source.trim() : "direct";
      const referrer = typeof payload?.referrer === "string" && payload.referrer.trim() ? payload.referrer.trim() : null;
      const userAgent = typeof payload?.userAgent === "string" && payload.userAgent.trim() ? payload.userAgent.trim() : null;
      const ts = typeof payload?.ts === "number" ? payload.ts : Date.now();
      const eventKey = typeof payload?.eventKey === "string" && payload.eventKey.trim() ? payload.eventKey.trim() : null;
      const requestedReferralCode = normalizeReferralCode(payload?.referralCode);
      const referralCode = requestedReferralCode && sql<{ id: string }>`SELECT id FROM shared_reports WHERE id = ${requestedReferralCode} AND expires_at > ${Date.now()} LIMIT 1`.length > 0
        ? requestedReferralCode
        : null;
      if (requestedReferralCode && !referralCode && ["referral_landing", "referral_checkout_started", "referral_checkout_completed"].includes(kind)) {
        return new Response(JSON.stringify({ ok: true, ignored: true, reason: "referral_not_found_or_expired" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const clientHash = typeof payload?.clientHash === "string" && payload.clientHash.trim() ? payload.clientHash.trim() : null;
      const mcpClientId = typeof payload?.mcpClientId === "string" && payload.mcpClientId.trim() ? payload.mcpClientId.trim() : null;
      const tier = typeof payload?.tier === "string" && payload.tier.trim() ? payload.tier.trim() : null;
      const paymentMethod = typeof payload?.paymentMethod === "string" && payload.paymentMethod.trim() ? payload.paymentMethod.trim() : null;
      const status = typeof payload?.status === "string" && payload.status.trim() ? payload.status.trim() : null;
      const serverVersion = typeof payload?.serverVersion === "string" && payload.serverVersion.trim() ? payload.serverVersion.trim() : SERVER_VERSION;
      const deployment = typeof payload?.deployment === "string" && payload.deployment.trim() ? payload.deployment.trim() : "main";

      if (eventKey && ["checkout_started", "checkout_completed", "subscription_activated"].includes(kind)) {
        const existing = sql<{ id: number }>`SELECT id FROM traffic_log WHERE kind = ${kind} AND event_key = ${eventKey} LIMIT 1`;
        if (existing.length > 0) {
          return new Response(JSON.stringify({ ok: true, deduplicated: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      sql`INSERT INTO traffic_log (kind, path, source, referrer, user_agent, ts, event_key, referral_code, client_hash, mcp_client_id, tier, payment_method, status, server_version, deployment) VALUES (${kind}, ${path}, ${source}, ${referrer}, ${userAgent}, ${ts}, ${eventKey}, ${referralCode}, ${clientHash}, ${mcpClientId}, ${tier}, ${paymentMethod}, ${status}, ${serverVersion}, ${deployment})`;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  async handleTrackUsage(request: Request): Promise<Response> {
    const sql = this.sql.bind(this) as SqlTagFn;
    try {
      this.ensureAnalyticsSchema();
      const payload = (await request.json().catch(() => null)) as Partial<UsageEventRecord> | null;
      const eventName = typeof payload?.eventName === "string" && payload.eventName.trim()
        ? normalizeAnalyticsEventName(payload.eventName.trim())
        : "tool_call_started";
      const tool = typeof payload?.tool === "string" && payload.tool.trim() ? payload.tool.trim() : null;
      const tier = typeof payload?.tier === "string" && payload.tier.trim() ? payload.tier.trim() : null;
      const paymentMethod = typeof payload?.paymentMethod === "string" && payload.paymentMethod.trim()
        ? payload.paymentMethod.trim()
        : null;
      const status = typeof payload?.status === "string" && payload.status.trim() ? payload.status.trim() : null;
      const httpStatus = typeof payload?.httpStatus === "number" ? payload.httpStatus : null;
      const source = typeof payload?.source === "string" && payload.source.trim() ? payload.source.trim() : "direct";
      const clientHash = typeof payload?.clientHash === "string" && payload.clientHash.trim() ? payload.clientHash.trim() : null;
      const ts = typeof payload?.ts === "number" ? payload.ts : Date.now();
      const eventKey = typeof payload?.eventKey === "string" && payload.eventKey.trim() ? payload.eventKey.trim() : null;
      const requestedReferralCode = normalizeReferralCode(payload?.referralCode);
      const referralCode = requestedReferralCode && sql<{ id: string }>`SELECT id FROM shared_reports WHERE id = ${requestedReferralCode} AND expires_at > ${Date.now()} LIMIT 1`.length > 0
        ? requestedReferralCode
        : null;
      const mcpClientId = typeof payload?.mcpClientId === "string" && payload.mcpClientId.trim() ? payload.mcpClientId.trim() : null;
      const serverVersion = typeof payload?.serverVersion === "string" && payload.serverVersion.trim() ? payload.serverVersion.trim() : SERVER_VERSION;
      const deployment = typeof payload?.deployment === "string" && payload.deployment.trim() ? payload.deployment.trim() : "main";

      // Emit one durable activation event per client. This gives the funnel a
      // reliable "first successful tool call" checkpoint without storing tool
      // arguments or request contents.
      if (eventName === "tool_call_completed" && status === "success" && clientHash && !isSyntheticToolName(tool)) {
        const existingActivation = sql<{ id: number }>`SELECT id FROM usage_events WHERE event_name = ${"first_successful_tool_call"} AND client_hash = ${clientHash} LIMIT 1`;
        if (existingActivation.length === 0) {
          sql`INSERT INTO usage_events (event_name, tool, tier, payment_method, status, http_status, source, client_hash, ts, event_key, referral_code, mcp_client_id, server_version, deployment) VALUES (${"first_successful_tool_call"}, ${tool}, ${tier}, ${paymentMethod}, ${"success"}, ${httpStatus}, ${source}, ${clientHash}, ${ts}, ${eventKey ? `${eventKey}:first_successful_tool_call` : null}, ${referralCode}, ${mcpClientId}, ${serverVersion}, ${deployment})`;
        }
        if (referralCode) {
          const existingReferredActivation = sql<{ id: number }>`SELECT id FROM usage_events WHERE event_name = ${"referred_first_successful_tool_call"} AND client_hash = ${clientHash} AND referral_code = ${referralCode} LIMIT 1`;
          if (existingReferredActivation.length === 0) {
            sql`INSERT INTO usage_events (event_name, tool, tier, payment_method, status, http_status, source, client_hash, ts, event_key, referral_code, mcp_client_id, server_version, deployment) VALUES (${"referred_first_successful_tool_call"}, ${tool}, ${tier}, ${paymentMethod}, ${"success"}, ${httpStatus}, ${source}, ${clientHash}, ${ts}, ${eventKey ? `${eventKey}:referred_first_successful_tool_call` : null}, ${referralCode}, ${mcpClientId}, ${serverVersion}, ${deployment})`;
          }
        }
      }

      sql`INSERT INTO usage_events (event_name, tool, tier, payment_method, status, http_status, source, client_hash, ts, event_key, referral_code, mcp_client_id, server_version, deployment) VALUES (${eventName}, ${tool}, ${tier}, ${paymentMethod}, ${status}, ${httpStatus}, ${source}, ${clientHash}, ${ts}, ${eventKey}, ${referralCode}, ${mcpClientId}, ${serverVersion}, ${deployment})`;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  async handleRunDueMonitors(): Promise<Response> {
    const sql = this.sql.bind(this) as SqlTagFn;
    try {
      this.ensureMonitorTables();
      this.sql`CREATE TABLE IF NOT EXISTS monitors (id TEXT PRIMARY KEY, owner_key_hash TEXT NOT NULL, name TEXT NOT NULL, target_type TEXT NOT NULL, target_value TEXT NOT NULL, instructions TEXT, schedule TEXT NOT NULL DEFAULT 'manual', notification_destination TEXT, last_run_at INTEGER, last_run_status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`;
      this.sql`CREATE TABLE IF NOT EXISTS monitor_results (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, owner_key_hash TEXT NOT NULL, run_at INTEGER NOT NULL, status TEXT NOT NULL, changed INTEGER NOT NULL DEFAULT 0, old_value TEXT, new_value TEXT, confidence REAL, evidence TEXT, error_details TEXT, raw_metadata TEXT)`;

      const now = Date.now();
      const all = sql<MonitorRecord>`SELECT * FROM monitors WHERE active = 1 AND schedule != 'manual'`;
      const due = all.filter(m => isDueForRun(m, now));

      let ran = 0;
      let changed = 0;
      let errors = 0;

      for (const monitor of due) {
        try {
          const outcome = await runMonitorVerification(sql, monitor);
          const resultId = generateResultId();
          const runAt = Date.now();
          const finalStatus = outcome.status === "error" ? "error" : outcome.changed ? "changed" : "unchanged";
          sql`INSERT INTO monitor_results (id, monitor_id, owner_key_hash, run_at, status, changed, old_value, new_value, confidence, evidence, error_details, raw_metadata) VALUES (${resultId}, ${monitor.id}, ${monitor.owner_key_hash}, ${runAt}, ${finalStatus}, ${outcome.changed ? 1 : 0}, ${outcome.oldValue ?? null}, ${outcome.newValue || null}, ${outcome.confidence}, ${JSON.stringify(outcome.evidence)}, ${outcome.errorDetails ?? null}, ${JSON.stringify(outcome.rawMetadata)})`;
          sql`UPDATE monitors SET last_run_at = ${runAt}, last_run_status = ${finalStatus}, updated_at = ${runAt} WHERE id = ${monitor.id}`;
          if (outcome.changed && getNotificationDestination(monitor.notification_destination)) {
            const notified = await sendMonitorNotification(this.env, monitor, outcome, resultId);
            this.sql`INSERT INTO traffic_log (kind, path, source, status, ts, server_version, deployment) VALUES (${notified ? "monitor_notification_sent" : "monitor_notification_failed"}, ${`/monitor/${monitor.id}`}, ${"monitor"}, ${notified ? "success" : "failed"}, ${Date.now()}, ${SERVER_VERSION}, ${"main"})`;
          }
          ran++;
          if (outcome.changed) changed++;
          if (outcome.status === "error") errors++;
        } catch {
          errors++;
        }
      }

      return new Response(JSON.stringify({ ran, changed, errors, total_due: due.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  async handleStats(): Promise<Response> {
    const sql = this.sql.bind(this) as SqlTagFn;
    try {
      this.ensureAnalyticsSchema();
      this.sql`CREATE TABLE IF NOT EXISTS usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT, ts INTEGER, success INTEGER)`;

      const now = Date.now();
      const cutoff30 = now - 30 * 24 * 60 * 60 * 1000;
      const totalUsage = sql<{ count: number }>`SELECT COUNT(*) as count FROM usage_events WHERE event_name IN ('tool_call_started', 'tool_call_received') AND (tool IS NULL OR tool NOT GLOB '__verifymcp_auth_probe_*__')`;
      const completedUsage = sql<{ count: number }>`SELECT COUNT(*) as count FROM usage_events WHERE event_name = 'tool_call_completed' AND status = 'success' AND (tool IS NULL OR tool NOT GLOB '__verifymcp_auth_probe_*__')`;
      const rejectedUsage = sql<{ count: number }>`SELECT COUNT(*) as count FROM usage_events WHERE (event_name = 'payment_required' OR (event_name IN ('tool_call_failed', 'tool_call_completed') AND status IN ('failed', 'rejected'))) AND (tool IS NULL OR tool NOT GLOB '__verifymcp_auth_probe_*__')`;
      const totalCount = totalUsage[0]?.count ?? 0;
      const completedCount = completedUsage[0]?.count ?? 0;
      const rejectedCount = rejectedUsage[0]?.count ?? 0;
      const byTool = sql<{ tool: string; count: number }>`SELECT tool, COUNT(*) as count FROM usage_events WHERE event_name IN ('tool_call_started', 'tool_call_received') AND tool IS NOT NULL AND tool NOT GLOB '__verifymcp_auth_probe_*__' GROUP BY tool ORDER BY count DESC`;
      const byEvent = sql<{ event_name: string; count: number }>`SELECT event_name, COUNT(*) as count FROM usage_events WHERE (tool IS NULL OR tool NOT GLOB '__verifymcp_auth_probe_*__') GROUP BY event_name ORDER BY count DESC`;
      const byTier = sql<{ tier: string; count: number }>`SELECT tier, COUNT(*) as count FROM usage_events WHERE event_name IN ('tool_call_started', 'tool_call_received') AND tier IS NOT NULL AND (tool IS NULL OR tool NOT GLOB '__verifymcp_auth_probe_*__') GROUP BY tier ORDER BY count DESC`;
      const byPaymentMethod = sql<{ payment_method: string; count: number }>`SELECT payment_method, COUNT(*) as count FROM usage_events WHERE payment_method IS NOT NULL GROUP BY payment_method ORDER BY count DESC`;
      const bySource = sql<{ source: string; count: number }>`SELECT source, COUNT(*) as count FROM traffic_log WHERE source IS NOT NULL GROUP BY source`;
      const byKind = sql<{ kind: string; count: number }>`SELECT kind, COUNT(*) as count FROM traffic_log WHERE kind IS NOT NULL GROUP BY kind`;
      const byPath = sql<{ path: string; count: number }>`SELECT path, COUNT(*) as count FROM traffic_log WHERE path IS NOT NULL GROUP BY path ORDER BY count DESC LIMIT 20`;
      const totalTraffic = sql<{ count: number }>`SELECT COUNT(*) as count FROM traffic_log`;
      const rollingRows = sql<{
        event_name: string;
        tool: string | null;
        tier: string | null;
        payment_method: string | null;
        status: string | null;
        client_hash: string | null;
        referral_code: string | null;
        ts: number;
      }>`SELECT event_name, tool, tier, payment_method, status, client_hash, referral_code, ts FROM usage_events WHERE ts >= ${cutoff30} AND (tool IS NULL OR tool NOT GLOB '__verifymcp_auth_probe_*__')`;
      const rollingMetrics = calculateRollingUsageMetrics(
        rollingRows.map(row => ({
          eventName: row.event_name,
          tool: row.tool,
          tier: row.tier,
          paymentMethod: row.payment_method,
          status: row.status,
          clientHash: row.client_hash,
          referralCode: row.referral_code,
          ts: row.ts,
        })),
        now,
      );

      const toolBreakdown = byTool.reduce((acc, row) => {
        acc[row.tool] = row.count;
        return acc;
      }, {} as Record<string, number>);

      const eventBreakdown = byEvent.reduce((acc, row) => {
        const eventName = normalizeAnalyticsEventName(row.event_name);
        acc[eventName] = (acc[eventName] ?? 0) + row.count;
        return acc;
      }, {} as Record<string, number>);

      const tierBreakdown = byTier.reduce((acc, row) => {
        acc[row.tier] = row.count;
        return acc;
      }, {} as Record<string, number>);

      const paymentBreakdown = byPaymentMethod.reduce((acc, row) => {
        acc[row.payment_method] = row.count;
        return acc;
      }, {} as Record<string, number>);

      const sourceBreakdown = bySource.reduce((acc, row) => {
        acc[row.source] = row.count;
        return acc;
      }, {} as Record<string, number>);

      const kindBreakdown = byKind.reduce((acc, row) => {
        const kind = normalizeTrafficEventName(row.kind);
        acc[kind] = (acc[kind] ?? 0) + row.count;
        return acc;
      }, {} as Record<string, number>);

      const checkoutFunnel = normalizeCheckoutFunnel(
        kindBreakdown.checkout_started ?? 0,
        kindBreakdown.checkout_completed ?? 0,
      );
      const referralLandings = kindBreakdown.referral_landing ?? 0;
      const referralCheckoutCompletions = kindBreakdown.referral_checkout_completed ?? 0;
      const referredFirstSuccessfulToolCallUsers = rollingMetrics.last30Days.referredFirstSuccessfulToolCallUsers;
      const notificationSent = kindBreakdown.monitor_notification_sent ?? 0;
      const notificationFailed = kindBreakdown.monitor_notification_failed ?? 0;

      return new Response(JSON.stringify({
        metrics: {
          uniqueMcpClientsLast7Days: rollingMetrics.last7Days.uniqueMcpClients,
          uniqueMcpClientsLast30Days: rollingMetrics.last30Days.uniqueMcpClients,
          uniqueToolUsersLast7Days: rollingMetrics.last7Days.uniqueToolUsers,
          uniqueToolUsersLast30Days: rollingMetrics.last30Days.uniqueToolUsers,
          repeatUsersLast30Days: rollingMetrics.last30Days.repeatUsers,
          toolCallsLast7Days: rollingMetrics.last7Days.toolCalls,
          toolCallsLast30Days: rollingMetrics.last30Days.toolCalls,
          paidUsersLast30Days: rollingMetrics.last30Days.paidUsers,
          paidCallsLast30Days: rollingMetrics.last30Days.paidCalls,
          paymentRequiredEventsLast30Days: rollingMetrics.last30Days.paymentRequiredEvents,
          paidIntentEventsLast30Days: rollingMetrics.last30Days.paidIntentEvents,
          monitorIntentEventsLast30Days: rollingMetrics.last30Days.monitorIntentEvents,
          monitorPreviewUsersLast30Days: rollingMetrics.last30Days.monitorPreviewUsers,
          authorizedMonitorUsersLast30Days: rollingMetrics.last30Days.authorizedMonitorUsers,
          freeMonitorUsersLast30Days: rollingMetrics.last30Days.freeMonitorUsers,
          persistentMonitorCreatorsLast30Days: rollingMetrics.last30Days.persistentMonitorCreators,
          persistentMonitorFirstRunUsersLast30Days: rollingMetrics.last30Days.persistentMonitorFirstRunUsers,
          qualifiedActivationUsersLast30Days: rollingMetrics.last30Days.qualifiedActivationUsers,
          firstSuccessfulToolCallUsersLast30Days: rollingMetrics.last30Days.firstSuccessfulToolCallUsers,
          referredToolCallsLast30Days: rollingMetrics.last30Days.referredToolCalls,
          referredFirstSuccessfulToolCallUsersLast30Days: rollingMetrics.last30Days.referredFirstSuccessfulToolCallUsers,
          referredRepeatUsersLast30Days: rollingMetrics.last30Days.referredRepeatUsers,
          firstPaidCallUsersLast30Days: rollingMetrics.last30Days.firstPaidCallUsers,
          conversionToFirstPaidCallLast30Days: rollingMetrics.last30Days.conversionToFirstPaidCall,
          usageByToolLast30Days: rollingMetrics.last30Days.byTool,
        },
        rolling: rollingMetrics,
        definitions: {
          uniqueMcpClients: "Distinct hashed client identifiers seen on MCP connection or tool events in the period.",
          uniqueToolUsers: "Distinct hashed client identifiers that started at least one tool call in the period.",
          repeatUsers: "A client with tool usage on at least two separate UTC calendar days in the last 30 days.",
          conversionToFirstPaidCall: "Paid users divided by unique tool users in the last 30 days; this is a windowed rate, not a cohort retention model.",
          paidCall: "A successful paid_tool_call event, or a tool call historically recorded with team/x402 tier.",
          paidIntent: "A paid-only tool call attempted without a subscription or x402 payment.",
          monitorIntent: "A monitor tool call attempted without a free watch key or paid API key.",
          monitorPreviewUser: "A client that captured a free live source baseline with preview_monitor.",
          freeMonitorUser: "A client that used a persistent monitor with a free watch key.",
          authorizedMonitorUser: "A client that called a persistent monitor tool with an active free-monitor or team tier.",
          persistentMonitorCreator: "A client that successfully created at least one persistent monitor.",
          persistentMonitorFirstRunUser: "A client that completed the first live run for a persistent monitor workspace.",
          qualifiedActivationUser: "A client that previewed monitoring or used an authorized persistent monitor.",
          firstSuccessfulToolCall: "The first successful completed tool call for a hashed client identifier.",
          referredToolCall: "A tool call carrying a validated X-Ground-Truth-Referral header from a shared report.",
          referredFirstSuccessfulToolCall: "The first successful completed tool call for a client carrying a validated referral code.",
          referredFirstSuccessfulToolCallEvent: "A separate idempotent referral activation event, emitted even when the client had activated previously through another path.",
          referralHeader: "Clients can preserve share attribution by sending X-Ground-Truth-Referral: shr_... on MCP requests; only the validated code is stored.",
          privacy: "Client identifiers are SHA-256 hashes of an API key or anonymous client source; request payloads are not stored in analytics.",
        },
        totalRequests: totalCount,
        completedRequests: completedCount,
        rejectedRequests: rejectedCount,
        byTool: toolBreakdown,
        byEvent: eventBreakdown,
        byTier: tierBreakdown,
        byPaymentMethod: paymentBreakdown,
        trafficBySource: sourceBreakdown,
        trafficByKind: kindBreakdown,
        topPaths: byPath,
        funnel: {
          homepageViews: kindBreakdown.homepage_view ?? 0,
          pricingViews: kindBreakdown.pricing_view ?? 0,
          completedToolCalls: completedCount,
          paidIntents: eventBreakdown.paid_intent ?? 0,
          monitorIntents: eventBreakdown.monitor_intent ?? 0,
          monitorPreviewsStarted: eventBreakdown.monitor_preview_started ?? 0,
          monitorPreviewsCompleted: eventBreakdown.monitor_preview_completed ?? 0,
          freeMonitorAccessCreated: eventBreakdown.free_monitor_access_created ?? 0,
          persistentMonitorsCreated: eventBreakdown.persistent_monitor_created ?? 0,
          persistentMonitorFirstRuns: eventBreakdown.persistent_monitor_first_run ?? 0,
          watchDashboardViews: kindBreakdown.watch_dashboard_view ?? 0,
          firstSuccessfulToolCalls: eventBreakdown.first_successful_tool_call ?? 0,
          sharedReportViews: kindBreakdown.shared_report_viewed ?? 0,
          referralLandings: kindBreakdown.referral_landing ?? 0,
          referralCheckoutStarts: kindBreakdown.referral_checkout_started ?? 0,
          referralCheckoutCompletions: kindBreakdown.referral_checkout_completed ?? 0,
          referralRewardsCredited: kindBreakdown.referral_reward_credited ?? 0,
          monitorNotificationsSent: kindBreakdown.monitor_notification_sent ?? 0,
          monitorNotificationsFailed: kindBreakdown.monitor_notification_failed ?? 0,
          referralLandingToCheckoutConversion: referralLandings === 0 ? 0 : +(referralCheckoutCompletions / referralLandings).toFixed(4),
          referralLandingToReferredFirstCallConversion: referralLandings === 0 ? 0 : +(referredFirstSuccessfulToolCallUsers / referralLandings).toFixed(4),
          monitorNotificationDeliveryRate: notificationSent + notificationFailed === 0 ? 0 : +(notificationSent / (notificationSent + notificationFailed)).toFixed(4),
          ...checkoutFunnel,
          checkoutCreated: kindBreakdown.checkout_created ?? 0,
          subscriptionActivations: kindBreakdown.subscription_activated ?? 0,
        },
        lifetime: {
          trafficEvents: totalTraffic[0]?.count ?? 0,
          toolCalls: totalCount,
          successfulToolCalls: completedCount,
          paymentRequiredEvents: eventBreakdown.payment_required ?? 0,
        },
        timestamp: new Date().toISOString(),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}


/**
 * Run the MCP transport with a guard so an unhandled exception in the
 * agents/MCP framework surfaces as a clean JSON-RPC error instead of an opaque
 * Cloudflare worker exception (HTTP 500 "error code: 1101"). That opaque error
 * is invisible to MCP clients and to our analytics, so a transport-level
 * failure silently blocks every connection and every tool call. Here we catch
 * it, log the real message/stack, and return a structured error the client and
 * our own health checks can read.
 */
async function serveMcpGuarded(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: number | string | null,
): Promise<Response> {
  try {
    return await GroundTruthMCP.serve("/mcp").fetch(request, env, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("mcp_transport_failure", message, error instanceof Error ? error.stack : undefined);
    return jsonError(
      500,
      "mcp_transport_failure",
      `The MCP transport failed to handle this request: ${message}`,
      { stage: "mcp_serve", serverVersion: SERVER_VERSION },
      requestId,
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const isPrimaryMcpPath = url.pathname === "/mcp";
    const queueTrafficLog = (kind: string, context: {
      eventKey?: string | null;
      referralCode?: string | null;
      mcpClientId?: string | null;
      tier?: string | null;
      paymentMethod?: string | null;
      status?: string | null;
    } = {}): Promise<void> => {
      if (request.headers.get("X-Ground-Truth-Test") === "true" || isSyntheticMcpClientIdentifier(context.mcpClientId)) {
        return Promise.resolve();
      }
      try {
        const id = env.MCP_OBJECT.idFromName("ground-truth");
        const stub = env.MCP_OBJECT.get(id);
        const write = (async () => {
          const apiKey = request.headers.get("X-API-Key")?.trim();
          const anonymousClient = getAnonymousClientSource(request);
          const clientHash = await sha256Hex(apiKey ?? `${anonymousClient.type}:${anonymousClient.value}`);
          const payload: TrafficLogRecord = {
            kind: normalizeTrafficEventName(kind),
            path: url.pathname,
            source: inferTrafficSource(request),
            referrer: request.headers.get("referer"),
            userAgent: request.headers.get("user-agent"),
            ts: Date.now(),
            eventKey: context.eventKey ?? null,
            referralCode: context.referralCode ?? normalizeReferralCode(request.headers.get("X-Ground-Truth-Referral")),
            clientHash,
            mcpClientId: context.mcpClientId ?? null,
            tier: context.tier ?? null,
            paymentMethod: context.paymentMethod ?? null,
            status: context.status ?? null,
            serverVersion: SERVER_VERSION,
            deployment: inferDeployment(request),
          };
          await stub.fetch(
            new Request("https://internal/track-traffic", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            }),
          );
        })().catch(() => undefined);
        ctx.waitUntil(write);
        return write;
      } catch {
        // Traffic logging must never block the request path.
        return Promise.resolve();
      }
    };

    const queueUsageEvent = (
      eventName: string,
      tool: string | null,
      tier: string | null,
      paymentMethod: string | null,
      status: string | null,
      httpStatus: number | null,
      context: { eventKey?: string | null; referralCode?: string | null; mcpClientId?: string | null } = {},
    ): Promise<void> => {
      const normalizedEventName = normalizeAnalyticsEventName(eventName);
      if (tool && isSyntheticToolName(tool)) return Promise.resolve();
      if (request.headers.get("X-Ground-Truth-Test") === "true" || isSyntheticMcpClientIdentifier(context.mcpClientId)) return Promise.resolve();
      if (!tool && normalizedEventName !== "mcp_connection") return Promise.resolve();
      try {
        const id = env.MCP_OBJECT.idFromName("ground-truth");
        const stub = env.MCP_OBJECT.get(id);
        const apiKey = request.headers.get("X-API-Key")?.trim();
        const anonymousClient = getAnonymousClientSource(request);
        const write = (async () => {
          const clientHash = await sha256Hex(apiKey ?? `${anonymousClient.type}:${anonymousClient.value}`);
          await stub.fetch(
            new Request("https://internal/track-usage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                eventName: normalizedEventName,
                tool,
                tier,
                paymentMethod,
                status,
                httpStatus,
                source: inferTrafficSource(request),
                clientHash,
                ts: Date.now(),
                eventKey: context.eventKey ?? null,
                referralCode: context.referralCode ?? normalizeReferralCode(request.headers.get("X-Ground-Truth-Referral")),
                mcpClientId: context.mcpClientId ?? null,
                serverVersion: SERVER_VERSION,
                deployment: inferDeployment(request),
              } satisfies UsageEventRecord),
            }),
          );
        })().catch(() => undefined);
        ctx.waitUntil(write);
        return write;
      } catch {
        // Usage analytics must never block or fail the product request.
        return Promise.resolve();
      }
    };

    const creditReferralReward = async (code: string | null, referredApiKey: string | null): Promise<void> => {
      if (!code) return;
      try {
        const id = env.MCP_OBJECT.idFromName("ground-truth");
        const stub = env.MCP_OBJECT.get(id);
        await stub.fetch(new Request("https://internal/referral/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, referredKeyHash: referredApiKey ? await sha256Hex(referredApiKey) : null }),
        }));
      } catch {
        // Referral rewards must never block checkout completion.
      }
    };

    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname === "/robots.txt") {
        return textResponse(getRobotsTxt(url));
      }

      if (url.pathname === "/llms.txt") {
        return textResponse(getLlmsTxt(url));
      }

      if (url.pathname === "/sitemap.xml") {
        return new Response(getSitemapXml(url), {
          headers: {
            "content-type": "application/xml; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        });
      }
    }

    // ───────────────────────────────────────────────
    // MCP endpoint with billing and usage enforcement
    // ───────────────────────────────────────────────
    if (isPrimaryMcpPath) {
      let body: McpToolCallBody | null = null;
      try {
        body = await request.clone().json() as McpToolCallBody;
      } catch {
        body = null;
      }

      const method = typeof body?.method === "string" ? body.method : null;
      const requestId = normalizeJsonRpcId(body?.id);
      const toolName = method === "tools/call" && typeof body?.params?.name === "string"
        ? body.params.name
        : null;

      const apiKeyPresent = Boolean(request.headers.get("X-API-Key")?.trim());
      const meta = body?.params?._meta as Record<string, unknown> | undefined;
      const mcpClientId = getMcpClientIdentifier(request, body);
      const x402PaymentPresent = Boolean(meta?.["x402/payment"] || meta?.["x402/payment-signature"]);
      const syntheticToolCall = isSyntheticToolName(toolName);
      const suppliedApiKey = request.headers.get("X-API-Key")?.trim();
      const monitorKeyRecord = suppliedApiKey && toolName && (MONITOR_TOOLS as readonly string[]).includes(toolName)
        ? await getApiKeyRecord(env.API_KEYS, suppliedApiKey)
        : null;
      const freeMonitorKey = Boolean(monitorKeyRecord && hasFreeMonitorFallback(monitorKeyRecord));
      const usageTier = toolName && (MONITOR_TOOLS as readonly string[]).includes(toolName)
        ? (apiKeyPresent ? freeMonitorKey ? "free_monitor" : "team" : "rejected")
        : toolName && (PAID_TOOLS as readonly string[]).includes(toolName)
          ? (x402PaymentPresent ? "x402" : apiKeyPresent ? "team" : "paid_gated")
          : apiKeyPresent ? "team_or_free" : "free";
      const usagePaymentMethod = x402PaymentPresent
        ? "x402"
        : apiKeyPresent && !freeMonitorKey
          ? "subscription"
          : null;
      if (!syntheticToolCall) {
        queueTrafficLog(
          toolName ? "tool_call_started" : method === "initialize" ? "mcp_connection" : "mcp_request",
          { mcpClientId, tier: usageTier, paymentMethod: usagePaymentMethod, status: "started" },
        );
      }
      if (method === "initialize") {
        queueUsageEvent("mcp_connection", null, null, null, "started", null, { mcpClientId });
      }
      if (toolName) {
        queueUsageEvent("tool_call_started", toolName, usageTier, usagePaymentMethod, "started", null, { mcpClientId });
      }
      let paidCallAuthorized = false;
      const queueToolFailure = (response: Response) => {
        if (toolName) {
          queueUsageEvent("tool_call_failed", toolName, usageTier, usagePaymentMethod, "failed", response.status, { mcpClientId });
        }
        return response;
      };

      if (method === "tools/call" && toolName) {
        if ((FREE_TOOLS as readonly string[]).includes(toolName)) {
          const maybeApiKey = request.headers.get("X-API-Key")?.trim();
          let proUsageApplied = false;

          if (maybeApiKey) {
            const apiKeyRecord = await getApiKeyRecord(env.API_KEYS, maybeApiKey);
            if (apiKeyRecord && isBillingActive(apiKeyRecord)) {
              const month = getCurrentUsageMonth();
              const subjectId = await sha256Hex(maybeApiKey);
              const usageKey = getUsageStorageKey("pro", month, subjectId);
              const limit = getProQuota(apiKeyRecord);
              const usage = await checkUsageLimit(env.API_KEYS, usageKey, limit);

              if (!usage.allowed) {
                return queueToolFailure(jsonError(
                  429,
                  "quota_exceeded",
                  `Monthly quota exceeded for ${month}. You have used ${usage.used} of ${limit} included calls.`,
                  {
                    tier: "paid",
                    tool: toolName,
                    month,
                    limit,
                    used: usage.used,
                    remaining: usage.remaining,
                  },
                  requestId,
                ));
              }

              await incrementUsage(env.API_KEYS, usageKey, "pro", subjectId, month, toolName);
              proUsageApplied = true;
            }
          }

          if (!proUsageApplied) {
            const freeClient = getAnonymousClientSource(request);
            const month = getCurrentUsageMonth();
            const subjectId = await sha256Hex(`${freeClient.type}:${freeClient.value}`);
            
            // Special handling for verify_claim with 5-call limit
            const isVerifyClaim = toolName === "verify_claim";
            const limit = isVerifyClaim ? FREE_VERIFY_CLAIM_LIMIT : FREE_MONTHLY_LIMIT;
            const usageKey = getUsageStorageKey(
              isVerifyClaim ? "free_verify_claim" : "free", 
              month, 
              subjectId
            );
            const usage = await checkUsageLimit(env.API_KEYS, usageKey, limit);

            if (!usage.allowed) {
              // Special error message for verify_claim limit
              if (isVerifyClaim) {
                return queueToolFailure(jsonError(
                  429,
                  "quota_exceeded",
                  `Free verify_claim quota exceeded for ${month}. Get unlimited access with the paid plan.`,
                  {
                    tier: "free",
                    tool: toolName,
                    month,
                    limit: FREE_VERIFY_CLAIM_LIMIT,
                    used: usage.used,
                    remaining: usage.remaining,
                    clientType: freeClient.type,
                    upgradeUrl: CHECKOUT_URL,
                    upgradeMessage: `${MONTHLY_PRICE_STR}, includes all paid tools and unlimited verify_claim`,
                  },
                  requestId,
                ));
              }
              
              return queueToolFailure(jsonError(
                429,
                "quota_exceeded",
                `Free monthly quota exceeded for ${month}.`,
                {
                  tier: "free",
                  tool: toolName,
                  month,
                  limit: FREE_MONTHLY_LIMIT,
                  used: usage.used,
                  remaining: usage.remaining,
                  clientType: freeClient.type,
                },
                requestId,
              ));
            }

            if (usage.used === 0) {
              ctx.waitUntil(logRemoteUsage(toolName, true, isVerifyClaim ? "first_free_verify_claim" : "first_free_tool_call_allowed", {
                month,
                client_type: freeClient.type,
                quota_limit: limit,
              }));
            }

            await incrementUsage(env.API_KEYS, usageKey, isVerifyClaim ? "free_verify_claim" : "free", subjectId, month, toolName);
          }
        } else if ((MONITOR_TOOLS as readonly string[]).includes(toolName)) {
          const maybeApiKey = request.headers.get("X-API-Key")?.trim();
          if (!maybeApiKey) {
            await queueUsageEvent("monitor_intent", toolName, "rejected", null, "rejected", 401, { mcpClientId });
            await queueTrafficLog("monitor_intent", { mcpClientId, tier: "rejected", status: "rejected" });
            return queueToolFailure(jsonError(
              401,
              "missing_api_key",
              `Tool '${toolName}' requires a free watch key or paid API key.`,
              {
                tier: "free_monitor",
                tool: toolName,
                startFreeUrl: `${PUBLIC_APP_ORIGIN}/watch`,
                nextAction: "Create a free watch key, then retry with X-API-Key. Free includes three persistent daily or weekly monitors.",
                includesMonitorAccess: true,
              },
              requestId,
            ));
          }
          const monitorAccess = await requireMonitorAccess(env.API_KEYS, request, toolName, requestId);
          if (monitorAccess instanceof Response) {
            return queueToolFailure(monitorAccess);
          }
          const monitorArguments = body?.params?.arguments && typeof body.params.arguments === "object"
            ? body.params.arguments as Record<string, unknown>
            : {};
          if (monitorAccess.accessTier === "free_monitor" && toolName === "create_monitor" && monitorArguments.schedule === "hourly") {
            return queueToolFailure(jsonError(403, "hourly_schedule_requires_upgrade", "Free monitors run daily or weekly. Upgrade for hourly checks.", {
              tier: "free_monitor",
              tool: toolName,
              allowedSchedules: ["manual", "daily", "weekly"],
              upgradeUrl: `${PUBLIC_APP_ORIGIN}/pricing`,
            }, requestId));
          }
          await incrementUsage(env.API_KEYS, monitorAccess.usageKey, monitorAccess.usageSubjectType, monitorAccess.subjectId, monitorAccess.month, toolName);
          paidCallAuthorized = monitorAccess.accessTier === "team";
          const monitorLimitForTier = monitorAccess.accessTier === "free_monitor"
            ? FREE_MONITOR_LIMIT
            : monitorAccess.apiKeyRecord.activeMonitorLimit ?? PAID_ACTIVE_MONITOR_LIMIT;
          const accountId = env.MCP_OBJECT.idFromName(`account:${monitorAccess.subjectId}`);
          const accountStub = env.MCP_OBJECT.get(accountId);
          const accountResponse = await accountStub.fetch(new Request("https://internal/monitor-action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: toolName, arguments: monitorArguments, ownerKeyHash: monitorAccess.subjectId, activeMonitorLimit: monitorLimitForTier }),
          }));
          const monitorPayload = await accountResponse.json().catch(() => ({ error: "monitor_action_failed", message: "The monitor response could not be read." })) as Record<string, unknown>;
          const monitorSucceeded = accountResponse.ok && !monitorPayload.error;
          await queueUsageEvent(monitorSucceeded ? "tool_call_completed" : "tool_call_failed", toolName, monitorAccess.accessTier, usagePaymentMethod, monitorSucceeded ? "success" : "failed", accountResponse.status, { mcpClientId });
          if (monitorSucceeded && toolName === "create_monitor") {
            await queueUsageEvent("persistent_monitor_created", toolName, monitorAccess.accessTier, usagePaymentMethod, "success", accountResponse.status, { mcpClientId });
          }
          if (monitorSucceeded && toolName === "run_monitor_now") {
            const activationKey = `plg:first-monitor-run:${monitorAccess.subjectId}`;
            if (!await env.API_KEYS.get(activationKey)) {
              await env.API_KEYS.put(activationKey, new Date().toISOString());
              await queueUsageEvent("persistent_monitor_first_run", toolName, monitorAccess.accessTier, usagePaymentMethod, "success", accountResponse.status, { mcpClientId });
            }
          }
          if (monitorSucceeded && toolName === "create_share_link" && typeof monitorPayload.report_id === "string") {
            await env.API_KEYS.put(`share-owner:${monitorPayload.report_id}`, monitorAccess.subjectId, { expirationTtl: SHARED_REPORT_MAX_TTL_DAYS * 24 * 60 * 60 });
          }
          if (paidCallAuthorized) await queueUsageEvent("paid_tool_call", toolName, usageTier, usagePaymentMethod, "success", null, { mcpClientId });
          const result = {
            content: [{ type: "text", text: JSON.stringify(monitorPayload) }],
            structuredContent: monitorPayload,
            ...(monitorSucceeded ? {} : { isError: true }),
          };
          const responseHeaders = new Headers({ "Content-Type": "application/json" });
          const sessionId = request.headers.get("mcp-session-id");
          if (sessionId) responseHeaders.set("mcp-session-id", sessionId);
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: requestId, result }), { status: 200, headers: responseHeaders });
        } else if ((PAID_TOOLS as readonly string[]).includes(toolName)) {
          const maybeApiKey = request.headers.get("X-API-Key")?.trim();
          // First, check for x402 payment (Cloudflare Monetization Gateway)
          if (X402_PAYMENT_ENABLED && !maybeApiKey) {
            const x402PaymentCheck = await checkX402Payment(toolName, meta, env);
            if (x402PaymentCheck.valid) {
              // x402 payment is valid - allow access via Cloudflare Monetization Gateway
              // No usage tracking for x402 payments - each payment is a separate transaction
              const x402Metadata = getX402Metadata(toolName);
              
              // Add x402 metadata to the request for tracking
              ctx.waitUntil(logRemoteUsage(toolName, true, "x402_payment_success", {
                network: X402_NETWORK_CONFIG,
                tool: toolName,
                priceUSD: X402_TOOL_PRICES_USD[toolName as keyof typeof X402_TOOL_PRICES_USD],
              }));
              
              // Return the request with x402 metadata for the MCP server to process
              const modifiedBody = {
                ...body,
                params: {
                  ...body?.params,
                  _meta: {
                    ...meta,
                    ...x402Metadata,
                    "x402/settlement": "confirmed",
                  },
                },
              };
              
              const modifiedRequest = new Request(request, {
                method: request.method,
                headers: request.headers,
                body: JSON.stringify(modifiedBody),
              });
              
              paidCallAuthorized = true;
              await queueUsageEvent("paid_tool_call", toolName, "x402", "x402", "success", null, { mcpClientId });
              const response = await serveMcpGuarded(modifiedRequest, env, ctx, requestId);
              await queueUsageEvent(response.ok ? "tool_call_completed" : "tool_call_failed", toolName, "x402", "x402", response.ok ? "success" : "failed", response.status, { mcpClientId });
              return response;
            }
          }
          
          // Fall back to traditional API key approach
          if (!maybeApiKey) {
            await queueUsageEvent("paid_intent", toolName, "paid_gated", "subscription_or_x402", "rejected", 402, { mcpClientId });
            await queueTrafficLog("paid_intent", { mcpClientId, tier: "paid_gated", paymentMethod: "subscription_or_x402", status: "rejected" });
            await queueUsageEvent("payment_required", toolName, "paid_gated", "subscription_or_x402", "rejected", 402);
            // Compliance-led wording for assess_compliance_posture, generic for others
            const isCompliance = toolName === "assess_compliance_posture";
            const suggestedPreviewTargetType = toolName === "estimate_market"
              ? "custom_prompt"
              : toolName === "verify_claim" || isCompliance
                ? "vendor_claim"
                : "pricing_page";
            const challengeMessage = isCompliance
              ? `Compliance assessment requires a paid subscription. ${MONTHLY_PRICE_STR}, includes all paid tools.`
              : `This tool requires a paid subscription. ${MONTHLY_PRICE_STR}, includes all paid tools.`;
            
            // If x402 is enabled, also include x402 payment information in the error
            const x402Metadata = X402_PAYMENT_ENABLED ? getX402Metadata(toolName) : {};
            
            return jsonError(
              402,
              "payment_required",
              challengeMessage,
              {
                tier: "paid",
                tool: toolName,
                upgradeUrl: CHECKOUT_URL,
                price: MONTHLY_PRICE_STR,
                includesAllPaidTools: true,
                freePreviewTool: "preview_monitor",
                monitorUpgradeTool: "create_monitor",
                previewFirst: true,
                suggestedPreviewCall: {
                  name: "preview_monitor",
                  arguments: {
                    target_type: suggestedPreviewTargetType,
                    target_value: "Use the same public source, URL, package, or claim target you were about to check.",
                    instructions: toolName === "verify_claim" || isCompliance
                      ? "Include the public evidence URL or keywords the agent should inspect."
                      : "Optional comma-separated fields or terms to watch.",
                  },
                },
                suggestedPaidRetry: {
                  name: toolName,
                  headers: { "X-API-Key": "gt_live_..." },
                },
                paidValue: [
                  "saved monitors",
                  "scheduled checks",
                  "evidence history",
                  "change reports",
                  "read-only share links",
                ],
                nextAction: "Call preview_monitor first. If the baseline is useful, subscribe for an X-API-Key and retry this tool or create_monitor for the same source.",
                ...x402Metadata,
              },
              requestId,
            );
          }
          const proAccess = await requireProAccess(env.API_KEYS, request, toolName, requestId);
          if (proAccess instanceof Response) {
            return queueToolFailure(proAccess);
          }
          await incrementUsage(
            env.API_KEYS,
            proAccess.usageKey,
            "pro",
            proAccess.subjectId,
            proAccess.month,
            toolName,
          );
          paidCallAuthorized = true;
        }
      }

      const response = await serveMcpGuarded(request, env, ctx, requestId);
      if (toolName) {
        if (paidCallAuthorized) {
          await queueUsageEvent("paid_tool_call", toolName, usageTier, usagePaymentMethod, "success", null, { mcpClientId });
        }
        await queueUsageEvent(
          response.ok ? "tool_call_completed" : "tool_call_failed",
          toolName,
          usageTier,
          usagePaymentMethod,
          response.ok ? "success" : "failed",
          response.status,
          { mcpClientId },
        );
      }
      return response;
    }

    if (url.pathname === SERVER_CARD_ICON_PATH || url.pathname === "/favicon.ico") {
      return new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-labelledby="title desc">
  <title id="title">Ground Truth</title>
  <desc id="desc">Ground Truth logo</desc>
  <rect width="128" height="128" rx="24" fill="#8d2f12"/>
  <rect x="18" y="24" width="40" height="14" rx="7" fill="#f5e6c8"/>
  <rect x="18" y="57" width="40" height="14" rx="7" fill="#f5e6c8"/>
  <rect x="18" y="90" width="22" height="14" rx="7" fill="#f5e6c8"/>
  <path d="M86 24c-14.359 0-26 11.641-26 26v28c0 14.359 11.641 26 26 26 11.38 0 21.053-7.303 24.596-17.5H92c-3.589 0-6.5-2.91-6.5-6.5S88.411 73.5 92 73.5h20c.553 0 1 .448 1 1C113 90.793 100.793 103 86 103S59 90.793 59 76V50c0-14.911 12.089-27 27-27 10.717 0 19.976 6.243 24.34 15.299l-11.652 5.61C95.76 38.104 91.205 24 86 24Z" fill="#f5e6c8"/>
</svg>`,
        {
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        },
      );
    }

    if (url.pathname === "/.well-known/mcp/server-card.json") {
      const publicOrigin = url.origin;
      const homepage = `${publicOrigin}/`;
      const icon = `${publicOrigin}${SERVER_CARD_ICON_PATH}`;
      return jsonResponse({
        name: "ground-truth",
        title: "Ground Truth",
        description: SERVER_CARD_DESCRIPTION,
        homepage,
        icon,
        serverInfo: {
          name: "ground-truth",
          title: "Ground Truth",
          version: SERVER_VERSION,
        },
        authentication: {
          required: false,
          schemes: ["header"],
        },
        metadata: {
          description: SERVER_CARD_DESCRIPTION,
          homepage,
          website: homepage,
          icon,
          pricing: `${publicOrigin}/pricing`,
          freeTools: FREE_TOOLS,
          freeVerifyClaimLimit: FREE_VERIFY_CLAIM_LIMIT,
          freeMonitorPlan: {
            priceUsdMonthly: 0,
            activeMonitorLimit: FREE_MONITOR_LIMIT,
            monthlyQuota: FREE_MONITOR_MONTHLY_QUOTA,
            schedules: ["manual", "daily", "weekly"],
            dashboard: `${publicOrigin}/watch`,
            header: "X-API-Key",
          },
          paidPlans: PAID_PLAN_ORDER.map((id: PaidPlanId) => ({
            id,
            name: PAID_PLANS[id].name,
            priceUsdMonthly: PAID_PLANS[id].priceUsd,
            monthlyQuota: PAID_PLANS[id].monthlyQuota,
            activeMonitorLimit: PAID_PLANS[id].activeMonitorLimit,
          })),
          paidPlan: {
            priceUsdMonthly: PAID_PLAN_PRICE_USD,
            quota: PAID_MONTHLY_LIMIT,
            activeMonitorLimit: PAID_ACTIVE_MONITOR_LIMIT,
            sharing: "read_only_share_links",
            header: "X-API-Key",
            includesAllPaidTools: true,
            paidTools: PAID_TOOLS,
          },
        },
        tools: SERVER_CARD_TOOLS,
        resources: [],
        prompts: [],
      });
    }

    // ───────────────────────────────────────────────
    // Self-serve monitor preview
    // ───────────────────────────────────────────────
    if (url.pathname === "/api/preview-monitor" && request.method === "POST") {
      const anonymousClient = getAnonymousClientSource(request);
      const month = getCurrentUsageMonth();
      const subjectId = await sha256Hex(`${anonymousClient.type}:${anonymousClient.value}`);
      const usageKey = getUsageStorageKey("free", month, subjectId);
      const usage = await checkUsageLimit(env.API_KEYS, usageKey, FREE_MONTHLY_LIMIT);
      if (!usage.allowed) {
        return jsonError(429, "quota_exceeded", "Free monthly preview quota exceeded.", {
          month,
          limit: FREE_MONTHLY_LIMIT,
          used: usage.used,
          remaining: usage.remaining,
        });
      }
      await incrementUsage(env.API_KEYS, usageKey, "free", subjectId, month, "preview_monitor");
      queueTrafficLog("monitor_preview_started", { status: "started" });
      queueUsageEvent("monitor_preview_started", "preview_monitor", "free", null, "started", null, { mcpClientId: "monitor-lab-web" });
      try {
        const body = await request.text();
        if (body.length > 8_000) return jsonError(413, "preview_too_large", "Preview input is too large.");
        const id = env.MCP_OBJECT.idFromName("ground-truth");
        const stub = env.MCP_OBJECT.get(id);
        const response = await stub.fetch(new Request("https://internal/preview-monitor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }));
        queueTrafficLog("monitor_preview_completed", { status: response.ok ? "success" : "failed" });
        queueUsageEvent("monitor_preview_completed", "preview_monitor", "free", null, response.ok ? "success" : "failed", response.status, { mcpClientId: "monitor-lab-web" });
        return response;
      } catch (e) {
        queueTrafficLog("monitor_preview_completed", { status: "failed" });
        return jsonError(500, "preview_unavailable", e instanceof Error ? e.message : String(e));
      }
    }

    // ───────────────────────────────────────────────
    // Product-led persistent monitoring
    // ───────────────────────────────────────────────
    if (url.pathname === "/api/watch/access" && request.method === "POST") {
      const existingKey = request.headers.get("X-Ground-Truth-Key")?.trim() || request.headers.get("X-API-Key")?.trim();
      if (existingKey) {
        const existingRecord = await getApiKeyRecord(env.API_KEYS, existingKey);
        if (!existingRecord || (!hasFreeMonitorFallback(existingRecord) && !isBillingActive(existingRecord))) {
          return jsonError(401, "invalid_watch_key", "This watch key is invalid or inactive. Remove it from this browser to create a new free workspace.");
        }
        const paid = isBillingActive(existingRecord) && !hasFreeMonitorFallback(existingRecord);
        return jsonResponse({
          apiKey: existingKey,
          plan: paid ? existingRecord.plan ?? "good" : "free",
          accessTier: paid ? "team" : "free_monitor",
          activeMonitorLimit: paid ? existingRecord.activeMonitorLimit ?? PAID_ACTIVE_MONITOR_LIMIT : FREE_MONITOR_LIMIT,
          monthlyQuota: paid ? existingRecord.monthlyQuota ?? PAID_MONTHLY_LIMIT : FREE_MONITOR_MONTHLY_QUOTA,
          allowedSchedules: paid ? ["manual", "hourly", "daily", "weekly"] : ["manual", "daily", "weekly"],
          upgradeUrl: `${PUBLIC_APP_ORIGIN}/pricing`,
        }, { headers: { "Cache-Control": "no-store" } });
      }

      const anonymousClient = getAnonymousClientSource(request);
      const clientHash = await sha256Hex(`${anonymousClient.type}:${anonymousClient.value}`);
      const day = new Date().toISOString().slice(0, 10);
      const issuanceKey = `plg:watch-access:${day}:${clientHash}`;
      const issuedToday = Number.parseInt(await env.API_KEYS.get(issuanceKey) ?? "0", 10) || 0;
      if (issuedToday >= 3) {
        return jsonError(429, "watch_access_rate_limited", "Too many free workspaces were created from this client today. Reuse your existing watch key or try again tomorrow.");
      }

      const apiKey = generateApiKey("gt_free_");
      await saveApiKeyRecord(env.API_KEYS, apiKey, {
        active: true,
        billingActive: false,
        subscriptionStatus: "free",
        plan: "free",
        monthlyQuota: FREE_MONITOR_MONTHLY_QUOTA,
        activeMonitorLimit: FREE_MONITOR_LIMIT,
        createdAt: new Date().toISOString(),
      });
      await env.API_KEYS.put(issuanceKey, String(issuedToday + 1), { expirationTtl: 2 * 24 * 60 * 60 });
      await queueTrafficLog("free_monitor_access_created", { tier: "free_monitor", status: "success" });
      await queueUsageEvent("free_monitor_access_created", "create_monitor", "free_monitor", null, "success", 201, { mcpClientId: "watch-dashboard" });
      return jsonResponse({
        apiKey,
        plan: "free",
        accessTier: "free_monitor",
        activeMonitorLimit: FREE_MONITOR_LIMIT,
        monthlyQuota: FREE_MONITOR_MONTHLY_QUOTA,
        allowedSchedules: ["manual", "daily", "weekly"],
        upgradeUrl: `${PUBLIC_APP_ORIGIN}/pricing`,
      }, { status: 201, headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/watch/action" && request.method === "POST") {
      const suppliedKey = request.headers.get("X-Ground-Truth-Key")?.trim() || request.headers.get("X-API-Key")?.trim();
      const accessHeaders = new Headers(request.headers);
      if (suppliedKey) accessHeaders.set("X-API-Key", suppliedKey);
      const accessRequest = new Request(request.url, { method: "POST", headers: accessHeaders });
      const bodyText = await request.text();
      if (bodyText.length > 12_000) return jsonError(413, "watch_action_too_large", "Monitor input is too large.");
      let payload: { action?: string; arguments?: Record<string, unknown> } | null = null;
      try {
        payload = JSON.parse(bodyText || "null") as { action?: string; arguments?: Record<string, unknown> } | null;
      } catch {
        return jsonError(400, "invalid_watch_action", "Send a valid JSON monitor action.");
      }
      const action = typeof payload?.action === "string" ? payload.action : "";
      if (!(MONITOR_TOOLS as readonly string[]).includes(action)) {
        return jsonError(400, "unsupported_monitor_action", "Choose a supported monitor action.");
      }
      const monitorAccess = await requireMonitorAccess(env.API_KEYS, accessRequest, action);
      if (monitorAccess instanceof Response) return monitorAccess;
      const monitorArguments = payload?.arguments && typeof payload.arguments === "object" ? payload.arguments : {};
      if (monitorAccess.accessTier === "free_monitor" && action === "create_monitor" && monitorArguments.schedule === "hourly") {
        return jsonError(403, "hourly_schedule_requires_upgrade", "Free monitors run daily or weekly. Upgrade for hourly checks.", {
          allowedSchedules: ["manual", "daily", "weekly"],
          upgradeUrl: `${PUBLIC_APP_ORIGIN}/pricing`,
        });
      }
      await incrementUsage(env.API_KEYS, monitorAccess.usageKey, monitorAccess.usageSubjectType, monitorAccess.subjectId, monitorAccess.month, action);
      await queueUsageEvent("tool_call_started", action, monitorAccess.accessTier, monitorAccess.accessTier === "team" ? "subscription" : null, "started", null, { mcpClientId: "watch-dashboard" });
      const monitorLimit = monitorAccess.accessTier === "free_monitor"
        ? FREE_MONITOR_LIMIT
        : monitorAccess.apiKeyRecord.activeMonitorLimit ?? PAID_ACTIVE_MONITOR_LIMIT;
      const accountId = env.MCP_OBJECT.idFromName(`account:${monitorAccess.subjectId}`);
      const accountResponse = await env.MCP_OBJECT.get(accountId).fetch(new Request("https://internal/monitor-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, arguments: monitorArguments, ownerKeyHash: monitorAccess.subjectId, activeMonitorLimit: monitorLimit }),
      }));
      const result = await accountResponse.json().catch(() => ({ error: "monitor_action_failed", message: "The monitor response could not be read." })) as Record<string, unknown>;
      const succeeded = accountResponse.ok && !result.error;
      await queueUsageEvent(succeeded ? "tool_call_completed" : "tool_call_failed", action, monitorAccess.accessTier, monitorAccess.accessTier === "team" ? "subscription" : null, succeeded ? "success" : "failed", accountResponse.status, { mcpClientId: "watch-dashboard" });
      if (succeeded && action === "create_monitor") {
        await queueUsageEvent("persistent_monitor_created", action, monitorAccess.accessTier, monitorAccess.accessTier === "team" ? "subscription" : null, "success", accountResponse.status, { mcpClientId: "watch-dashboard" });
      }
      if (succeeded && action === "run_monitor_now") {
        const activationKey = `plg:first-monitor-run:${monitorAccess.subjectId}`;
        if (!await env.API_KEYS.get(activationKey)) {
          await env.API_KEYS.put(activationKey, new Date().toISOString());
          await queueUsageEvent("persistent_monitor_first_run", action, monitorAccess.accessTier, monitorAccess.accessTier === "team" ? "subscription" : null, "success", accountResponse.status, { mcpClientId: "watch-dashboard" });
        }
      }
      if (succeeded && action === "create_share_link" && typeof result.report_id === "string") {
        await env.API_KEYS.put(`share-owner:${result.report_id}`, monitorAccess.subjectId, { expirationTtl: SHARED_REPORT_MAX_TTL_DAYS * 24 * 60 * 60 });
      }
      return jsonResponse(result, { status: accountResponse.status, headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/try" && request.method === "GET") {
      return Response.redirect(`${url.origin}/watch`, 302);
    }

    // Maintenance: shrink the analytics Durable Object by pruning old rows.
    // Disabled (404) unless ADMIN_TOKEN is set; requires a matching bearer token.
    // Used to recover from an over-cap DO storage outage and for ad-hoc cleanup;
    // routine pruning also runs automatically in the hourly cron.
    if (url.pathname === "/admin/prune" && request.method === "POST") {
      const token = env.ADMIN_TOKEN;
      if (!token) return jsonError(404, "not_found", "Not found.");
      if (request.headers.get("Authorization") !== `Bearer ${token}`) {
        return jsonError(401, "unauthorized", "A valid admin bearer token is required.");
      }
      const days = parseInt(url.searchParams.get("days") ?? "45", 10) || 45;
      const id = env.MCP_OBJECT.idFromName("ground-truth");
      const stub = env.MCP_OBJECT.get(id);
      const res = await stub.fetch(new Request("https://internal/prune-analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: days }),
      }));
      return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
    }

    // Self-health check for the MCP transport. Dogfoods the product: an external
    // uptime monitor (or a Ground Truth monitor on this very URL) watching this
    // endpoint catches an opaque transport failure — the class of outage that
    // silently zeroed activation — the moment it starts, instead of weeks later.
    if (url.pathname === "/health/mcp" && (request.method === "GET" || request.method === "HEAD")) {
      const startedAt = Date.now();
      const probe = new Request("https://internal/mcp", {
        method: "POST",
        headers: {
          "Accept": "application/json, text/event-stream",
          "Content-Type": "application/json",
          // Keep self-checks out of product analytics.
          "X-Ground-Truth-Test": "true",
          "mcp-client-id": "health-check",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "ground-truth-health-check", version: SERVER_VERSION },
          },
        }),
      });
      let httpStatus = 0;
      let bodySample = "";
      let ok = false;
      try {
        const probeResponse = await serveMcpGuarded(probe, env, ctx, 0);
        httpStatus = probeResponse.status;
        bodySample = (await probeResponse.text()).slice(0, 600);
        ok = httpStatus === 200 && bodySample.includes("serverInfo");
      } catch (error) {
        bodySample = error instanceof Error ? error.message : String(error);
      }
      return new Response(
        JSON.stringify({
          ok,
          verdict: ok ? "PASS" : "FAIL",
          check: "mcp_initialize",
          httpStatus,
          responseTimeMs: Date.now() - startedAt,
          serverVersion: SERVER_VERSION,
          checkedAt: new Date().toISOString(),
          detail: ok ? "MCP initialize handshake succeeded." : bodySample,
        }),
        {
          status: ok ? 200 : 503,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        },
      );
    }

    if (url.pathname === "/watch" && request.method === "GET") {
      queueTrafficLog("watch_dashboard_view", { tier: "free_monitor", status: "success" });
      return new Response(getWatchDashboardHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/legacy-monitor-lab" && request.method === "GET") {
      queueTrafficLog("monitor_lab_view");
      return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Monitor Lab — Ground Truth</title>
  <meta name="description" content="Capture a free live baseline for a pricing page, endpoint, package, or vendor claim. No signup or API key.">
  <style>
    *{box-sizing:border-box}body{margin:0;background:#090b10;color:#eef1f7;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;min-height:100vh}body:before{content:"";position:fixed;inset:0;background:radial-gradient(circle at 20% 0,#3246b933,transparent 34%),radial-gradient(circle at 90% 20%,#c75b3030,transparent 30%);pointer-events:none}.shell{position:relative;max-width:980px;margin:0 auto;padding:28px 22px 72px}nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:72px}.brand{font-weight:800;color:#fff;text-decoration:none}.nav-link{color:#b8c1d9;text-decoration:none}.hero{max-width:780px;margin-bottom:42px}.kicker{color:#95a6ff;font-size:.8rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero h1{font-size:clamp(2.5rem,7vw,5rem);line-height:.98;letter-spacing:-.055em;margin:16px 0 20px}.hero p{font-size:1.15rem;line-height:1.7;color:#aeb7c9;max-width:680px}.grid{display:grid;grid-template-columns:1.05fr .95fr;gap:22px}.panel{background:#11151ed9;border:1px solid #262d3c;border-radius:22px;padding:28px;box-shadow:0 24px 80px #0008}.panel h2{font-size:1.15rem;margin:0 0 20px}.field{margin-bottom:17px}label{display:block;font-size:.82rem;font-weight:700;color:#cbd3e5;margin-bottom:8px}input,select{width:100%;border:1px solid #30394b;background:#0b0e14;color:#fff;border-radius:11px;padding:13px 14px;font:inherit}input:focus,select:focus{outline:2px solid #7185ff;border-color:transparent}.hint{font-size:.78rem;color:#778298;margin-top:7px}.button{width:100%;border:0;border-radius:11px;padding:14px 18px;background:#f4f0e7;color:#11151e;font-weight:800;font-size:.95rem;cursor:pointer}.button:disabled{opacity:.55;cursor:wait}.steps{display:grid;gap:18px}.step{display:grid;grid-template-columns:32px 1fr;gap:13px}.num{width:30px;height:30px;border-radius:9px;background:#222a3b;color:#aebcff;display:grid;place-items:center;font-size:.8rem;font-weight:800}.step strong{display:block;margin-bottom:4px}.step p{margin:0;color:#8f9ab0;font-size:.9rem;line-height:1.5}.result{display:none;margin-top:22px;background:#0d1119;border:1px solid #2b3548;border-radius:18px;padding:24px}.result.ready{display:block}.status{display:inline-flex;padding:6px 10px;border-radius:999px;background:#173d2c;color:#7ee2a8;font-size:.75rem;font-weight:800;text-transform:uppercase}.status.error{background:#482420;color:#ff9b8b}.result h2{margin:16px 0 8px}.result p{color:#aeb7c9;line-height:1.6}.baseline{white-space:pre-wrap;overflow-wrap:anywhere;background:#080b10;border-radius:12px;padding:16px;color:#d8dfef;font:13px/1.55 ui-monospace,SFMono-Regular,monospace}.actions{display:flex;gap:12px;margin-top:18px}.actions a{display:inline-block;padding:11px 15px;border-radius:9px;text-decoration:none;font-weight:750}.primary{background:#7185ff;color:#080b10}.secondary{border:1px solid #34405a;color:#ced7ea}@media(max-width:760px){nav{margin-bottom:48px}.grid{grid-template-columns:1fr}.hero h1{font-size:3rem}.actions{flex-direction:column}}
  </style>
</head>
<body><main class="shell"><nav><a class="brand" href="/">Ground Truth</a><a class="nav-link" href="/pricing">Pricing</a></nav>
  <section class="hero"><div class="kicker">Free · No signup · Live evidence</div><h1>See what your agent should keep fresh.</h1><p>Capture a live baseline for a pricing page, API, package, or vendor claim. Ground Truth shows exactly what a persistent monitor would watch before you pay.</p></section>
  <section class="grid"><form class="panel" id="preview-form"><h2>Create a free baseline</h2>
    <div class="field"><label for="type">What should stay fresh?</label><select id="type" name="target_type"><option value="pricing_page">Pricing or packaging page</option><option value="endpoint">API or endpoint</option><option value="package">npm or PyPI package</option><option value="vendor_claim">Vendor claim</option><option value="custom_prompt">Keywords on a page</option></select></div>
    <div class="field"><label for="target">Source or target</label><input id="target" name="target_value" value="https://stripe.com/pricing" required><div class="hint" id="target-hint">Use the exact public pricing URL.</div></div>
    <div class="field" id="instructions-field" hidden><label for="instructions">Evidence URL or keywords</label><input id="instructions" name="instructions"><div class="hint" id="instructions-hint"></div></div>
    <button class="button" id="submit" type="submit">Capture live baseline</button>
  </form>
  <aside class="panel"><h2>How the loop works</h2><div class="steps"><div class="step"><div class="num">1</div><div><strong>Prove value first</strong><p>Ground Truth reads the source and captures the fields worth watching.</p></div></div><div class="step"><div class="num">2</div><div><strong>Let the agent decide</strong><p>The result includes a recommended schedule and the exact next tool to call.</p></div></div><div class="step"><div class="num">3</div><div><strong>Automate only when useful</strong><p>Persistent monitors add scheduled checks, evidence history, alerts, and shareable reports.</p></div></div></div></aside></section>
  <section class="result" id="result"><span class="status" id="status"></span><h2 id="result-title"></h2><p id="result-copy"></p><pre class="baseline" id="baseline"></pre><div class="actions"><a class="primary" href="/pricing">Keep this source fresh</a><a class="secondary" href="/">Use with an agent</a></div></section>
</main><script>
const form=document.getElementById("preview-form"),type=document.getElementById("type"),target=document.getElementById("target"),instructionsField=document.getElementById("instructions-field"),instructions=document.getElementById("instructions"),targetHint=document.getElementById("target-hint"),instructionsHint=document.getElementById("instructions-hint"),submit=document.getElementById("submit"),result=document.getElementById("result"),status=document.getElementById("status"),title=document.getElementById("result-title"),copy=document.getElementById("result-copy"),baseline=document.getElementById("baseline");
const examples={pricing_page:["https://stripe.com/pricing","Use the exact public pricing URL."],endpoint:["https://example.com","Use a public API or website URL."],package:["npm:zod","Use npm:package-name or pypi:package-name."],vendor_claim:["Enterprise plan includes SSO","Enter the claim here and its evidence URL below."],custom_prompt:["https://example.com","Enter the page here and comma-separated keywords below."]};
type.onchange=function(){const current=examples[type.value];target.value=current[0];targetHint.textContent=current[1];instructionsField.hidden=!(type.value==="vendor_claim"||type.value==="custom_prompt");instructions.placeholder=type.value==="vendor_claim"?"https://vendor.example.com/security":"sso, scim, audit log";instructionsHint.textContent=type.value==="vendor_claim"?"The public page that should support the claim.":"Comma-separated terms to watch."};
form.onsubmit=async function(event){event.preventDefault();submit.disabled=true;submit.textContent="Reading live source…";result.className="result";try{const payload={target_type:type.value,target_value:target.value.trim()};if(!instructionsField.hidden&&instructions.value.trim())payload.instructions=instructions.value.trim();const response=await fetch("/api/preview-monitor",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const data=await response.json();result.className="result ready";status.textContent=data.status||"error";status.className=data.status==="baseline_ready"?"status":"status error";title.textContent=data.status==="baseline_ready"?"Baseline captured":"Preview needs attention";copy.textContent=data.status==="baseline_ready"?"Recommended cadence: "+data.recommended_schedule+". This preview is not stored; activate monitoring only if ongoing freshness matters.":(data.message||data.error||"The source could not be previewed.");baseline.textContent=JSON.stringify(data.baseline!==undefined?data.baseline:data,null,2);result.scrollIntoView({behavior:"smooth",block:"start"})}catch(error){result.className="result ready";status.textContent="error";status.className="status error";title.textContent="Preview unavailable";copy.textContent=error.message;baseline.textContent=""}finally{submit.disabled=false;submit.textContent="Capture live baseline"}};
</script></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    }

    // ───────────────────────────────────────────────
    // Pricing page
    // ───────────────────────────────────────────────
    if (url.pathname === "/pricing") {
      const referralCode = normalizeReferralCode(url.searchParams.get("ref"));
      queueTrafficLog("pricing_view", { eventKey: referralCode });
      if (referralCode) queueTrafficLog("referral_landing", { eventKey: referralCode, status: "success" });
      const refParam = referralCode ? `&ref=${encodeURIComponent(referralCode)}` : "";
      const pricingCards = PAID_PLAN_ORDER.map((planId: PaidPlanId) => {
        const p = PAID_PLANS[planId];
        const popularBadge = p.highlight
          ? `<div class="badge">Most Popular</div>`
          : "";
        const cardClass = p.highlight ? "plan plan-highlight" : "plan";
        const btnClass = p.highlight ? "btn btn-primary" : "btn btn-outline";
        const sharedList = PAID_PLAN_SHARED_FEATURES.map(f => `<li>${f}</li>`).join("\n          ");
        const annualConfigured = Boolean(env[p.stripePriceEnvKeyAnnual]);
        const annualBlock = annualConfigured
          ? `
        <form action="/api/checkout?plan=${p.id}&interval=annual${refParam}" method="POST">
          <button type="submit" class="btn btn-ghost">Get annual — $${annualPriceUsd(p).toLocaleString()}/yr <span class="save">save 2 months</span></button>
        </form>`
          : "";
        return `
      <div class="${cardClass}">
        ${popularBadge}
        <h2>${p.name}</h2>
        <div class="price">$${p.priceUsd}<span>/mo</span></div>
        <p class="desc">${p.blurb}</p>
        <ul>
          <li><strong>${p.activeMonitorLimit} active monitors</strong></li>
          <li><strong>${p.monthlyQuota.toLocaleString()} evidence runs/mo</strong></li>
          ${sharedList}
          <li>X-API-Key delivered at checkout</li>
        </ul>
        <form action="/api/checkout?plan=${p.id}${refParam}" method="POST">
          <button type="submit" class="${btnClass}">Get ${p.name} monthly</button>
        </form>${annualBlock}
      </div>`;
      }).join("\n");
      return new Response(
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ground Truth - Pricing</title>
  <meta name="description" content="Start with three persistent competitor monitors free. Upgrade self-serve for hourly checks, more sources, and higher evidence-run limits.">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background:
        radial-gradient(circle at top, rgba(124, 138, 255, 0.12), transparent 35%),
        #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      padding: 60px 24px;
    }
    a { color: #7c8aff; text-decoration: none; }
    a:hover { text-decoration: underline; }

    .page { max-width: 1160px; margin: 0 auto; }
    .eyebrow {
      display: inline-block;
      margin: 0 auto 16px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid #2b2b3a;
      background: rgba(20, 20, 20, 0.85);
      color: #a9b3ff;
      font-size: 0.8rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .hero { text-align: center; margin-bottom: 48px; }
    .page h1 { font-size: 2.4rem; color: #fff; margin-bottom: 12px; }
    .page .sub {
      max-width: 680px;
      margin: 0 auto;
      color: #9898a6;
      font-size: 1.05rem;
      line-height: 1.7;
    }

    /* Free + 3 paid tiers side by side */
    .plans {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 20px;
      margin-bottom: 48px;
      align-items: start;
    }

    .plan {
      background: rgba(20, 20, 20, 0.92);
      border: 1px solid #242432;
      border-radius: 18px;
      padding: 28px 22px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.24);
      position: relative;
    }
    .plan-highlight {
      border-color: #7c8aff;
      padding-top: 42px;
    }
    .badge {
      position: absolute;
      top: -13px;
      left: 50%;
      transform: translateX(-50%);
      background: #7c8aff;
      color: #0a0a0a;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 4px 12px;
      border-radius: 999px;
      white-space: nowrap;
    }

    .plan h2 { font-size: 1.15rem; color: #fff; margin-bottom: 4px; }
    .plan .price { font-size: 2.2rem; font-weight: 700; color: #fff; margin: 14px 0; }
    .plan .price span { font-size: 0.95rem; font-weight: 400; color: #73738a; }
    .plan .desc { color: #9c9cb2; font-size: 0.9rem; margin-bottom: 18px; line-height: 1.55; }

    .plan ul { list-style: none; margin-bottom: 22px; }
    .plan ul li {
      padding: 7px 0 7px 22px;
      position: relative;
      color: #ccc;
      font-size: 0.88rem;
      line-height: 1.45;
    }
    .plan ul li:before {
      content: "\\2713";
      position: absolute;
      left: 0;
      color: #4ade80;
      font-weight: 700;
    }

    .btn {
      display: inline-block;
      padding: 13px 24px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.95rem;
      transition: transform 0.15s, box-shadow 0.15s;
      border: none;
      cursor: pointer;
      text-align: center;
      width: 100%;
    }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(124,138,255,0.25); text-decoration: none; }
    .btn-primary { background: #7c8aff; color: #0a0a0a; }
    .btn-outline { background: transparent; color: #7c8aff; border: 1px solid #333; }
    .btn-ghost { background: transparent; color: #9898a6; border: 1px solid #2b2b3a; margin-top: 10px; font-size: 0.85rem; padding: 10px 18px; }
    .btn-ghost:hover { color: #e0e0e0; box-shadow: none; }
    .btn-ghost .save { color: #6ee7a8; font-weight: 700; }

    .note {
      margin-bottom: 48px;
      padding: 20px 22px;
      border-radius: 16px;
      border: 1px solid #242432;
      background: rgba(17, 17, 23, 0.92);
      color: #a8a8bb;
      line-height: 1.6;
    }
    .note strong { color: #fff; }

    .faq { margin-bottom: 48px; }
    .faq h2 { font-size: 1.4rem; color: #fff; margin-bottom: 20px; }
    .faq-item { border-bottom: 1px solid #222; padding: 16px 0; }
    .faq-item dt { color: #fff; font-weight: 600; margin-bottom: 6px; }
    .faq-item dd { color: #8f8fa3; font-size: 0.95rem; line-height: 1.6; }

    .footer {
      text-align: center;
      padding-top: 32px;
      border-top: 1px solid #222;
      color: #666;
      font-size: 0.9rem;
    }

    @media (max-width: 900px) {
      .plans { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 560px) {
      .plans { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="hero">
      <div class="eyebrow">Start free · Upgrade in place</div>
      <h1>Three live monitors before you pay.</h1>
      <p class="sub">Track competitor pricing, packaging, APIs, or claims without a card or sales call. Upgrade the same workspace when your team needs hourly checks and more sources.</p>
    </div>

    <div class="plans">
      <!-- Free tier -->
      <div class="plan">
        <h2>Free</h2>
        <div class="price">$0</div>
        <p class="desc">A real competitive watchlist, not a temporary demo.</p>
        <ul>
          <li><strong>${FREE_MONITOR_LIMIT} persistent monitors</strong></li>
          <li>Daily or weekly scheduled checks</li>
          <li>Evidence history and change reports</li>
          <li>Webhook change alerts and share links</li>
          <li>${FREE_MONITOR_MONTHLY_QUOTA} monitor actions / month</li>
          <li><strong>check_endpoint</strong></li>
          <li><strong>inspect_security_headers</strong></li>
          <li><strong>preflight_endpoint</strong></li>
          <li><strong>list_resources</strong> (no quota)</li>
          <li><strong>verify_claim</strong> (5 calls/mo)</li>
          <li>No card or signup form</li>
        </ul>
        <a href="/watch" class="btn btn-outline">Start Free</a>
      </div>
${pricingCards}
    </div>

    <div class="note">
      <strong>Product-led path:</strong> Create three free persistent monitors in the <a href="/watch">watch dashboard</a>, see the first evidence immediately, and upgrade that same workspace only when usage demands it. x402 remains available for autonomous one-off paid research.
    </div>

    <div class="faq">
      <h2>Questions</h2>
      <dl>
        <div class="faq-item">
          <dt>What is Ground Truth?</dt>
          <dd>Ground Truth preflights unfamiliar APIs, URLs, and claims before an agent trusts or acts on them. It returns observable evidence and a PASS, WARN, or FAIL decision signal.</dd>
        </div>
        <div class="faq-item">
          <dt>What is MCP?</dt>
          <dd>Model Context Protocol is the standard that lets AI apps call external tools. Ground Truth plugs into Claude Desktop, Cursor, and other MCP clients so your agent can verify before it acts.</dd>
        </div>
        <div class="faq-item">
          <dt>Do I need an API key or account?</dt>
          <dd>No signup form is required. The watch dashboard creates a private recovery key in your browser so your three monitors persist. Copy that key if you want to restore the workspace on another device or use the same monitors from an MCP client.</dd>
        </div>
        <div class="faq-item">
          <dt>How do the plans differ?</dt>
          <dd>All paid plans unlock the same tool set. The tiers differ only in active-monitor count (${PAID_PLANS.good.activeMonitorLimit} / ${PAID_PLANS.better.activeMonitorLimit} / ${PAID_PLANS.best.activeMonitorLimit}) and monthly evidence-run quota (${PAID_PLANS.good.monthlyQuota.toLocaleString()} / ${PAID_PLANS.better.monthlyQuota.toLocaleString()} / ${PAID_PLANS.best.monthlyQuota.toLocaleString()}). Pick the plan that matches the number of sources you need to watch.</dd>
        </div>
        <div class="faq-item">
          <dt>What happens if I cancel?</dt>
          <dd>Your workspace returns to the free monitor limits after billing becomes inactive. Your recovery key and monitor data remain associated with the same workspace.</dd>
        </div>
      </dl>
    </div>

    <div class="footer">
      <p>Questions? <a href="mailto:anishdasmail@gmail.com">anishdasmail@gmail.com</a></p>
      <p style="margin-top: 8px;"><a href="/">&larr; Home</a></p>
    </div>
  </div>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // ───────────────────────────────────────────────
    // Stripe checkout session
    // ───────────────────────────────────────────────
    if (url.pathname === "/api/checkout" && request.method === "POST") {
      const checkoutRequestId = crypto.randomUUID();
      const referralCode = normalizeReferralCode(url.searchParams.get("ref"));
      const plan = PAID_PLANS[resolvePaidPlanId(url.searchParams.get("plan"))];
      const interval = resolveBillingInterval(url.searchParams.get("interval"));
      queueTrafficLog("checkout_started", { eventKey: checkoutRequestId, tier: plan.id, status: "started", paymentMethod: interval });
      if (referralCode) queueTrafficLog("referral_checkout_started", { eventKey: referralCode, status: "started" });
      try {
        const stripe = env.STRIPE_SECRET_KEY;
        const stripePriceId = interval === "annual"
          ? env[plan.stripePriceEnvKeyAnnual]
          : env[plan.stripePriceEnvKey];
        if (!stripe || !stripePriceId) {
          queueTrafficLog("checkout_failed", { eventKey: checkoutRequestId, status: "failed" });
          return jsonError(
            503,
            "checkout_unavailable",
            interval === "annual"
              ? "Annual checkout for this plan is not configured on this deployment yet. Please choose monthly or try again later."
              : "Checkout for this plan is temporarily unavailable. Please try again later.",
          );
        }
        const quota = plan.monthlyQuota;
        const watchKey = request.headers.get("X-Ground-Truth-Key")?.trim() || request.headers.get("X-API-Key")?.trim();
        let upgradeToken: string | null = null;
        if (watchKey) {
          const watchRecord = await getApiKeyRecord(env.API_KEYS, watchKey);
          if (!watchRecord || !hasFreeMonitorFallback(watchRecord)) {
            return jsonError(401, "invalid_watch_key", "The free watch key could not be upgraded.");
          }
          upgradeToken = randomHex(24);
          await env.API_KEYS.put(`upgrade:${upgradeToken}`, watchKey, { expirationTtl: 3600 });
        }

        // Create Stripe checkout session
        const checkoutResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${stripe}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            "payment_method_types[0]": "card",
            "line_items[0][price]": stripePriceId,
            "line_items[0][quantity]": "1",
            "mode": "subscription",
            "success_url": `${url.origin}/api/success?session_id={CHECKOUT_SESSION_ID}&plan=${plan.id}`,
            "cancel_url": `${url.origin}/pricing`,
            "metadata[plan]": plan.id,
            "metadata[interval]": interval,
            "metadata[quota]": String(quota),
            "metadata[monitor_limit]": String(plan.activeMonitorLimit),
            "metadata[checkout_request_id]": checkoutRequestId,
            ...(referralCode ? { "metadata[referral_code]": referralCode } : {}),
            ...(upgradeToken ? { "metadata[upgrade_token]": upgradeToken } : {}),
          }),
        });

        const session = await checkoutResponse.json() as { id?: string; url?: string; error?: { message?: string } };
        if (!checkoutResponse.ok || !session.url) {
          queueTrafficLog("checkout_failed", { eventKey: checkoutRequestId, status: "failed" });
          return new Response(
            JSON.stringify({ error: "Failed to create checkout session", details: session.error?.message || "Stripe did not return a checkout URL" }),
            { status: 502, headers: { "Content-Type": "application/json" } },
          );
        }
        queueTrafficLog("checkout_created", { eventKey: session.id ?? checkoutRequestId, status: "success" });
        if (request.headers.get("Accept")?.includes("application/json")) {
          return jsonResponse({ checkoutUrl: session.url, plan: plan.id });
        }
        return Response.redirect(session.url, 303);
      } catch (e) {
        queueTrafficLog("checkout_failed", { eventKey: checkoutRequestId, status: "failed" });
        return new Response(
          JSON.stringify({ error: "Failed to create checkout session", details: e instanceof Error ? e.message : String(e) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // ───────────────────────────────────────────────
    // Success page (display API key)
    // ───────────────────────────────────────────────
    if (url.pathname === "/api/success") {
      queueTrafficLog("success_page_view");
      const sessionId = url.searchParams.get("session_id");
      if (!sessionId) {
        return new Response("Missing session_id", { status: 400 });
      }

      try {
        // Retrieve session from Stripe
        const sessionResponse = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
          headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        const session = await sessionResponse.json() as StripeCheckoutSessionRecord & { error?: { message?: string } };
        if (!sessionResponse.ok) {
          return new Response(JSON.stringify({ error: "Unable to verify checkout session", details: session.error?.message || "Stripe request failed" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (session.status !== "complete" || session.payment_status !== "paid") {
          return new Response("Payment is not complete yet. Please return after Stripe confirms the subscription.", { status: 402 });
        }

        const provisioned = await provisionApiKeyForStripeSession(env.API_KEYS, session);
        if (!provisioned) {
          return new Response("Stripe session is missing a customer or subscription.", { status: 502 });
        }
        const { apiKey, quota, activeMonitorLimit: purchasedMonitorLimit, planName } = provisioned;
        const referralCode = normalizeReferralCode(session.metadata?.referral_code);
        await creditReferralReward(referralCode, apiKey);
        const eventKey = session.metadata?.checkout_request_id || session.id || session.subscription || null;
        queueTrafficLog("checkout_started", { eventKey, status: "started" });
        queueTrafficLog("checkout_completed", { eventKey, status: "success" });
        if (referralCode) queueTrafficLog("referral_checkout_completed", { eventKey: referralCode, status: "success" });
        if (provisioned.newlyActivated) {
          queueTrafficLog("subscription_activated", { eventKey, status: "success" });
        }

        return new Response(
          `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ground Truth Monitor Plan Active</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #333;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container { 
      max-width: 860px;
      width: 100%;
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      padding: 40px;
      text-align: center;
    }
    h1 { color: #667eea; margin-bottom: 12px; font-size: 2rem; }
    .lead { color: #555; line-height: 1.6; max-width: 680px; margin: 0 auto; }
    .success-icon { font-size: 4rem; margin-bottom: 20px; }
    .api-key-box {
      background: #f5f7fa;
      border: 2px solid #667eea;
      border-radius: 8px;
      padding: 20px;
      margin: 30px 0;
      font-family: 'Courier New', monospace;
      font-size: 1.1rem;
      word-break: break-all;
      color: #764ba2;
      position: relative;
    }
    .copy-btn {
      margin-top: 15px;
      background: #667eea;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 1rem;
    }
    .copy-btn:hover { background: #5568d3; }
    .instructions {
      text-align: left;
      margin-top: 30px;
      padding: 20px;
      background: #f0f4f8;
      border-radius: 8px;
    }
    .instructions h3 { color: #667eea; margin-bottom: 15px; }
    .instructions code {
      background: #fff;
      padding: 2px 6px;
      border-radius: 3px;
      color: #764ba2;
    }
    .instructions pre {
      background: #fff;
      padding: 15px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 10px 0;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .next-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin-top: 24px;
      text-align: left;
    }
    .next-card {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 16px;
    }
    .next-card strong { display: block; color: #334155; margin-bottom: 8px; }
    .next-card p { color: #64748b; line-height: 1.55; font-size: 0.94rem; }
    @media (max-width: 760px) {
      .next-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="success-icon">🎉</div>
    <h1>${planName} Plan Active</h1>
    <p class="lead">Use this key immediately to create your first persistent monitor, run it once, and generate evidence your agent can reuse.</p>
    
    <div class="api-key-box" id="apiKeyBox">
      ${apiKey}
    </div>
    <button class="copy-btn" onclick="copyApiKey()">📋 Copy API Key</button>

    <div class="next-grid">
      <div class="next-card">
        <strong>1. Add the key to your MCP client</strong>
        <p>Free tools keep working without a key. Persistent monitors and paid checks require <code>X-API-Key</code>.</p>
      </div>
      <div class="next-card">
        <strong>2. Create one monitor now</strong>
        <p>Start with the source that triggered checkout. Pricing pages, docs, endpoints, packages, and claims are all valid targets.</p>
      </div>
      <div class="next-card">
        <strong>3. Run it once</strong>
        <p><code>run_monitor_now</code> creates the first stored evidence record and proves the key is wired correctly.</p>
      </div>
      <div class="next-card">
        <strong>4. Share or report changes</strong>
        <p>Use <code>generate_change_report</code> or <code>create_share_link</code> after a monitor has evidence history.</p>
      </div>
    </div>
    
    <div class="instructions">
      <h3>Use your API key</h3>
      <p>Direct MCP over HTTP is session-based. Initialize once, then send your API key on paid and monitor tool calls:</p>
      <pre>X-API-Key: ${apiKey}</pre>
      <p style="margin-top: 15px;">Monthly quota: ${quota.toLocaleString()} evidence runs (${planName} plan). Includes ${purchasedMonitorLimit} active monitors, saved evidence history, change reports, and shareable reports.</p>
      <p style="margin-top: 15px; font-weight: bold;">Best next step: create a monitor for the exact URL, package, or claim you just cared about, then run it once.</p>
      
      <p style="margin-top: 15px;">Create your first monitor:</p>
      <pre>SESSION_ID="$(curl -i -s -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ground-truth-success","version":"1.0.0"}},"id":0}' | tr -d '\\r' | awk '/^mcp-session-id:/ {print $2}')"

curl -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Mcp-Session-Id: $SESSION_ID" \\
  -H "X-API-Key: ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"create_monitor","arguments":{"name":"Example pricing watch","target_type":"pricing_page","target_value":"https://example.com/pricing","schedule":"daily"}},"id":1}'</pre>

      <p style="margin-top: 15px;">Then run the monitor once by replacing <code>mon_...</code> with the returned monitor ID:</p>
      <pre>curl -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Mcp-Session-Id: $SESSION_ID" \\
  -H "X-API-Key: ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"run_monitor_now","arguments":{"monitor_id":"mon_..."}},"id":2}'</pre>

      <p style="margin-top: 15px;">If checkout came from a paid-gated tool, retry that same tool with this header:</p>
      <pre>X-API-Key: ${apiKey}</pre>
      
      <p style="margin-top: 20px; color: #e63946; font-weight: bold;">⚠️ Keep this key secret! Don't share it publicly.</p>
    </div>
    
    <p style="margin-top: 30px; color: #999;">
      Questions? Email <a href="mailto:anishdasmail@gmail.com" style="color: #667eea;">anishdasmail@gmail.com</a>
    </p>
  </div>
  
  <script>
    function copyApiKey() {
      const apiKey = document.getElementById('apiKeyBox').textContent.trim();
      navigator.clipboard.writeText(apiKey).then(() => {
        const btn = document.querySelector('.copy-btn');
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = '📋 Copy API Key'; }, 2000);
      });
    }
  </script>
</body>
</html>`,
          { headers: { "Content-Type": "text/html" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "Failed to retrieve session", details: e instanceof Error ? e.message : String(e) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // ───────────────────────────────────────────────
    // Stripe webhook handler
    // ───────────────────────────────────────────────
    if (url.pathname === "/api/webhook" && request.method === "POST") {
      queueTrafficLog("stripe_webhook");
      const signature = request.headers.get("stripe-signature");
      if (!signature) {
        return new Response("Missing signature", { status: 400 });
      }

      try {
        const body = await request.text();
        const signatureValid = await verifyStripeWebhookSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
        if (!signatureValid) {
          return new Response("Invalid signature", { status: 400 });
        }

        const event = JSON.parse(body) as {
          type: string;
          data: {
            object: Record<string, unknown>;
          };
        };

        if (event.type === "checkout.session.completed") {
          const session = event.data.object as StripeCheckoutSessionRecord;
          const provisioned = await provisionApiKeyForStripeSession(env.API_KEYS, session);
          if (provisioned) {
            const referralCode = normalizeReferralCode(session.metadata?.referral_code);
            await creditReferralReward(referralCode, provisioned.apiKey);
            const eventKey = session.metadata?.checkout_request_id || session.id || session.subscription || null;
            // Backfill the start event if Stripe reports a completed session that
            // originated outside this Worker or arrived after a logging race.
            queueTrafficLog("checkout_started", { eventKey, status: "started" });
            queueTrafficLog("checkout_completed", { eventKey, status: "success" });
            if (referralCode) queueTrafficLog("referral_checkout_completed", { eventKey: referralCode, status: "success" });
            if (provisioned.newlyActivated) {
              queueTrafficLog("subscription_activated", { eventKey, status: "success" });
            }
          }
        } else if (
          event.type === "customer.subscription.updated" ||
          event.type === "customer.subscription.deleted"
        ) {
          const customerId = typeof event.data.object.customer === "string"
            ? event.data.object.customer
            : null;
          const subscriptionId = typeof event.data.object.id === "string"
            ? event.data.object.id
            : undefined;
          const subscriptionStatus = typeof event.data.object.status === "string"
            ? event.data.object.status
            : event.type === "customer.subscription.deleted"
              ? "canceled"
              : undefined;

          if (customerId) {
            const billingActive = isStripeSubscriptionActive(subscriptionStatus);
            await updateCustomerBillingState(env.API_KEYS, customerId, {
              active: billingActive,
              billingActive,
              subscriptionStatus,
              subscriptionId,
              cancelledAt: billingActive ? undefined : new Date().toISOString(),
              reactivatedAt: billingActive ? new Date().toISOString() : undefined,
            });
            queueTrafficLog(billingActive ? "subscription_updated" : "subscription_cancelled");
          }
        }

        return new Response(JSON.stringify({ received: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "Webhook processing failed", details: e instanceof Error ? e.message : String(e) }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // ───────────────────────────────────────────────
    // Browser playground: run a real tool from the landing page
    // with no install, no MCP client, and no API key. Lets a cold
    // visitor reach a successful tool result before deciding to
    // connect the MCP server. Includes a free taste of the paid
    // check_pricing tool. IP rate-limited; does not touch billing.
    // ───────────────────────────────────────────────
    if (url.pathname === "/api/try" && request.method === "POST") {
      queueTrafficLog("browser_try");
      const PLAYGROUND_DAILY_LIMIT = 25;
      try {
        const payload = (await request.json().catch(() => null)) as
          | { tool?: unknown; url?: unknown }
          | null;
        const tool = typeof payload?.tool === "string" ? payload.tool : "";
        const rawUrl = typeof payload?.url === "string" ? payload.url : "";

        if (tool !== "check_endpoint" && tool !== "check_pricing") {
          return jsonResponse(
            { error: "invalid_tool", message: "tool must be 'check_endpoint' or 'check_pricing'." },
            { status: 400 },
          );
        }

        queueUsageEvent("tool_call_started", tool, "playground", null, "started", null);

        const normalizedUrl = normalizeHttpUrlInput(rawUrl);
        if (!normalizedUrl) {
          queueUsageEvent("tool_call_failed", tool, "playground", null, "failed", 400);
          return jsonResponse(
            { error: "invalid_url", message: "Provide a public http(s) URL or a bare domain like stripe.com." },
            { status: 400 },
          );
        }

        // Per-IP daily rate limit so the free playground cannot be abused.
        const client = getAnonymousClientSource(request);
        const day = new Date().toISOString().slice(0, 10);
        const clientHash = await sha256Hex(`${client.type}:${client.value}`);
        const limitKey = `playground:${day}:${clientHash}`;
        const used = Number((await env.API_KEYS.get(limitKey)) ?? "0") || 0;
        if (used >= PLAYGROUND_DAILY_LIMIT) {
          queueUsageEvent("tool_call_failed", tool, "playground", null, "failed", 429);
          return jsonResponse(
            {
              error: "playground_limit",
              message:
                "Daily playground limit reached. Connect the MCP server to keep going — the free check_endpoint and inspect_security_headers tools have no per-call cost.",
              limit: PLAYGROUND_DAILY_LIMIT,
            },
            { status: 429 },
          );
        }
        // 48h TTL so the daily key self-expires.
        ctx.waitUntil(env.API_KEYS.put(limitKey, String(used + 1), { expirationTtl: 172800 }));

        if (used === 0) {
          ctx.waitUntil(
            logRemoteUsage(`playground_${tool}`, true, "playground_first_call", {
              client_type: client.type,
            }),
          );
        }

        const start = Date.now();
        if (tool === "check_endpoint") {
          const result = await runEndpointCheck(rawUrl);
          const verdict = getEndpointVerdict(result);
          queueUsageEvent(result.error ? "tool_call_failed" : "tool_call_completed", tool, "playground", null, result.error ? "failed" : "success", result.status ?? (result.error ? 502 : 200));
          return jsonResponse({
            tool: "check_endpoint",
            tier: "free",
            ...result,
            ...verdict,
            evidence: {
              status: result.status,
              contentType: result.contentType,
              responseTimeMs: result.responseTimeMs ?? Date.now() - start,
              redirected: result.redirected,
              finalUrl: result.finalUrl,
              authRequired: result.authRequired,
              rateLimited: result.rateLimited,
              ...(result.error ? { error: result.error } : {}),
            },
          });
        }

        // tool === "check_pricing": a free, in-browser taste of a paid tool.
        try {
          const resp = await fetch(normalizedUrl, { headers: { "User-Agent": "GroundTruth/0.4" } });
          const body = await resp.text();
          const signals = extractPricingSignals(body);
          queueUsageEvent(resp.ok ? "tool_call_completed" : "tool_call_failed", tool, "playground", null, resp.ok ? "success" : "failed", resp.status);
          return jsonResponse({
            tool: "check_pricing",
            tier: "paid-preview",
            note: "Free in-browser preview of a paid tool. Subscribe for team-key access when you need recurring monitors and change history.",
            url: normalizedUrl,
            status: resp.status,
            accessible: resp.ok,
            pricesFound: signals.pricesFound,
            plansDetected: signals.plansDetected,
            hasFreeOption: signals.hasFreeOption,
            hasFreeTrial: signals.hasFreeTrial,
            responseTimeMs: Date.now() - start,
          });
        } catch (e) {
          queueUsageEvent("tool_call_failed", tool, "playground", null, "failed", 502);
          return jsonResponse({
            tool: "check_pricing",
            tier: "paid-preview",
            url: normalizedUrl,
            accessible: false,
            error: e instanceof Error ? e.message : String(e),
            responseTimeMs: Date.now() - start,
          });
        }
      } catch (e) {
        return jsonResponse(
          { error: "playground_failed", message: e instanceof Error ? e.message : String(e) },
          { status: 500 },
        );
      }
    }

    // ───────────────────────────────────────────────
    // Root page
    // ───────────────────────────────────────────────
    if (url.pathname === "/") {
      const referralCode = normalizeReferralCode(url.searchParams.get("ref"));
      queueTrafficLog("homepage_view", { eventKey: referralCode });
      if (referralCode) queueTrafficLog("referral_landing", { eventKey: referralCode, status: "success" });
      return new Response(
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="base:app_id" content="69956c02e0d5d2cf831b5fc8" />
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ground Truth — Competitive Change Evidence</title>
  <meta name="description" content="Track competitor pricing, packaging, product pages, APIs, and public claims. Start with three persistent monitors free—no card or sales call.">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background:
        radial-gradient(circle at top, rgba(124, 138, 255, 0.14), transparent 32%),
        radial-gradient(circle at 20% 20%, rgba(74, 222, 128, 0.08), transparent 20%),
        #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
    }
    a { color: #7c8aff; text-decoration: none; }
    a:hover { text-decoration: underline; }

    .shell {
      max-width: 1040px;
      margin: 0 auto;
      padding: 0 24px 48px;
    }

    .hero {
      max-width: 820px;
      margin: 0 auto;
      padding: 88px 0 64px;
      text-align: center;
    }
    .eyebrow {
      display: inline-block;
      margin-bottom: 18px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid #2b2b3a;
      background: rgba(20, 20, 20, 0.85);
      color: #a9b3ff;
      font-size: 0.8rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .hero h1 {
      font-size: 3.2rem;
      color: #fff;
      margin-bottom: 16px;
      line-height: 1.15;
    }
    .hero .sub {
      font-size: 1.15rem;
      color: #9c9cb2;
      max-width: 700px;
      margin: 0 auto 40px;
      line-height: 1.7;
    }
    .cta-row {
      display: flex;
      gap: 16px;
      justify-content: center;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }
    .btn {
      display: inline-block;
      padding: 14px 32px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 1rem;
      transition: transform 0.15s, box-shadow 0.15s;
      border: none;
      cursor: pointer;
    }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(124,138,255,0.25); text-decoration: none; }
    .btn-primary { background: #7c8aff; color: #0a0a0a; }
    .btn-secondary { background: transparent; color: #7c8aff; border: 1px solid #333; }

    .hero-meta {
      display: flex;
      gap: 10px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .hero-meta span {
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid #242432;
      background: rgba(17, 17, 23, 0.9);
      color: #b4b4c8;
      font-size: 0.85rem;
    }

    section {
      padding: 0 0 64px;
    }
    section h2 {
      font-size: 1.7rem;
      color: #fff;
      margin-bottom: 12px;
    }
    .section-intro {
      color: #8f8fa3;
      max-width: 760px;
      line-height: 1.7;
      margin-bottom: 24px;
    }

    .card-grid {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .card {
      background: rgba(20, 20, 20, 0.92);
      border: 1px solid #242432;
      border-radius: 18px;
      padding: 20px 24px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.2);
    }
    .card h3 { color: #fff; font-size: 1rem; margin-bottom: 8px; }
    .card p { color: #8f8fa3; font-size: 0.95rem; line-height: 1.6; }

    .lab-panel {
      display: grid;
      grid-template-columns: minmax(0, 1.08fr) minmax(280px, 0.92fr);
      gap: 18px;
      align-items: stretch;
      background: rgba(20, 20, 20, 0.92);
      border: 1px solid #2f3550;
      border-radius: 18px;
      padding: 22px;
      box-shadow: 0 16px 44px rgba(0, 0, 0, 0.24);
    }
    .lab-panel h2 { margin-bottom: 8px; }
    .lab-panel p { color: #9a9ab1; line-height: 1.65; }
    .lab-form {
      display: grid;
      gap: 12px;
      background: #0b0d13;
      border: 1px solid #272d3e;
      border-radius: 14px;
      padding: 16px;
    }
    .lab-form label {
      display: grid;
      gap: 7px;
      color: #cfd4e7;
      font-size: 0.82rem;
      font-weight: 700;
    }
    .lab-form input,
    .lab-form select {
      width: 100%;
      border: 1px solid #30384a;
      background: #07090e;
      color: #fff;
      border-radius: 8px;
      padding: 11px 12px;
      font: inherit;
    }
    .lab-form button {
      border: 0;
      border-radius: 8px;
      padding: 12px 14px;
      background: #f4f0e7;
      color: #10131a;
      font-weight: 800;
      cursor: pointer;
    }
    .lab-form button:disabled { opacity: 0.6; cursor: wait; }
    .lab-result {
      display: none;
      margin-top: 14px;
      border: 1px solid #2b3548;
      border-radius: 12px;
      background: #080b10;
      padding: 14px;
      color: #d8dfef;
      font: 12px/1.55 "SF Mono", "Fira Code", monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 260px;
      overflow: auto;
    }
    .lab-result.ready { display: block; }

    .workflow-card .tool-tag,
    .verification-card .tool-tag {
      display: inline-block;
      margin-top: 12px;
      padding: 6px 10px;
      border-radius: 999px;
      background: #17172a;
      color: #a9b3ff;
      font-size: 0.8rem;
      border: 1px solid #2b2b3a;
    }

    .pricing-grid {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .plan {
      background: rgba(20, 20, 20, 0.92);
      border: 1px solid #242432;
      border-radius: 18px;
      padding: 24px;
    }
    .plan.pro { border-color: #7c8aff; }
    .plan .label { color: #a9b3ff; font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .plan h3 { color: #fff; font-size: 1.4rem; margin: 10px 0 8px; }
    .plan .price { color: #fff; font-size: 2.2rem; font-weight: 700; margin-bottom: 12px; }
    .plan .price span { color: #73738a; font-size: 1rem; font-weight: 400; }
    .plan p { color: #9a9ab1; line-height: 1.6; margin-bottom: 16px; }
    .plan ul { list-style: none; display: grid; gap: 10px; }
    .plan li {
      color: #d0d0dc;
      padding-left: 22px;
      position: relative;
      line-height: 1.5;
    }
    .plan li::before {
      content: "\\2713";
      position: absolute;
      left: 0;
      color: #4ade80;
      font-weight: 700;
    }

    .code-grid {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .code-card {
      background: rgba(20, 20, 20, 0.92);
      border: 1px solid #242432;
      border-radius: 18px;
      overflow: hidden;
    }
    .code-card h3 {
      padding: 18px 20px 0;
      color: #fff;
      font-size: 1rem;
    }
    .code-card p {
      padding: 8px 20px 0;
      color: #8f8fa3;
      font-size: 0.92rem;
      line-height: 1.6;
    }

    .code-block {
      background: transparent;
      padding: 18px 20px 20px;
      overflow-x: auto;
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 0.82rem;
      color: #d5d5e0;
      line-height: 1.6;
      white-space: pre;
    }

    .setup-grid {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .setup-card {
      background: rgba(20, 20, 20, 0.92);
      border: 1px solid #242432;
      border-radius: 18px;
      padding: 20px;
    }
    .setup-card h3 { color: #fff; font-size: 1rem; margin-bottom: 10px; }
    .setup-card p { color: #8f8fa3; line-height: 1.6; margin-bottom: 14px; }
    .setup-card pre {
      overflow-x: auto;
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 0.82rem;
      line-height: 1.6;
      color: #d5d5e0;
      white-space: pre;
    }

    .mcp-note {
      margin-bottom: 20px;
      color: #9a9ab1;
      line-height: 1.7;
    }
    .mcp-note strong { color: #fff; }

    .link-row {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      margin-top: 16px;
    }

    .footer {
      padding: 40px 0;
      border-top: 1px solid #222;
      text-align: center;
      color: #666;
      font-size: 0.9rem;
    }

    @media (max-width: 900px) {
      .card-grid,
      .pricing-grid,
      .code-grid,
      .lab-panel,
      .setup-grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 640px) {
      .hero h1 { font-size: 2.3rem; }
      .hero { padding-top: 64px; }
      .shell { padding-left: 18px; padding-right: 18px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="hero">
      <div class="eyebrow">Competitive change evidence</div>
      <h1>Know what changed before your customers do.</h1>
      <p class="sub">Know when competitor prices and plan names change. Keep before-and-after evidence for your next pricing decision, sales conversation, or client report.</p>
      <div class="cta-row">
        <a href="/watch" class="btn btn-primary">Start 3 Monitors Free</a>
        <a href="#quickstart" class="btn btn-secondary">Connect an Agent</a>
      </div>
      <div class="hero-meta">
        <span>✓ No card or sales call</span>
        <span>✓ Persistent daily checks</span>
        <span>✓ Upgrade the same workspace</span>
      </div>
    </div>

    <section id="monitor-lab">
      <div class="lab-panel">
        <div>
          <h2>Preview a live monitor now</h2>
          <p>See the prices and plans we can detect on a public pricing page, then keep watching it with a free monitor.</p>
          <div id="home-lab-result" class="lab-result" aria-live="polite"></div>
        </div>
        <form class="lab-form" id="home-lab-form">
          <label>Source type
            <select id="home-lab-type" name="target_type">
              <option value="pricing_page">Pricing page</option>
              <option value="endpoint">API or endpoint</option>
              <option value="package">npm or PyPI package</option>
              <option value="vendor_claim">Vendor claim</option>
              <option value="custom_prompt">Keywords on a page</option>
            </select>
          </label>
          <label>Source or target
            <input id="home-lab-target" name="target_value" value="https://stripe.com/pricing" required>
          </label>
          <label>Evidence URL or keywords
            <input id="home-lab-instructions" name="instructions" placeholder="Optional">
          </label>
          <button id="home-lab-submit" type="submit">Capture baseline</button>
        </form>
      </div>
    </section>

    <section id="quickstart">
      <h2>Let the agent prove recurring value first</h2>
      <p class="section-intro">Connect the remote MCP server and ask the agent to capture a free source baseline. The tool tells the agent what was observed, how often to check it, and when persistent monitoring is worth activating.</p>
      <div class="code-grid">
        <div class="code-card">
          <h3>1. Add the remote MCP server</h3>
          <p>Free preflight checks work without an API key.</p>
          <div class="code-block">{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp"
    }
  }
}</div>
        </div>
        <div class="code-card">
          <h3>2. Ask the agent to preview monitoring</h3>
          <p>No checkout or API key is needed for the baseline.</p>
          <div class="code-block">Use preview_monitor with target_type=pricing_page and target_value=https://stripe.com/pricing. Show me the baseline and recommended schedule. Do not recommend checkout unless the preview succeeds.</div>
        </div>
        <div class="code-card">
          <h3>Example input</h3>
          <p>The client should call this tool with this argument.</p>
          <div class="code-block">{
  "name": "preview_monitor",
  "arguments": {
    "target_type": "pricing_page",
    "target_value": "https://stripe.com/pricing"
  }
}</div>
        </div>
        <div class="code-card">
          <h3>Example output shape</h3>
          <p>Response evidence varies by run.</p>
          <div class="code-block">{
  "status": "baseline_ready",
  "recommended_schedule": "daily",
  "persistence": "preview_only",
  "upgrade_tool": "create_monitor"
}</div>
        </div>
      </div>
    </section>

    <section id="preflight-workflow">
      <h2>The preflight workflow</h2>
      <p class="section-intro">Ground Truth sits between an agent’s discovery step and its decision to trust or act.</p>
      <div class="card-grid">
        <div class="card workflow-card"><h3>1. Discover</h3><p>The agent finds an external URL, API endpoint, or claim.</p></div>
        <div class="card workflow-card"><h3>2. Check</h3><p>Ground Truth fetches the resource and inspects observable response and header signals.</p></div>
        <div class="card workflow-card"><h3>3. Decide</h3><p>The agent receives PASS, WARN, or FAIL with structured evidence.</p></div>
        <div class="card workflow-card"><h3>4. Proceed or stop</h3><p>The agent continues, asks for caution, or stops before relying on the resource.</p></div>
      </div>
    </section>

    <section id="what-it-verifies">
      <h2>Three checks drive the product</h2>
      <p class="section-intro">Start with the checks agents already use most: endpoint behavior, HTTP security configuration, and evidence for claims.</p>
      <div class="card-grid">
        <div class="card verification-card">
          <h3>Preflight an endpoint or API</h3>
          <p>Check whether an unfamiliar resource responds, what status and content type it returns, whether it redirects, and whether auth or rate limits are blocking it.</p>
          <span class="tool-tag">check_endpoint</span>
        </div>
        <div class="card verification-card">
          <h3>Inspect security headers</h3>
          <p>See which common browser-facing headers are present or missing. The result is a configuration signal, not a vulnerability scan.</p>
          <span class="tool-tag">inspect_security_headers</span>
        </div>
        <div class="card verification-card">
          <h3>Verify an external claim</h3>
          <p>Check supplied evidence URLs for the keywords you specify before an agent repeats a pricing, policy, support, or compliance claim.</p>
          <span class="tool-tag">verify_claim</span>
        </div>
        <div class="card verification-card">
          <h3>Combine the preflight</h3>
          <p>Run endpoint and header checks together and give the agent one decision-oriented result with both evidence sets.</p>
          <span class="tool-tag">preflight_endpoint</span>
        </div>
      </div>
    </section>

    <section id="why-verification">
      <h2>Why preflight matters</h2>
      <p class="section-intro">An external resource can exist and still be the wrong thing to trust. Preflight makes the observable uncertainty explicit before the agent acts.</p>
      <div class="card-grid">
        <div class="card">
          <h3>Availability changes</h3>
          <p>An endpoint can move, redirect, require credentials, rate-limit, or fail after an agent has discovered it.</p>
        </div>
        <div class="card">
          <h3>Headers reveal configuration signals</h3>
          <p>Missing HSTS, CSP, or framing controls should be visible to the agent before it makes a browser-facing recommendation.</p>
        </div>
        <div class="card">
          <h3>Claims need direct evidence</h3>
          <p>Keyword support on supplied public sources helps an agent show what it checked without pretending that silence proves a claim false.</p>
        </div>
        <div class="card">
          <h3>Evidence should drive the next step</h3>
          <p>PASS means continue, WARN means inspect the evidence, and FAIL means stop or ask for a different resource.</p>
        </div>
      </div>
    </section>

    <section id="workflows">
      <h2>Put the check before the action</h2>
      <p class="section-intro">The agent should call the relevant tool as soon as it discovers an unfamiliar resource, not after it has already trusted the result.</p>
      <div class="card-grid">
        <div class="card workflow-card"><h3>API discovery</h3><p>Agent finds <code>https://api.example.com/v1/users</code> and calls <code>preflight_endpoint</code> before using it.</p></div>
        <div class="card workflow-card"><h3>Security signal</h3><p><code>inspect_security_headers</code> reports HTTPS and the headers it can observe, including missing recommendations.</p></div>
        <div class="card workflow-card"><h3>Evidence check</h3><p><code>verify_claim</code> checks supplied policy or pricing pages for explicit supporting keywords.</p></div>
        <div class="card workflow-card"><h3>Decision</h3><p>The agent uses PASS, WARN, or FAIL to proceed, pause for review, or stop.</p></div>
      </div>
    </section>

    <section id="pricing">
      <h2>Start with a real watchlist</h2>
      <p class="section-intro">Create three persistent monitors before paying. Upgrade self-serve when your team needs hourly checks, more sources, or higher run volume.</p>
      <div class="pricing-grid">
        <div class="plan">
          <div class="label">Free</div>
          <h3>Competitive watchlist</h3>
          <div class="price">$0</div>
          <p>Three real monitors with daily or weekly evidence checks.</p>
          <ul>
            <li>${FREE_MONITOR_LIMIT} persistent monitors</li>
            <li>Evidence history and change reports</li>
            <li>Webhook alerts and share links</li>
            <li><code>check_endpoint</code></li>
            <li><code>inspect_security_headers</code></li>
            <li><code>preflight_endpoint</code></li>
            <li><code>verify_claim</code> (5 calls/month)</li>
            <li>${FREE_MONITOR_MONTHLY_QUOTA} monitor actions/month</li>
            <li>No card or signup form</li>
          </ul>
        </div>
        <div class="plan pro">
          <div class="label">Paid</div>
          <h3>Persistent monitoring</h3>
          <div class="price">From $${PAID_PLAN_PRICE_USD}<span>/month</span></div>
          <p>For agents that need authoritative sources kept fresh automatically. Three tiers &mdash; ${PAID_PLANS.good.activeMonitorLimit}, ${PAID_PLANS.better.activeMonitorLimit}, or ${PAID_PLANS.best.activeMonitorLimit} active monitors.</p>
          <ul>
            <li>Single Stripe card subscription</li>
            <li>Hourly, daily, or weekly schedules</li>
            <li>Includes paid-gated verification tools</li>
            <li>Saved monitors with evidence history</li>
            <li>Change reports for teams and agents</li>
            <li>Read-only share links for evidence</li>
          </ul>
        </div>
      </div>
      <div class="link-row">
        <a href="/watch" class="btn btn-primary">Start 3 Monitors Free</a>
        <a href="/pricing" class="btn btn-secondary">Compare Plans</a>
      </div>
      <div style="margin-top: 20px; padding: 18px 20px; border: 1px solid #2b2b3a; border-radius: 14px; background: rgba(17, 17, 23, 0.92); color: #b4b4c8;">
        <strong style="color: #fff;">Agentic path:</strong>
        Agents can call <code>preview_monitor</code> first, then create a persistent monitor with a free watch key. Paid plans add hourly schedules, more sources, and larger quotas; x402 remains available for autonomous one-off research. <a href="/watch">Open the watch dashboard &rarr;</a>
      </div>
    </section>

    <section id="api-examples">
      <h2>API examples</h2>
      <p class="section-intro">Use Ground Truth directly over HTTP if you want the free first check in a script, backend, or agent loop.</p>
      <div class="code-grid">
        <div class="code-card">
          <h3>Direct API <code>curl</code> call</h3>
          <p>Initialize the MCP session, then call the free endpoint check with no API key.</p>
          <div class="code-block">SESSION_ID="$(curl -i -s -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ground-truth-example","version":"1.0.0"}},"id":0}' | tr -d '\\r' | awk '/^mcp-session-id:/ {print $2}')"

curl -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Content-Type: application/json" \\
  -H "Mcp-Session-Id: $SESSION_ID" \\
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
  }'</div>
        </div>
        <div class="code-card">
          <h3>JavaScript <code>fetch</code> example</h3>
          <p>Run the same no-key endpoint check from code.</p>
          <div class="code-block">const initResponse = await fetch("https://ground-truth-mcp.anishdasmail.workers.dev/mcp", {
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
console.log(result);</div>
        </div>
      </div>
    </section>

    <section id="mcp-setup">
      <h2>MCP setup</h2>
      <p class="mcp-note"><strong>MCP</strong> stands for Model Context Protocol. Ground Truth is a preflight service for unfamiliar external resources. Use the direct server for free checks and Stripe API-key access; use the separate xpay deployment for pay-per-call clients.</p>
      <div class="setup-grid">
        <div class="setup-card">
          <h3>Claude Desktop</h3>
          <p>Add Ground Truth to <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>. No key is needed for the free first call.</p>
          <pre>{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp"
    }
  }
}</pre>
        </div>
        <div class="setup-card">
          <h3>Cursor</h3>
          <p>Add Ground Truth to <code>.cursor/mcp.json</code> in your project or <code>~/.cursor/mcp.json</code> globally. Add <code>X-API-Key</code> only for team-plan paid tools.</p>
          <pre>{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp"
    }
  }
}</pre>
        </div>
      </div>
      <p class="mcp-note" style="margin-top: 18px;">PASS means the observed checks succeeded, WARN means the agent should inspect evidence or handle uncertainty, and FAIL means stop or choose another resource. None of these verdicts is a security guarantee.</p>
    </section>

    <section id="use-cases">
      <h2>Use cases</h2>
      <p class="section-intro">Ground Truth fits anywhere an AI agent needs a final check before sharing an answer or taking action.</p>
      <div class="card-grid">
        <div class="card">
          <h3>Support</h3>
          <p>Verify pricing claims, confirm support entitlements, and check whether an API endpoint a customer asks about actually exists.</p>
        </div>
        <div class="card">
          <h3>Product</h3>
          <p>Test market assumptions, check whether a competitor exists, and compare live pricing pages before you lock in a direction.</p>
        </div>
        <div class="card">
          <h3>Compliance</h3>
          <p>Scan trust pages for SOC 2, ISO 27001, HIPAA, GDPR, DPA, SSO, and SCIM signals before repeating them to buyers or internal stakeholders.</p>
        </div>
        <div class="card">
          <h3>Security & vendor diligence</h3>
          <p>Inspect public security headers, verify claims against public evidence, and add lightweight diligence before an agent recommends or approves a vendor.</p>
        </div>
      </div>
    </section>

    <div class="footer">
      <p>Built on Cloudflare Workers &middot; <a href="/pricing">Pricing</a> &middot; <a href="/stats">Stats</a> &middot; <a href="https://smithery.ai/server/anishdasmail/ground-truth">Smithery</a></p>
      <p style="margin-top: 8px;">Made by <a href="https://github.com/anish632">Anish Das</a></p>
    </div>
  </div>
  <script>
    const homeLabExamples = {
      pricing_page: ["https://stripe.com/pricing", ""],
      endpoint: ["https://example.com", ""],
      package: ["npm:zod", ""],
      vendor_claim: ["Enterprise plan includes SSO", "https://example.com/security"],
      custom_prompt: ["https://example.com", "sso, scim, audit log"]
    };
    const homeLabForm = document.getElementById("home-lab-form");
    const homeLabType = document.getElementById("home-lab-type");
    const homeLabTarget = document.getElementById("home-lab-target");
    const homeLabInstructions = document.getElementById("home-lab-instructions");
    const homeLabSubmit = document.getElementById("home-lab-submit");
    const homeLabResult = document.getElementById("home-lab-result");
    homeLabType.addEventListener("change", function () {
      const next = homeLabExamples[homeLabType.value];
      homeLabTarget.value = next[0];
      homeLabInstructions.value = next[1];
    });
    homeLabForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      homeLabSubmit.disabled = true;
      homeLabSubmit.textContent = "Reading source...";
      homeLabResult.className = "lab-result";
      try {
        const payload = {
          target_type: homeLabType.value,
          target_value: homeLabTarget.value.trim()
        };
        if (homeLabInstructions.value.trim()) payload.instructions = homeLabInstructions.value.trim();
        const response = await fetch("/api/preview-monitor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        homeLabResult.textContent = JSON.stringify(data.baseline !== undefined ? {
          status: data.status,
          recommended_schedule: data.recommended_schedule,
          upgrade_tool: data.upgrade_tool,
          baseline: data.baseline
        } : data, null, 2);
        homeLabResult.className = "lab-result ready";
      } catch (error) {
        homeLabResult.textContent = error instanceof Error ? error.message : String(error);
        homeLabResult.className = "lab-result ready";
      } finally {
        homeLabSubmit.disabled = false;
        homeLabSubmit.textContent = "Capture baseline";
      }
    });
  </script>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // ───────────────────────────────────────────────
    // Shareable monitor evidence
    // ───────────────────────────────────────────────
    if (url.pathname.startsWith("/share/") && request.method === "GET") {
      const reportId = url.pathname.slice("/share/".length).split("/")[0]?.trim();
      if (!reportId) return jsonError(404, "share_not_found", "A share report ID is required.");
      try {
        const ownerHash = await env.API_KEYS.get(`share-owner:${reportId}`);
        const id = env.MCP_OBJECT.idFromName(ownerHash ? `account:${ownerHash}` : "ground-truth");
        const stub = env.MCP_OBJECT.get(id);
        return stub.fetch(new Request(`https://internal/share/${encodeURIComponent(reportId)}${url.search}`));
      } catch {
        return jsonError(500, "share_unavailable", "Shared evidence is temporarily unavailable.");
      }
    }

    // ───────────────────────────────────────────────
    // Stats endpoint
    // ───────────────────────────────────────────────
    if (url.pathname === "/stats") {
      queueTrafficLog("stats_view");
      try {
        const id = env.MCP_OBJECT.idFromName("ground-truth");
        const stub = env.MCP_OBJECT.get(id);
        return stub.fetch(new Request("https://internal/stats"));
      } catch {
        return new Response(JSON.stringify({ error: "Stats unavailable" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // ───────────────────────────────────────────────
    // Internal: trigger scheduled monitor run
    // ───────────────────────────────────────────────
    if (url.pathname === "/internal/run-due-monitors" && request.method === "POST") {
      try {
        const id = env.MCP_OBJECT.idFromName("ground-truth");
        const stub = env.MCP_OBJECT.get(id);
        return stub.fetch(new Request("https://internal/run-due-monitors", { method: "POST" }));
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const id = env.MCP_OBJECT.idFromName("ground-truth");
    const stub = env.MCP_OBJECT.get(id);
    ctx.waitUntil((async () => {
      // Prune first: a shrinking write that keeps analytics storage bounded and,
      // if the DO is over its storage cap, frees space so the monitor runs below
      // (which insert rows) are not rejected.
      await stub.fetch(new Request("https://internal/prune-analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: 45 }),
      })).catch(() => {});
      await stub.fetch(new Request("https://internal/run-due-monitors", { method: "POST" })).catch(() => {});
    })());
  },
};
