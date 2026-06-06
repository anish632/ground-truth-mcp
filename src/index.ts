import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { z } from "zod";

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
  STRIPE_PRICE_ID?: string;
  STRIPE_STARTER_PRICE_ID?: string;
  STRIPE_TEAM_PRICE_ID?: string;
}

// --- Cache types ---
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHEABLE_BODY_BYTES = 512 * 1024;
const PAID_RESULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// --- Remote Telemetry Config ---
const TELEMETRY_ENABLED = workerProcess?.env?.GROUND_TRUTH_TELEMETRY !== "false";
const SERVER_VERSION = "0.4.5";

// --- Free tier tools ---
const FREE_TOOLS = ["check_endpoint", "inspect_security_headers", "verify_claim", "list_resources"];
const FREE_MONTHLY_LIMIT = 100;
const FREE_VERIFY_CLAIM_LIMIT = 5;
const STARTER_MONTHLY_LIMIT = 2500;
const PRO_MONTHLY_LIMIT = 5000;
const STARTER_PLAN_MONTHLY_PRICE_USD = 5;
const TEAM_PLAN_MONTHLY_PRICE_USD = 9;
const DEFAULT_STRIPE_PRICE_ID = "price_1TD5jiKOR3CPCI6H5nBr8KV8";
const DEFAULT_STRIPE_STARTER_PRICE_ID = "price_1TD5jiKOR3CPCI6H5nBr8KV8"; // Will be updated when Starter price is created in Stripe
const DEFAULT_STRIPE_TEAM_PRICE_ID = "price_1TD5jiKOR3CPCI6H5nBr8KV8"; // Will be updated when Team price is created in Stripe
const XPAY_UPSTREAM_HEADER = "X-Ground-Truth-Xpay-Secret";
const PUBLIC_APP_ORIGIN = "https://ground-truth-mcp.anishdasmail.workers.dev";
const SERVER_CARD_ICON_PATH = "/icon.svg";
const SERVER_CARD_DESCRIPTION =
  "🎯 ACTIVATION TEST: Paste 'Use check_endpoint with url=https://example.com' - works instantly, no signup. " +
  "Primary activation signal for AI agents before paid verification tools. Success = your MCP connection works perfectly.";
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

// Per-tool XPay pricing optimized for conversion and usage patterns
// Lower prices for high-frequency verification tools, higher for complex analysis
const AGENTIC_TOOL_PRICES_USD = {
  // High-frequency verification tools - optimized for first-call conversion
  check_pricing: 0.01,             // Most popular - reduced from 0.015 for conversion
  verify_claim: 0.01,             // Core verification - kept competitive
  estimate_market: 0.01,           // Market checks - competitive pricing
  
  // Mid-tier analysis tools - balanced pricing
  compare_competitors: 0.025,      // Package comparison - slight increase for value
  compare_pricing_pages: 0.035,    // Multi-page comparison - increased for complexity
  
  // Advanced analysis tools - premium pricing for specialized use
  test_hypothesis: 0.05,          // Complex multi-step test - increased for sophistication
  assess_compliance_posture: 0.06, // Enterprise compliance scan - premium for B2B value
} as const;

const PAID_TOOLS = Object.keys(AGENTIC_TOOL_PRICES_USD);
const MONITOR_TOOLS = ["create_monitor", "list_monitors", "run_monitor_now", "get_monitor_result", "delete_monitor", "generate_change_report"] as const;
const DEFAULT_X402_RECIPIENT = "0xB04BD750b67e7b00c95eAC8995eb9F8441309196";
const DEFAULT_X402_TESTNET_FACILITATOR_URL = "https://x402.org/facilitator";
const DEFAULT_X402_MAINNET_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

function normalizeX402Network(network: string): string {
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
      return network;
  }
}

function getDefaultFacilitatorUrl(network: string): string {
  return network === "eip155:8453"
    ? DEFAULT_X402_MAINNET_FACILITATOR_URL
    : DEFAULT_X402_TESTNET_FACILITATOR_URL;
}

const X402_PAYMENT_ENABLED = workerProcess?.env?.GROUND_TRUTH_AGENTIC_PAYMENTS !== "false";
const DEPLOYMENT_MODE = workerProcess?.env?.GROUND_TRUTH_DEPLOYMENT_MODE ?? "primary";
const IS_XPAY_UPSTREAM = DEPLOYMENT_MODE === "xpay_upstream";
const XPAY_UPSTREAM_SECRET = workerProcess?.env?.GROUND_TRUTH_XPAY_UPSTREAM_SECRET?.trim();
const XPAY_UPSTREAM_PATH_SECRET = workerProcess?.env?.GROUND_TRUTH_XPAY_UPSTREAM_PATH_SECRET?.trim();
const X402_NETWORK = normalizeX402Network(
  workerProcess?.env?.GROUND_TRUTH_X402_NETWORK ??
    workerProcess?.env?.X402_NETWORK ??
    "base-sepolia",
) as `${string}:${string}`;
const X402_RECIPIENT = (workerProcess?.env?.GROUND_TRUTH_X402_RECIPIENT ??
  workerProcess?.env?.X402_RECIPIENT ??
  DEFAULT_X402_RECIPIENT) as `0x${string}`;
const X402_FACILITATOR_URL = workerProcess?.env?.GROUND_TRUTH_X402_FACILITATOR_URL ??
  workerProcess?.env?.X402_FACILITATOR_URL ??
  getDefaultFacilitatorUrl(X402_NETWORK);

const x402PaymentServer = (() => {
  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: X402_FACILITATOR_URL }),
  );
  registerExactEvmScheme(resourceServer);
  return resourceServer;
})();

let x402InitializedPromise: Promise<void> | null = null;
const x402RequirementsCache = new Map<string, Promise<PaymentRequirements[]>>();
const SERVER_CARD_READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const SERVER_CARD_TOOLS = [
  {
    name: "check_endpoint",
    title: "🎯 Activation Test - Call This First",
    description:
      "PRIMARY ACTIVATION SIGNAL: Use url=https://example.com to test if your MCP connection works. " +
      "Zero signup/API key required. Success = connection perfect, ready for paid tools. " +
      "Performs one live fetch and returns status, content type, timing, auth signals, and response sample.",
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
      },
      required: ["url", "accessible"],
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
      "Call this to inspect security-relevant response headers on a public URL " +
      "before making a browser-facing security-header claim.",
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
      "Call this when you have a factual claim plus specific public evidence " +
      "URLs and need a source-by-source support check.",
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

function ensureX402Initialized(): Promise<void> {
  if (!x402InitializedPromise) {
    x402InitializedPromise = x402PaymentServer.initialize().catch((error) => {
      x402InitializedPromise = null;
      throw error;
    });
  }

  return x402InitializedPromise;
}

async function getX402PaymentRequirements(toolName: string): Promise<PaymentRequirements[]> {
  const cached = x402RequirementsCache.get(toolName);
  if (cached) return await cached;

  const priceUSD = AGENTIC_TOOL_PRICES_USD[toolName as keyof typeof AGENTIC_TOOL_PRICES_USD];
  const requirementsPromise = (async () => {
    await ensureX402Initialized();
    return await x402PaymentServer.buildPaymentRequirements({
      scheme: "exact",
      payTo: X402_RECIPIENT,
      price: priceUSD,
      network: X402_NETWORK,
      maxTimeoutSeconds: 300,
    });
  })();

  x402RequirementsCache.set(toolName, requirementsPromise);

  try {
    return await requirementsPromise;
  } catch (error) {
    x402RequirementsCache.delete(toolName);
    throw error;
  }
}

type ApiKeyRecord = Record<string, unknown> & {
  active?: boolean;
  billingActive?: boolean;
  subscriptionStatus?: string;
  monthlyQuota?: number;
  email?: string;
  stripeCustomerId?: string;
  subscriptionId?: string;
  createdAt?: string;
  cancelledAt?: string;
  reactivatedAt?: string;
};

interface UsageRecord {
  month: string;
  subjectType: "free" | "free_verify_claim" | "pro";
  subjectId: string;
  total: number;
  byTool: Record<string, number>;
  updatedAt: string;
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
  return IS_XPAY_UPSTREAM ? PUBLIC_APP_ORIGIN : url.origin;
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

> First tool call for AI agents: call check_endpoint with url=https://example.com. No signup or API key for the first endpoint check.

Sitemap: ${getSitemapUrl(url)}

## Primary Pages

- [Home](${publicOrigin}/): Overview, pricing summary, MCP setup, and example verification workflows.
- [Pricing](${publicOrigin}/pricing): Free checks, agentic pay-per-use, and team plan details.
- [MCP Server Card](${publicOrigin}/.well-known/mcp/server-card.json): Machine-readable tool metadata.
`;
}

function getSitemapXml(url: URL): string {
  const publicOrigin = getPublicOriginForRequest(url);
  const sitemapEntries = [
    { loc: `${publicOrigin}/`, priority: "1.0" },
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
    poweredBy: "Ground Truth MCP - Stop your AI from being wrong. Verify live data at https://ground-truth-mcp.anishdasmail.workers.dev",
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

function getX402PaymentToken(extra: unknown): string | undefined {
  const metaToken = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.["x402/payment"];
  if (typeof metaToken === "string" && metaToken.trim()) return metaToken.trim();

  return getExtraHeader(extra, "PAYMENT-SIGNATURE") ?? getExtraHeader(extra, "X-PAYMENT");
}

function hasTrustedXpaySecret(secret: string | null | undefined): boolean {
  return IS_XPAY_UPSTREAM &&
    typeof XPAY_UPSTREAM_SECRET === "string" &&
    XPAY_UPSTREAM_SECRET.length > 0 &&
    typeof secret === "string" &&
    secret === XPAY_UPSTREAM_SECRET;
}

function getBearerToken(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function isTrustedXpayRequest(request: Request): boolean {
  return hasTrustedXpaySecret(request.headers.get(XPAY_UPSTREAM_HEADER)?.trim()) ||
    hasTrustedXpaySecret(getBearerToken(request.headers.get("Authorization")));
}

function isTrustedXpayExtra(extra: unknown): boolean {
  return hasTrustedXpaySecret(getExtraHeader(extra, XPAY_UPSTREAM_HEADER)) ||
    hasTrustedXpaySecret(getBearerToken(getExtraHeader(extra, "Authorization")));
}

function hasTrustedXpayPath(url: URL): boolean {
  if (
    !IS_XPAY_UPSTREAM ||
    typeof XPAY_UPSTREAM_PATH_SECRET !== "string" ||
    XPAY_UPSTREAM_PATH_SECRET.length === 0
  ) {
    return false;
  }

  return url.pathname === `/mcp/${XPAY_UPSTREAM_PATH_SECRET}` ||
    url.pathname === `/mcp-xpay-${XPAY_UPSTREAM_PATH_SECRET}`;
}

function hasTrustedXpayQuery(url: URL): boolean {
  return IS_XPAY_UPSTREAM &&
    typeof XPAY_UPSTREAM_PATH_SECRET === "string" &&
    XPAY_UPSTREAM_PATH_SECRET.length > 0 &&
    url.searchParams.get("xpay_secret") === XPAY_UPSTREAM_PATH_SECRET;
}

function isPublicXpayDiscoveryMethod(method: string | null): boolean {
  return method === "initialize" ||
    method === "notifications/initialized" ||
    method === "tools/list";
}

function buildX402PaymentRequiredResult(
  toolName: string,
  description: string,
  requirements: PaymentRequirements[],
  reason = "PAYMENT_REQUIRED",
  extraFields: Record<string, unknown> = {},
) {
  const payload = {
    x402Version: 2,
    error: reason,
    resource: {
      url: `x402://${toolName}`,
      description,
      mimeType: "application/json",
    },
    accepts: requirements,
    ...extraFields,
  };

  return {
    isError: true,
    _meta: { "x402/error": payload },
    content: [{
      type: "text" as const,
      text: JSON.stringify(payload),
    }],
  };
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

  const score = presentCount >= 6 ? "strong" : presentCount >= 3 ? "moderate" : "weak";

  return {
    headers: summary,
    presentCount,
    missingRecommended,
    score,
  };
}

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

function getProQuota(record: ApiKeyRecord): number {
  return typeof record.monthlyQuota === "number" ? record.monthlyQuota : PRO_MONTHLY_LIMIT;
}

function getUsageStorageKey(subjectType: "free" | "free_verify_claim" | "pro", month: string, subjectId: string): string {
  return `usage:${subjectType}:${month}:${subjectId}`;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
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

async function updateCustomerBillingState(
  kv: KVNamespace,
  customerId: string,
  updates: Partial<ApiKeyRecord>,
): Promise<void> {
  const keysList = await kv.list({ prefix: "gt_live_" });

  for (const key of keysList.keys) {
    const data = await getApiKeyRecord(kv, key.name);
    if (!data || data.stripeCustomerId !== customerId) continue;

    await saveApiKeyRecord(kv, key.name, {
      ...data,
      ...updates,
    });
  }
}

async function getUsageRecord(kv: KVNamespace, usageKey: string): Promise<UsageRecord | null> {
  const data = await kv.get(usageKey, "json");
  if (!data || typeof data !== "object") return null;

  const record = data as Partial<UsageRecord>;
  return {
    month: typeof record.month === "string" ? record.month : getCurrentUsageMonth(),
    subjectType: record.subjectType === "pro" ? "pro" : "free",
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
  subjectType: "free" | "free_verify_claim" | "pro",
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
      `Team monthly quota exceeded for ${month}.`,
      {
        tier: "team",
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

// --- API Key helpers ---
function generateApiKey(): string {
  const chars = "0123456789abcdef";
  let key = "gt_live_";
  for (let i = 0; i < 32; i++) {
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
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
    
    // Non-blocking fire-and-forget POST to Neon via HTTP proxy
    // Use a lightweight edge function to insert into Postgres
    fetch("https://ground-truth-dashboard.vercel.app/api/track", {
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
  const resp = await fetch(url, { headers: { "User-Agent": "GroundTruth/0.3" } });
  const body = await resp.text();
  if (resp.ok) cacheSet(sql, url, body);
  return { body, fromCache: false };
}

function paidResultCacheGet(sql: SqlTagFn, key: string): Record<string, unknown> | null {
  const rows = sql<{ response: string; ts: number }>`SELECT response, ts FROM paid_result_cache WHERE key = ${key}`;
  if (rows.length === 0) return null;

  const row = rows[0];
  if (Date.now() - row.ts > PAID_RESULT_CACHE_TTL_MS) {
    sql`DELETE FROM paid_result_cache WHERE key = ${key}`;
    return null;
  }

  try {
    return JSON.parse(row.response) as Record<string, unknown>;
  } catch {
    sql`DELETE FROM paid_result_cache WHERE key = ${key}`;
    return null;
  }
}

function paidResultCacheSet(sql: SqlTagFn, key: string, response: Record<string, unknown>): void {
  try {
    sql`INSERT OR REPLACE INTO paid_result_cache (key, response, ts) VALUES (${key}, ${JSON.stringify(response)}, ${Date.now()})`;
  } catch {
    // Paid result caching should never block a tool response.
  }
}

// --- Monitor helpers ---
function generateMonitorId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "mon_";
  for (let i = 0; i < 20; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function generateResultId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "res_";
  for (let i = 0; i < 20; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
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
export class GroundTruthMCP extends McpAgent<Env> {
  server = new McpServer({ name: "ground-truth", version: SERVER_VERSION });

  async init() {
    // Initialize cache table
    this.sql`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, data TEXT, ts INTEGER)`;
    // Initialize usage log table
    this.sql`CREATE TABLE IF NOT EXISTS usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT, ts INTEGER, success INTEGER)`;
    // Initialize paid-response cache for idempotent x402 retries
    this.sql`CREATE TABLE IF NOT EXISTS paid_result_cache (key TEXT PRIMARY KEY, response TEXT, ts INTEGER)`;
    // Initialize monitor tables
    this.sql`CREATE TABLE IF NOT EXISTS monitors (id TEXT PRIMARY KEY, owner_key_hash TEXT NOT NULL, name TEXT NOT NULL, target_type TEXT NOT NULL, target_value TEXT NOT NULL, instructions TEXT, schedule TEXT NOT NULL DEFAULT 'manual', notification_destination TEXT, last_run_at INTEGER, last_run_status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`;
    this.sql`CREATE TABLE IF NOT EXISTS monitor_results (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, owner_key_hash TEXT NOT NULL, run_at INTEGER NOT NULL, status TEXT NOT NULL, changed INTEGER NOT NULL DEFAULT 0, old_value TEXT, new_value TEXT, confidence REAL, evidence TEXT, error_details TEXT, raw_metadata TEXT)`;
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

    const toolServer = this.server as McpServer;
    const registerPaidTool = (
      name: string,
      priceUSD: number,
      config: Record<string, unknown>,
      execute: (args: any, extra: unknown) => Promise<Record<string, unknown>>,
    ) =>
      (toolServer as unknown as {
        registerTool: (toolName: string, toolConfig: Record<string, unknown>, callback: (args: any, extra: unknown) => Promise<Record<string, unknown>>) => unknown;
      }).registerTool(
        name,
        {
          ...config,
          _meta: IS_XPAY_UPSTREAM
            ? ((config as { _meta?: Record<string, unknown> })._meta ?? {})
            : {
              ...((config as { _meta?: Record<string, unknown> })._meta ?? {}),
              "agents-x402/paymentRequired": true,
              "agents-x402/priceUSD": priceUSD,
            },
        },
        async (args, extra) => {
          if (isTrustedXpayExtra(extra)) {
            return await execute(args, extra);
          }

          const teamApiKey = getExtraHeader(extra, "X-API-Key");
          if (teamApiKey) {
            return await execute(args, extra);
          }

          if (!X402_PAYMENT_ENABLED) {
            return {
              isError: true,
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: "payment_disabled",
                  message: "Agentic pay-per-use is disabled on this deployment. Use a team API key instead.",
                }),
              }],
            };
          }

          let requirements: PaymentRequirements[];
          try {
            requirements = await getX402PaymentRequirements(name);
          } catch {
            return {
              isError: true,
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: "payment_setup_failed",
                  message: "Unable to compute x402 payment requirements for this tool.",
                }),
              }],
            };
          }

          const description = typeof config.description === "string" ? config.description : name;
          const paymentToken = getX402PaymentToken(extra);
          if (!paymentToken) {
            return buildX402PaymentRequiredResult(name, description, requirements);
          }

          const paidResultCacheKey = await sha256Hex(`x402:${name}:${paymentToken}`);
          const cachedPaidResult = paidResultCacheGet(sql, paidResultCacheKey);
          if (cachedPaidResult) {
            return cachedPaidResult;
          }

          let paymentPayload: Record<string, unknown>;
          try {
            paymentPayload = JSON.parse(atob(paymentToken)) as Record<string, unknown>;
          } catch {
            return buildX402PaymentRequiredResult(name, description, requirements, "INVALID_PAYMENT");
          }

          const matchingRequirements = x402PaymentServer.findMatchingRequirements(requirements, paymentPayload as any);
          if (!matchingRequirements) {
            return buildX402PaymentRequiredResult(name, description, requirements, "INVALID_PAYMENT");
          }

          try {
            const verification = await x402PaymentServer.verifyPayment(paymentPayload as any, matchingRequirements);
            if (!verification.isValid) {
              return buildX402PaymentRequiredResult(
                name,
                description,
                requirements,
                verification.invalidReason ?? "INVALID_PAYMENT",
                verification.payer ? { payer: verification.payer } : {},
              );
            }
          } catch {
            return buildX402PaymentRequiredResult(name, description, requirements, "INVALID_PAYMENT");
          }

          let result: Record<string, unknown>;
          try {
            result = await execute(args, extra);
          } catch (error) {
            result = {
              isError: true,
              content: [{
                type: "text" as const,
                text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
              }],
            };
          }

          if (result.isError === true) {
            return result;
          }

          try {
            const settlement = await x402PaymentServer.settlePayment(paymentPayload as any, matchingRequirements);
            if (!settlement.success) {
              return buildX402PaymentRequiredResult(name, description, requirements, settlement.errorReason ?? "SETTLEMENT_FAILED");
            }

            const enrichedResult = {
              ...result,
              _meta: {
                ...((result._meta as Record<string, unknown> | undefined) ?? {}),
                "x402/payment-response": {
                  success: true,
                  transaction: settlement.transaction,
                  network: settlement.network,
                  payer: settlement.payer,
                },
              },
            };
            paidResultCacheSet(sql, paidResultCacheKey, enrichedResult);
            return enrichedResult;
          } catch {
            return buildX402PaymentRequiredResult(name, description, requirements, "SETTLEMENT_FAILED");
          }
        },
      );

    // ───────────────────────────────────────────────
    // FREE: check_endpoint
    // ───────────────────────────────────────────────
    this.server.registerTool(
      "check_endpoint",
      {
        title: "Endpoint Reachability Check",
        description:
          "Perform one live, unauthenticated fetch against a public URL or API endpoint " +
          "before you recommend it, document it, or build on top of it. Use this when " +
          "the question is simply whether an endpoint currently responds and what kind " +
          "of response it returns. It reports HTTP status, content type, elapsed time, " +
          "likely auth/rate-limit signals, and a short response sample. A successful " +
          "result only proves basic reachability at fetch time. Do not use it to " +
          "validate authenticated flows, POST side effects, JavaScript execution, " +
          "or deeper business logic.",
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
          sampleResponse: z.string().describe(
            "First 1,000 characters of the response body for quick inspection. Use this as a debugging hint only; it may be truncated and should not be treated as a complete page capture.",
          ).optional(),
          error: z.string().describe(
            "Validation or network error when the request could not be completed.",
          ).optional(),
        },
        annotations: readOnlyNetworkToolAnnotations,
      },
      async ({ url }) => {
        const normalizedUrl = normalizeHttpUrlInput(url);
        if (!normalizedUrl) {
          logUsage("check_endpoint", false);
          return structuredToolResult({
            url,
            accessible: false,
            error: "Invalid URL. Use a public http(s) URL or a bare domain like google.com.",
          });
        }

        const start = Date.now();
        try {
          const resp = await fetch(normalizedUrl, {
            headers: { "User-Agent": "GroundTruth/0.3" },
          });
          const elapsed = Date.now() - start;
          const body = await resp.text();
          const sample = body.slice(0, 1000);
          logUsage("check_endpoint", true);

          return structuredToolResult({
            ...(normalizedUrl !== url ? { inputUrl: url } : {}),
            url: normalizedUrl,
            accessible: resp.ok,
            status: resp.status,
            contentType: resp.headers.get("content-type"),
            responseTimeMs: elapsed,
            authRequired: resp.status === 401 || resp.status === 403,
            rateLimited: resp.status === 429,
            sampleResponse: sample,
          });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          logUsage("check_endpoint", false);
          return structuredToolResult({
            ...(normalizedUrl !== url ? { inputUrl: url } : {}),
            url: normalizedUrl,
            accessible: false,
            error: message,
            responseTimeMs: Date.now() - start,
          });
        }
      }
    );

    // ───────────────────────────────────────────────
    // PAID $0.01: estimate_market (npm + PyPI)
    // ───────────────────────────────────────────────
    registerPaidTool(
      "estimate_market",
      AGENTIC_TOOL_PRICES_USD.estimate_market,
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
    // PAID $0.02: check_pricing
    // ───────────────────────────────────────────────
    registerPaidTool(
      "check_pricing",
      AGENTIC_TOOL_PRICES_USD.check_pricing,
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
          "Fetch a public URL and inspect security-relevant response headers before " +
          "you claim that a product or endpoint has a strong browser-facing security " +
          "baseline. Use this for quick due diligence on public apps and docs sites. " +
          "It checks for common headers such as HSTS, CSP, X-Frame-Options, " +
          "Referrer-Policy, Permissions-Policy, and X-Content-Type-Options. It does " +
          "not replace a real security review, authenticated testing, or vulnerability scanning.",
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
        },
        annotations: readOnlyNetworkToolAnnotations,
      },
      async ({ url }) => {
        const normalizedUrl = normalizeHttpUrlInput(url);
        if (!normalizedUrl) {
          logUsage("inspect_security_headers", false);
          return structuredToolResult({
            url,
            accessible: false,
            https: false,
            error: "Invalid URL. Use a public http(s) URL or a bare domain like google.com.",
          });
        }

        try {
          const resp = await fetch(normalizedUrl, {
            headers: { "User-Agent": "GroundTruth/0.3" },
          });
          const summary = getSecurityHeaderSummary(resp.headers);
          logUsage("inspect_security_headers", true);
          return structuredToolResult({
            ...(normalizedUrl !== url ? { inputUrl: url } : {}),
            url: normalizedUrl,
            accessible: true,
            status: resp.status,
            https: new URL(normalizedUrl).protocol === "https:",
            ...summary,
          });
        } catch (error: unknown) {
          logUsage("inspect_security_headers", false);
          return structuredToolResult({
            ...(normalizedUrl !== url ? { inputUrl: url } : {}),
            url: normalizedUrl,
            accessible: false,
            https: new URL(normalizedUrl).protocol === "https:",
            error: error instanceof Error ? error.message : String(error),
          });
        }
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
        });
      }
    );

    // ───────────────────────────────────────────────
    // PAID $0.04: compare_pricing_pages
    // ───────────────────────────────────────────────
    registerPaidTool(
      "compare_pricing_pages",
      AGENTIC_TOOL_PRICES_USD.compare_pricing_pages,
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
      AGENTIC_TOOL_PRICES_USD.compare_competitors,
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
      AGENTIC_TOOL_PRICES_USD.verify_claim,
      {
        title: "Claim Support Check",
        description:
          "Check whether a factual claim is supported by a specific set of public " +
          "evidence URLs that you already have. For each source, the tool performs a " +
          "case-insensitive keyword match over the fetched page body, then marks that " +
          "source as supporting the claim when at least half of the supplied keywords " +
          "appear. Use this for evidence-backed claim checks on known pages, not for " +
          "open-ended search, semantic reasoning, or contradiction extraction. The " +
          "aggregate verdict is driven only by the per-page keyword support ratio. " +
          "Fetched pages are cached for 5 minutes.",
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
      AGENTIC_TOOL_PRICES_USD.assess_compliance_posture,
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
      AGENTIC_TOOL_PRICES_USD.test_hypothesis,
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
    // MONITOR TOOLS (require team API key)
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
          "Results are stored in the Durable Object SQLite database. Requires a team API key.",
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
            "Optional destination for change alerts (email or webhook URL). Stored for future use.",
          ),
        },
        outputSchema: {
          id: z.string().describe("Unique monitor ID."),
          name: z.string().describe("Monitor name."),
          target_type: z.string().describe("Monitor target type."),
          target_value: z.string().describe("Monitor target value."),
          schedule: z.string().describe("Monitor schedule."),
          created_at: z.string().describe("Creation timestamp ISO 8601."),
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
        const id = generateMonitorId();
        const now = Date.now();
        const sched = schedule ?? "daily";
        try {
          sql`INSERT INTO monitors (id, owner_key_hash, name, target_type, target_value, instructions, schedule, notification_destination, last_run_at, last_run_status, created_at, updated_at, active) VALUES (${id}, ${ownerKeyHash}, ${name}, ${target_type}, ${target_value}, ${instructions ?? null}, ${sched}, ${notification_destination ?? null}, ${null}, ${null}, ${now}, ${now}, ${1})`;
          logUsage("create_monitor", true);
          return structuredToolResult({ id, name, target_type, target_value, schedule: sched, created_at: new Date(now).toISOString() });
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
          "Requires a team API key.",
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
          error: z.string().optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ active_only }, extra) => {
        const apiKey = getExtraHeader(extra, "X-API-Key");
        if (!apiKey) {
          return structuredToolResult({ monitors: [], total: 0, error: "missing_api_key: list_monitors requires a team API key" });
        }
        const ownerKeyHash = await sha256Hex(apiKey);
        try {
          const rows = active_only
            ? sql<MonitorRecord>`SELECT * FROM monitors WHERE owner_key_hash = ${ownerKeyHash} AND active = 1 ORDER BY created_at DESC`
            : sql<MonitorRecord>`SELECT * FROM monitors WHERE owner_key_hash = ${ownerKeyHash} ORDER BY created_at DESC`;
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
          return structuredToolResult({ monitors, total: monitors.length });
        } catch (e) {
          logUsage("list_monitors", false);
          return structuredToolResult({ monitors: [], total: 0, error: e instanceof Error ? e.message : String(e) });
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
          "Counts against your monthly quota. Requires a team API key.",
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
          "confidence score, evidence URLs, and any error information. Requires a team API key.",
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
          "This action cannot be undone. Requires a team API key.",
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
          "Requires a team API key.",
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

  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "internal" && url.pathname === "/run-due-monitors" && request.method === "POST") {
      return this.handleRunDueMonitors();
    }
    return super.fetch(request);
  }

  async handleRunDueMonitors(): Promise<Response> {
    const sql = this.sql.bind(this) as SqlTagFn;
    try {
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
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const isPrimaryMcpPath = url.pathname === "/mcp";
    const isTrustedXpayPathRequest = hasTrustedXpayPath(url);
    const isTrustedXpayQueryRequest = hasTrustedXpayQuery(url);
    const servedMcpPath = isTrustedXpayPathRequest ? url.pathname : "/mcp";

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
    if (isPrimaryMcpPath || isTrustedXpayPathRequest) {
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

      if (IS_XPAY_UPSTREAM) {
        if (!XPAY_UPSTREAM_SECRET && !XPAY_UPSTREAM_PATH_SECRET) {
          return jsonError(
            500,
            "xpay_upstream_trust_missing",
            "This xpay upstream deployment is missing its trust configuration.",
            { header: XPAY_UPSTREAM_HEADER, path: "/mcp/<secret>" },
            requestId,
          );
        }

        const trustedXpayRequest = isTrustedXpayRequest(request) ||
          isTrustedXpayPathRequest ||
          isTrustedXpayQueryRequest;
        if (!trustedXpayRequest && !isPublicXpayDiscoveryMethod(method)) {
          return jsonError(
            401,
            "invalid_xpay_upstream_secret",
            "This xpay upstream deployment requires a valid shared secret header, path, or query token.",
            { header: XPAY_UPSTREAM_HEADER, path: "/mcp/<secret>", query: "xpay_secret" },
            requestId,
          );
        }

        return GroundTruthMCP.serve("/mcp").fetch(request, env, ctx);
      }

      if (method === "tools/call" && toolName) {
        if (FREE_TOOLS.includes(toolName)) {
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
                return jsonError(
                  429,
                  "quota_exceeded",
                  `Team monthly quota exceeded for ${month}.`,
                  {
                    tier: "team",
                    tool: toolName,
                    month,
                    limit,
                    used: usage.used,
                    remaining: usage.remaining,
                  },
                  requestId,
                );
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
                return jsonError(
                  429,
                  "quota_exceeded",
                  `Free verify_claim quota exceeded for ${month}. Upgrade to Starter plan for unlimited claim verifications.`,
                  {
                    tier: "free",
                    tool: toolName,
                    month,
                    limit: FREE_VERIFY_CLAIM_LIMIT,
                    used: usage.used,
                    remaining: usage.remaining,
                    clientType: freeClient.type,
                    upgradeUrl: "https://ground-truth-mcp.anishdasmail.workers.dev/pricing",
                    upgradeMessage: `Starter plan: $${STARTER_PLAN_MONTHLY_PRICE_USD}/month for ${STARTER_MONTHLY_LIMIT} verifications`,
                  },
                  requestId,
                );
              }
              
              return jsonError(
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
              );
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
            return jsonError(
              401,
              "missing_api_key",
              `Tool '${toolName}' requires a team API key.`,
              { tier: "team", tool: toolName },
              requestId,
            );
          }
          const proAccess = await requireProAccess(env.API_KEYS, request, toolName, requestId);
          if (proAccess instanceof Response) {
            return proAccess;
          }
          await incrementUsage(env.API_KEYS, proAccess.usageKey, "pro", proAccess.subjectId, proAccess.month, toolName);
        } else {
          const maybeApiKey = request.headers.get("X-API-Key")?.trim();
          if (maybeApiKey) {
            const proAccess = await requireProAccess(env.API_KEYS, request, toolName, requestId);
            if (proAccess instanceof Response) {
              return proAccess;
            }

            await incrementUsage(
              env.API_KEYS,
              proAccess.usageKey,
              "pro",
              proAccess.subjectId,
              proAccess.month,
              toolName,
            );
          }
        }
      }

      return GroundTruthMCP.serve(servedMcpPath).fetch(request, env, ctx);
    }

    if (url.pathname === SERVER_CARD_ICON_PATH) {
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
      const publicOrigin = IS_XPAY_UPSTREAM
        ? PUBLIC_APP_ORIGIN
        : url.origin;
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
          required: IS_XPAY_UPSTREAM,
          schemes: IS_XPAY_UPSTREAM ? ["header"] : ["header", "x402"],
        },
        metadata: IS_XPAY_UPSTREAM
          ? {
            description: SERVER_CARD_DESCRIPTION,
            homepage,
            website: homepage,
            icon,
            pricing: `${publicOrigin}/pricing`,
            freeTools: FREE_TOOLS,
            upstreamMode: "xpay_proxy",
            upstreamAuthHeader: XPAY_UPSTREAM_HEADER,
          }
          : {
            description: SERVER_CARD_DESCRIPTION,
            homepage,
            website: homepage,
            icon,
            pricing: `${publicOrigin}/pricing`,
            freeTools: FREE_TOOLS,
            freeVerifyClaimLimit: FREE_VERIFY_CLAIM_LIMIT,
            starterPlan: {
              priceUsdMonthly: STARTER_PLAN_MONTHLY_PRICE_USD,
              quota: STARTER_MONTHLY_LIMIT,
              header: "X-API-Key",
            },
            teamPlan: {
              priceUsdMonthly: TEAM_PLAN_MONTHLY_PRICE_USD,
              quota: PRO_MONTHLY_LIMIT,
              header: "X-API-Key",
            },
            agenticPayPerUse: {
              enabled: X402_PAYMENT_ENABLED,
              network: X402_NETWORK,
              facilitator: X402_FACILITATOR_URL,
              recipient: X402_RECIPIENT,
              toolPricesUsd: AGENTIC_TOOL_PRICES_USD,
            },
          },
        tools: SERVER_CARD_TOOLS,
        resources: [],
        prompts: [],
      });
    }

    // ───────────────────────────────────────────────
    // Pricing page
    // ───────────────────────────────────────────────
    if (url.pathname === "/pricing") {
      return new Response(
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ground Truth - Pricing</title>
  <meta name="description" content="🎯 ACTIVATION TEST: Paste this exact prompt - 'Use check_endpoint with url=https://example.com' - works instantly, no signup. Primary activation signal for AI agents.">
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

    .page { max-width: 1040px; margin: 0 auto; }
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

    .plans { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; margin-bottom: 48px; }

    .plan {
      background: rgba(20, 20, 20, 0.92);
      border: 1px solid #242432;
      border-radius: 18px;
      padding: 32px 28px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.24);
    }
    .plan-pro { border-color: #7c8aff; }

    .plan h2 { font-size: 1.3rem; color: #fff; margin-bottom: 4px; }
    .plan .price { font-size: 2.4rem; font-weight: 700; color: #fff; margin: 16px 0; }
    .plan .price span { font-size: 1rem; font-weight: 400; color: #73738a; }
    .plan .desc { color: #9c9cb2; font-size: 0.95rem; margin-bottom: 20px; line-height: 1.6; }
    .price-list {
      margin-top: 8px;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(11, 11, 17, 0.95);
      border: 1px solid #252536;
      color: #c8c8d8;
      font-size: 0.9rem;
      line-height: 1.7;
    }
    .price-list strong { color: #fff; }

    .plan ul { list-style: none; margin-bottom: 24px; }
    .plan ul li {
      padding: 8px 0 8px 24px;
      position: relative;
      color: #ccc;
      font-size: 0.95rem;
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
      padding: 14px 32px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 1rem;
      transition: transform 0.15s, box-shadow 0.15s;
      border: none;
      cursor: pointer;
      text-align: center;
      width: 100%;
    }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(124,138,255,0.25); text-decoration: none; }
    .btn-primary { background: #7c8aff; color: #0a0a0a; }
    .btn-outline { background: transparent; color: #7c8aff; border: 1px solid #333; }

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

    @media (max-width: 960px) {
      .plans { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="hero">
      <div class="eyebrow">Verification Layer For AI Agents</div>
      <h1>Start free. Pay for monitored evidence.</h1>
      <p class="sub">Ground Truth gives AI agents a free first live check, then paid monitor history for claims that should not go stale. Use saved monitors, scheduled checks, change reports, and team API keys to track pricing pages, endpoints, packages, trust pages, and vendor claims over time.</p>
    </div>

    <div class="plans">
      <div class="plan">
        <h2>Free</h2>
        <div class="price">$0</div>
        <p class="desc">Free tier includes limited monthly checks plus 5 claim verifications to try the core value.</p>
        <ul>
          <li><strong>check_endpoint</strong></li>
          <li><strong>inspect_security_headers</strong></li>
          <li><strong>list_resources</strong> (no quota)</li>
          <li><strong>verify_claim</strong> (5 calls/month)</li>
          <li>100 total requests per calendar month for endpoint + security checks</li>
          <li>Tracked by Cloudflare client IP in production, or an anonymous client identifier in local/dev</li>
          <li>No API key required</li>
        </ul>
        <a href="/#quickstart" class="btn btn-outline">Try Free Checks</a>
      </div>

      <div class="plan">
        <h2>Starter</h2>
        <div class="price">$${STARTER_PLAN_MONTHLY_PRICE_USD}<span>/month</span></div>
        <p class="desc">For individual agent builders who need saved monitors, evidence history, and predictable monthly usage.</p>
        <ul>
          <li>Requires <strong>X-API-Key</strong></li>
          <li>Billing must be active</li>
          <li>${STARTER_MONTHLY_LIMIT.toLocaleString()} requests per calendar month</li>
          <li>Usage tracked per API key</li>
          <li>Includes all verification tools: pricing, compliance, market, competitor, hypothesis</li>
          <li>Create and run saved monitors with evidence history</li>
          <li>Unlimited <strong>verify_claim</strong> calls</li>
        </ul>
        <form action="/api/checkout?plan=starter" method="POST">
          <button type="submit" class="btn btn-primary">Subscribe Starter Plan</button>
        </form>
      </div>

      <div class="plan plan-pro">
        <h2>Agentic</h2>
        <div class="price">From $0.01<span>/call</span></div>
        <p class="desc">Use x402-compatible MCP clients or an xpay proxy to pay only when an agent runs a paid verification tool. Best before you need saved monitor history.</p>
        <ul>
          <li>No monthly subscription required</li>
          <li>Per-tool USDC pricing via x402</li>
          <li>Works with x402-aware clients or an xpay proxy</li>
          <li>Best for autonomous agents and variable workloads</li>
        </ul>
        <div class="price-list">
          <strong>Per-tool pricing (optimized for conversion)</strong><br>
          <em>High-frequency verification tools:</em><br>
          <code>check_pricing</code> $${AGENTIC_TOOL_PRICES_USD.check_pricing.toFixed(2)} <span style="color: #22c55e;">↓ Reduced</span><br>
          <code>verify_claim</code> $${AGENTIC_TOOL_PRICES_USD.verify_claim.toFixed(2)}<br>
          <code>estimate_market</code> $${AGENTIC_TOOL_PRICES_USD.estimate_market.toFixed(2)}<br>
          <em>Advanced analysis tools:</em><br>
          <code>compare_pricing_pages</code> $${AGENTIC_TOOL_PRICES_USD.compare_pricing_pages.toFixed(3)}<br>
          <code>test_hypothesis</code> $${AGENTIC_TOOL_PRICES_USD.test_hypothesis.toFixed(2)}<br>
        </div>
        <a href="/#mcp-setup" class="btn btn-outline" style="margin-top: 24px;">See Agentic Setup</a>
      </div>

      <div class="plan">
        <h2>Team</h2>
        <div class="price">$${TEAM_PLAN_MONTHLY_PRICE_USD}<span>/month</span></div>
        <p class="desc">Use a team API key for shared monitors, change reports, broader verification, and predictable spend.</p>
        <ul>
          <li>Requires <strong>X-API-Key</strong></li>
          <li>Billing must be active</li>
          <li>${PRO_MONTHLY_LIMIT.toLocaleString()} requests per calendar month by default</li>
          <li>Usage tracked per API key and tool</li>
          <li>Includes pricing, compliance, market, competitor, and hypothesis tools</li>
          <li>Monitor management and generated change reports for shared workflows</li>
          <li>Unlimited <strong>verify_claim</strong> calls</li>
        </ul>
        <form action="/api/checkout?plan=team" method="POST">
          <button type="submit" class="btn btn-primary">Subscribe Team Plan</button>
        </form>
      </div>
    </div>

    <div class="note">
      <strong>How to choose:</strong> Free is for proving the MCP connection. <strong>Starter</strong> ($${STARTER_PLAN_MONTHLY_PRICE_USD}/month) is for individual saved monitors and evidence history. <strong>Agentic</strong> is for pay-per-tool-call automation with x402 or xpay. <strong>Team</strong> ($${TEAM_PLAN_MONTHLY_PRICE_USD}/month) is for shared monitor workflows, reports, and ${PRO_MONTHLY_LIMIT.toLocaleString()} monthly requests.
    </div>

    <div class="faq">
      <h2>Questions</h2>
      <dl>
        <div class="faq-item">
          <dt>What is Ground Truth?</dt>
          <dd>Ground Truth is a verification layer for AI agents. Instead of trusting a model to guess once, you give it a way to check live data, save monitors, keep evidence history, and report when important claims change.</dd>
        </div>
        <div class="faq-item">
          <dt>What is MCP?</dt>
          <dd>Model Context Protocol is the standard that lets AI apps call external tools. Ground Truth plugs into Claude Desktop, Cursor, and other MCP clients so your agent can verify before it acts.</dd>
        </div>
        <div class="faq-item">
          <dt>Do I need an API key for the free check?</dt>
          <dd>No. <strong>check_endpoint</strong>, <strong>inspect_security_headers</strong>, and <strong>list_resources</strong> work immediately with no signup. <strong>verify_claim</strong> is also free for up to 5 calls per calendar month. No API key required for any free tier tool.</dd>
        </div>
        <div class="faq-item">
          <dt>How do agentic payments work?</dt>
          <dd>Paid tools advertise x402 pricing metadata with tiered per-tool pricing. An x402-aware client, or an xpay proxy in front of this server, can pay per tool call automatically using USDC. High-frequency tools like <strong>check_pricing</strong> cost just $${AGENTIC_TOOL_PRICES_USD.check_pricing.toFixed(2)}, while advanced analysis tools like <strong>test_hypothesis</strong> cost $${AGENTIC_TOOL_PRICES_USD.test_hypothesis.toFixed(2)} per call.</dd>
        </div>
        <div class="faq-item">
          <dt>What happens if I cancel my plan?</dt>
          <dd>Your API key loses paid access immediately. You can still use the free tier for <strong>check_endpoint</strong>, <strong>inspect_security_headers</strong>, <strong>list_resources</strong>, and up to 5 <strong>verify_claim</strong> calls per month, or switch to the agentic pay-per-use path.</dd>
        </div>
        <div class="faq-item">
          <dt>What's the difference between Starter and Team plans?</dt>
          <dd><strong>Starter</strong> ($${STARTER_PLAN_MONTHLY_PRICE_USD}/month) gives you individual API-key access, saved monitors, and ${STARTER_MONTHLY_LIMIT.toLocaleString()} verifications. <strong>Team</strong> ($${TEAM_PLAN_MONTHLY_PRICE_USD}/month) gives you shared monitor workflows, change reports, and ${PRO_MONTHLY_LIMIT.toLocaleString()} requests. Both include all paid tools with unlimited <strong>verify_claim</strong> calls.</dd>
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
      try {
        const stripe = env.STRIPE_SECRET_KEY;
        const plan = url.searchParams.get("plan");
        
        // Select price ID based on plan
        let stripePriceId: string;
        let quota: number;
        if (plan === "starter") {
          stripePriceId = env.STRIPE_STARTER_PRICE_ID || DEFAULT_STRIPE_STARTER_PRICE_ID;
          quota = STARTER_MONTHLY_LIMIT;
        } else if (plan === "team") {
          stripePriceId = env.STRIPE_TEAM_PRICE_ID || DEFAULT_STRIPE_TEAM_PRICE_ID;
          quota = PRO_MONTHLY_LIMIT;
        } else {
          // Default to Team plan for backwards compatibility
          stripePriceId = env.STRIPE_PRICE_ID || env.STRIPE_TEAM_PRICE_ID || DEFAULT_STRIPE_TEAM_PRICE_ID;
          quota = PRO_MONTHLY_LIMIT;
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
            "success_url": `${url.origin}/api/success?session_id={CHECKOUT_SESSION_ID}&plan=${plan || 'team'}`,
            "cancel_url": `${url.origin}/pricing`,
            "metadata[plan]": plan || "team",
            "metadata[quota]": String(quota),
          }),
        });

        const session = await checkoutResponse.json() as { id: string; url: string };
        
        return Response.redirect(session.url, 303);
      } catch (e) {
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
      const sessionId = url.searchParams.get("session_id");
      const plan = url.searchParams.get("plan"); // 'starter' or 'team'
      if (!sessionId) {
        return new Response("Missing session_id", { status: 400 });
      }

      try {
        // Retrieve session from Stripe
        const sessionResponse = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
          headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        
        const session = await sessionResponse.json() as { 
          customer: string;
          customer_details?: { email?: string };
          subscription: string;
          metadata?: { plan?: string; quota?: string };
        };
        
        // Determine quota based on plan from metadata or query param
        const effectivePlan = session.metadata?.plan || plan || "team";
        const quota = effectivePlan === "starter" ? STARTER_MONTHLY_LIMIT : PRO_MONTHLY_LIMIT;
        
        // Check if API key already exists for this customer
        const existingKeysList = await env.API_KEYS.list({ prefix: "gt_live_" });
        let apiKey: string | null = null;
        let existingKeyRecord: ApiKeyRecord | null = null;
        
        for (const key of existingKeysList.keys) {
          const data = await getApiKeyRecord(env.API_KEYS, key.name);
          if (data?.stripeCustomerId === session.customer) {
            apiKey = key.name;
            existingKeyRecord = data;
            break;
          }
        }
        
        // If no existing key, generate new one
        if (!apiKey) {
          apiKey = generateApiKey();
        }

        await saveApiKeyRecord(env.API_KEYS, apiKey, {
          ...existingKeyRecord,
          active: true,
          billingActive: true,
          subscriptionStatus: "active",
          monthlyQuota: quota,
          email: session.customer_details?.email || existingKeyRecord?.email || "unknown",
          stripeCustomerId: session.customer,
          subscriptionId: session.subscription,
          createdAt: existingKeyRecord?.createdAt || new Date().toISOString(),
          cancelledAt: undefined,
          reactivatedAt: existingKeyRecord ? new Date().toISOString() : undefined,
        });

        return new Response(
          `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Ground Truth Team!</title>
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
      max-width: 700px; 
      width: 100%;
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      padding: 40px;
      text-align: center;
    }
    h1 { color: #667eea; margin-bottom: 20px; font-size: 2rem; }
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
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="success-icon">🎉</div>
    <h1>Welcome to Ground Truth!</h1>
    <p>Your ${effectivePlan === 'starter' ? 'Starter' : 'Team'} subscription is active. Here's your API key:</p>
    
    <div class="api-key-box" id="apiKeyBox">
      ${apiKey}
    </div>
    <button class="copy-btn" onclick="copyApiKey()">📋 Copy API Key</button>
    
    <div class="instructions">
      <h3>How to Use Your API Key</h3>
      <p>Direct MCP over HTTP is session-based. Initialize once, then send your API key on tool calls:</p>
      <pre>X-API-Key: ${apiKey}</pre>
      <p style="margin-top: 15px;">Monthly quota: ${quota.toLocaleString()} tool requests (${effectivePlan === 'starter' ? 'Starter' : 'Team'} plan).</p>
      
      <p style="margin-top: 15px;">Example with curl:</p>
      <pre>SESSION_ID="$(curl -i -s -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ground-truth-success","version":"1.0.0"}},"id":0}' | tr -d '\\r' | awk '/^mcp-session-id:/ {print $2}')"

curl -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Mcp-Session-Id: $SESSION_ID" \\
  -H "X-API-Key: ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"estimate_market","arguments":{"query":"mcp server"}},"id":1}'</pre>
      
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
      const signature = request.headers.get("stripe-signature");
      if (!signature) {
        return new Response("Missing signature", { status: 400 });
      }

      try {
        const body = await request.text();
        
        // Verify webhook signature (simplified - production should use proper HMAC verification)
        // For now, we'll just parse the event
        const event = JSON.parse(body) as {
          type: string;
          data: {
            object: Record<string, unknown>;
          };
        };

        if (event.type === "checkout.session.completed") {
          // Already handled in /api/success, but we can log here
          console.log("Checkout completed:", event.data.object.customer);
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

        const normalizedUrl = normalizeHttpUrlInput(rawUrl);
        if (!normalizedUrl) {
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
          try {
            const resp = await fetch(normalizedUrl, { headers: { "User-Agent": "GroundTruth/0.4" } });
            const sample = (await resp.text()).slice(0, 600);
            return jsonResponse({
              tool: "check_endpoint",
              tier: "free",
              ...(normalizedUrl !== rawUrl ? { inputUrl: rawUrl } : {}),
              url: normalizedUrl,
              accessible: resp.ok,
              status: resp.status,
              contentType: resp.headers.get("content-type"),
              responseTimeMs: Date.now() - start,
              authRequired: resp.status === 401 || resp.status === 403,
              rateLimited: resp.status === 429,
              sampleResponse: sample,
            });
          } catch (e) {
            return jsonResponse({
              tool: "check_endpoint",
              tier: "free",
              url: normalizedUrl,
              accessible: false,
              error: e instanceof Error ? e.message : String(e),
              responseTimeMs: Date.now() - start,
            });
          }
        }

        // tool === "check_pricing": a free, in-browser taste of a paid tool.
        try {
          const resp = await fetch(normalizedUrl, { headers: { "User-Agent": "GroundTruth/0.4" } });
          const body = await resp.text();
          const signals = extractPricingSignals(body);
          return jsonResponse({
            tool: "check_pricing",
            tier: "paid-preview",
            note: "Free in-browser preview of a paid tool. Pay-per-call via x402 or a team API key when calling it from an agent.",
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
      return new Response(
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="base:app_id" content="69956c02e0d5d2cf831b5fc8" />
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ground Truth - First Tool Call for AI Agents</title>
  <meta name="description" content="🎯 ACTIVATION TEST: Paste 'Use check_endpoint with url=https://example.com' - works instantly, no signup. Primary activation signal for AI agents.">
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
      grid-template-columns: repeat(3, minmax(0, 1fr));
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
      <div class="eyebrow">🎯 Activation Test - Try This First</div>
      <h1>One prompt proves your MCP connection works</h1>
      <p class="sub">PASTE THIS EXACT PROMPT: <strong>"Use check_endpoint with url set to https://example.com"</strong> - works instantly, no signup required. This is your activation signal before paid verification tools.</p>
      <div class="cta-row">
        <a href="#quickstart" class="btn btn-primary">🚀 Activate Now (60 seconds)</a>
        <a href="#mcp-setup" class="btn btn-secondary">MCP Setup Guide</a>
      </div>
      <div class="hero-meta">
        <span>✅ Zero signup/API key</span>
        <span>✅ Copy-paste activation</span>
        <span>✅ Proves MCP connection</span>
      </div>
    </div>

    <section id="quickstart">
      <h2>🎯 Activation Test: 60-Second Copy-Paste Path</h2>
      <p class="section-intro">This is your <strong>activation signal</strong> - if this works, your MCP connection is perfect and you can explore paid tools. If this fails, your MCP client needs troubleshooting first.</p>
      <div class="code-grid">
        <div class="code-card">
          <h3>1. Add the remote MCP server</h3>
          <p>Use this no-key configuration for the free first call.</p>
          <div class="code-block">{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp"
    }
  }
}</div>
        </div>
        <div class="code-card">
          <h3>🚀 2. PASTE THIS EXACT ACTIVATION PROMPT</h3>
          <p>This is your activation test - copy and paste exactly. Success = your MCP works!</p>
          <div class="code-block">🎯 ACTIVATION TEST: Use check_endpoint with url set to https://example.com. Do NOT answer from memory - call the actual tool. Return: url, accessible, status, contentType, responseTimeMs.</div>
        </div>
        <div class="code-card">
          <h3>Example input</h3>
          <p>The client should call this tool with this argument.</p>
          <div class="code-block">{
  "name": "check_endpoint",
  "arguments": {
    "url": "https://example.com"
  }
}</div>
        </div>
        <div class="code-card">
          <h3>Example output shape</h3>
          <p>Response time varies by run.</p>
          <div class="code-block">{
  "url": "https://example.com/",
  "accessible": true,
  "status": 200,
  "contentType": "text/html",
  "responseTimeMs": 120
}</div>
        </div>
      </div>
    </section>

    <section id="what-it-verifies">
      <h2>What Ground Truth verifies</h2>
      <p class="section-intro">Ground Truth helps agents check the facts that are most expensive to get wrong in buying, support, research, and product workflows.</p>
      <div class="card-grid">
        <div class="card verification-card">
          <h3>Verify a pricing claim</h3>
          <p>Pull the live pricing page before your agent quotes a number like "Notion costs $8 per user per month."</p>
          <span class="tool-tag">check_pricing</span>
        </div>
        <div class="card verification-card">
          <h3>Compare vendor pricing pages</h3>
          <p>Scan multiple pricing pages side by side before your agent claims one vendor is cheaper or has a better free tier.</p>
          <span class="tool-tag">compare_pricing_pages</span>
        </div>
        <div class="card verification-card">
          <h3>Assess compliance posture</h3>
          <p>Check trust and security pages for SOC 2, ISO 27001, GDPR, HIPAA, SSO, SCIM, and DPA signals before repeating them.</p>
          <span class="tool-tag">assess_compliance_posture</span>
        </div>
        <div class="card verification-card">
          <h3>Inspect security headers</h3>
          <p>Check public endpoints for HSTS, CSP, frame protections, and related browser-facing security headers.</p>
          <span class="tool-tag">inspect_security_headers</span>
        </div>
        <div class="card verification-card">
          <h3>Validate an API endpoint</h3>
          <p>Confirm the URL exists, responds, and looks real before recommending it to a user or team.</p>
          <span class="tool-tag">check_endpoint</span>
        </div>
        <div class="card verification-card">
          <h3>Check whether a competitor exists</h3>
          <p>Search npm or PyPI before your agent says there is no alternative in a category.</p>
          <span class="tool-tag">estimate_market</span>
        </div>
      </div>
    </section>

    <section id="why-verification">
      <h2>Why AI agents need verification</h2>
      <p class="section-intro">Training data does not tell you what changed this week. Ground Truth gives agents a last-mile check before they answer, recommend, or act.</p>
      <div class="card-grid">
        <div class="card">
          <h3>Pricing changes quietly</h3>
          <p>Agents often repeat old prices long after a plan page changed. Live verification catches that drift.</p>
        </div>
        <div class="card">
          <h3>Compliance claims get copied without proof</h3>
          <p>SOC 2, HIPAA, and GDPR claims often get repeated from memory. Ground Truth checks the live public page first.</p>
        </div>
        <div class="card">
          <h3>Security posture is easy to overstate</h3>
          <p>Header-level and trust-page checks help agents ground basic security claims before they reach a buyer or customer.</p>
        </div>
        <div class="card">
          <h3>Competitive claims get invented</h3>
          <p>Agents say "no competitors" or "most popular" without checking the current market. Registry data gives them a way to prove it.</p>
        </div>
      </div>
    </section>

    <section id="workflows">
      <h2>Example workflows</h2>
      <p class="section-intro">Use Ground Truth when an answer should be checked before it leaves the model.</p>
      <div class="card-grid">
        <div class="card workflow-card">
          <h3>Pricing claim</h3>
          <p>Before an agent says "Stripe has a free tier," it checks the live pricing page and returns what it found.</p>
        </div>
        <div class="card workflow-card">
          <h3>Competitor existence</h3>
          <p>Before an agent says there is no alternative to Prisma for edge deployments, it searches the registry for real packages.</p>
        </div>
        <div class="card workflow-card">
          <h3>Compliance diligence</h3>
          <p>Before an agent says a vendor is SOC 2 and GDPR-ready, it scans the public trust page for the right signals.</p>
        </div>
        <div class="card workflow-card">
          <h3>Security posture check</h3>
          <p>Before an agent says an app has a solid browser-facing baseline, it checks the live response headers.</p>
        </div>
        <div class="card workflow-card">
          <h3>Pricing comparison</h3>
          <p>Before an agent says one vendor is cheaper, it compares multiple pricing pages side by side.</p>
        </div>
        <div class="card workflow-card">
          <h3>API validation</h3>
          <p>Before an agent recommends an endpoint in docs or support, it confirms the endpoint responds.</p>
        </div>
      </div>
    </section>

    <section id="pricing">
      <h2>Free checks, monitored evidence, and team usage</h2>
      <p class="section-intro">Use the free endpoint and security-header checks to prove the connection. Pay when you need saved monitors, scheduled checks, evidence history, reports, or predictable API-key usage.</p>
      <div class="pricing-grid">
        <div class="plan">
          <div class="label">Free</div>
          <h3>Endpoint checks</h3>
          <div class="price">$0</div>
          <p>Free tier includes limited monthly endpoint and security-header checks.</p>
          <ul>
            <li><code>check_endpoint</code></li>
            <li><code>inspect_security_headers</code></li>
            <li>100 requests per calendar month</li>
            <li>No API key required for free checks</li>
          </ul>
        </div>
        <div class="plan pro">
          <div class="label">Agentic</div>
          <h3>Pay per tool call</h3>
          <div class="price">From $0.01<span>/call</span></div>
          <p>Useful for autonomous agents, MCP clients with x402, or an xpay proxy before you need persistent monitor history.</p>
          <ul>
            <li>Per-tool USDC pricing</li>
            <li>No monthly commitment</li>
            <li>Works well for variable workloads</li>
            <li>Includes pricing, compliance, security, market, and hypothesis tools</li>
          </ul>
        </div>
        <div class="plan">
          <div class="label">Team</div>
          <h3>Team monitor plan</h3>
          <div class="price">$${TEAM_PLAN_MONTHLY_PRICE_USD}<span>/month</span></div>
          <p>Best for internal teams that want saved monitors, change reports, predictable spend, shared access, and a familiar API-key workflow.</p>
          <ul>
            <li>Requires <code>X-API-Key</code></li>
            <li>${PRO_MONTHLY_LIMIT.toLocaleString()} requests per calendar month by default</li>
            <li>Usage tracked per API key and tool</li>
            <li>Includes all paid verification tools</li>
            <li>Saved monitors and generated change reports</li>
          </ul>
        </div>
      </div>
      <div class="link-row">
        <a href="/pricing" class="btn btn-primary">See All Pricing</a>
        <a href="#quickstart" class="btn btn-secondary">Try The Free Check</a>
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
      <p class="mcp-note"><strong>MCP</strong> stands for Model Context Protocol. Ground Truth works as a direct MCP server for team API-key access, and its paid tools also advertise x402 pricing metadata for agentic pay-per-use or an xpay proxy flow.</p>
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
      <p class="mcp-note" style="margin-top: 18px;">If you want turnkey pay-per-tool billing for clients that do not natively handle x402 yet, register this server URL with xpay and share the resulting proxy URL instead.</p>
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
      <p>Built on Cloudflare Workers &middot; <a href="/pricing">Pricing</a> &middot; <a href="/stats">Stats</a> &middot; <a href="https://smithery.ai/servers/anishdasmail/groundtruth">Smithery</a></p>
      <p style="margin-top: 8px;">Made by <a href="https://github.com/anish632">Anish Das</a></p>
    </div>
  </div>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // ───────────────────────────────────────────────
    // Stats endpoint
    // ───────────────────────────────────────────────
    if (url.pathname === "/stats") {
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
    ctx.waitUntil(
      stub.fetch(new Request("https://internal/run-due-monitors", { method: "POST" })).catch(() => {}),
    );
  },
};
