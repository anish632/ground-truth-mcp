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
}

// --- Cache types ---
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHEABLE_BODY_BYTES = 512 * 1024;
const PAID_RESULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// --- Remote Telemetry Config ---
const TELEMETRY_ENABLED = workerProcess?.env?.GROUND_TRUTH_TELEMETRY !== "false";
const SERVER_VERSION = "0.4.0";

// --- Free tier tools ---
const FREE_TOOLS = ["check_endpoint"];
const FREE_MONTHLY_LIMIT = 100;
const PRO_MONTHLY_LIMIT = 5000;
const TEAM_PLAN_MONTHLY_PRICE_USD = 9;
const DEFAULT_STRIPE_PRICE_ID = "price_1TD5jiKOR3CPCI6H5nBr8KV8";
const XPAY_UPSTREAM_HEADER = "X-Ground-Truth-Xpay-Secret";
const PUBLIC_APP_ORIGIN = "https://ground-truth-mcp.anishdasmail.workers.dev";
const SERVER_CARD_ICON_PATH = "/icon.svg";
const SERVER_CARD_DESCRIPTION =
  "Live verification tools for AI agents: endpoint checks, pricing analysis, " +
  "security headers, compliance signals, claim checks, and evidence-backed " +
  "competitive research against public web data.";

const AGENTIC_TOOL_PRICES_USD = {
  estimate_market: 0.01,
  check_pricing: 0.02,
  inspect_security_headers: 0.02,
  compare_competitors: 0.03,
  compare_pricing_pages: 0.04,
  verify_claim: 0.05,
  test_hypothesis: 0.05,
  assess_compliance_posture: 0.05,
} as const;

const PAID_TOOLS = Object.keys(AGENTIC_TOOL_PRICES_USD);
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
    title: "Endpoint Reachability Check",
    description:
      "Perform one live, unauthenticated fetch against a public URL or API " +
      "endpoint and report status, content type, timing, and likely auth or " +
      "rate-limit signals.",
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
          description: "First 1,000 characters of the response body for quick inspection.",
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
      "Search npm or PyPI to estimate how crowded a package category is " +
      "before you claim that a market is empty, niche, or competitive.",
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
      "Fetch a public pricing page and extract first-pass pricing signals " +
      "before you quote plan costs, free tiers, or plan names.",
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
      "Fetch a public URL and inspect security-relevant response headers " +
      "before you claim that a product or endpoint has a strong browser-facing baseline.",
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
      "Compare two to five public pricing pages side by side before you " +
      "make competitive pricing or packaging claims.",
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
              url: { type: "string" },
              cached: { type: "boolean" },
              pricesFound: { type: "array", items: { type: "string" } },
              plansDetected: { type: "array", items: { type: "string" } },
              hasFreeOption: { type: "boolean" },
              hasFreeTrial: { type: "boolean" },
              pageLength: { type: "integer" },
              error: { type: "string" },
            },
            required: ["name", "url"],
          },
        },
        summary: {
          type: "object",
          additionalProperties: false,
          description: "Aggregate counts across all compared pricing pages.",
          properties: {
            pagesCompared: { type: "integer" },
            pagesWithVisiblePrices: { type: "integer" },
            pagesWithFreeOption: { type: "integer" },
            pagesWithFreeTrial: { type: "integer" },
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
      "Compare two or more exact package names side by side using live npm " +
      "or PyPI metadata.",
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
      "Check whether a factual claim is supported by a specific set of " +
      "public evidence URLs that you already have.",
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
      "Scan a public security, trust, compliance, or legal page for common " +
      "enterprise buying signals before you claim a vendor supports a particular posture.",
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
            soc2: { type: "boolean" },
            iso27001: { type: "boolean" },
            gdpr: { type: "boolean" },
            hipaa: { type: "boolean" },
            dpa: { type: "boolean" },
            subprocessorList: { type: "boolean" },
            sso: { type: "boolean" },
            scim: { type: "boolean" },
            encryption: { type: "boolean" },
            dataResidency: { type: "boolean" },
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
      "Run a small verification plan made of concrete live checks and " +
      "summarize whether a hypothesis is supported.",
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
  subjectType: "free" | "pro";
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

function structuredToolResult<T extends Record<string, unknown>>(structuredContent: T) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(structuredContent, null, 2),
    }],
    structuredContent,
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

function getUsageStorageKey(subjectType: "free" | "pro", month: string, subjectId: string): string {
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
  subjectType: "free" | "pro",
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
async function logRemoteUsage(tool: string, success: boolean): Promise<void> {
  if (!TELEMETRY_ENABLED) return;
  
  try {
    const platform = workerProcess?.platform ?? "unknown";
    
    // Non-blocking fire-and-forget POST to Neon via HTTP proxy
    // Use a lightweight edge function to insert into Postgres
    fetch("https://ground-truth-dashboard.vercel.app/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool_name: tool,
        success,
        server_version: SERVER_VERSION,
        os_platform: platform,
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
            "First 1,000 characters of the response body for quick inspection.",
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
    // PAID $0.02: inspect_security_headers
    // ───────────────────────────────────────────────
    registerPaidTool(
      "inspect_security_headers",
      AGENTIC_TOOL_PRICES_USD.inspect_security_headers,
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
            name: z.string(),
            url: z.string(),
            cached: z.boolean().optional(),
            pricesFound: z.array(z.string()).optional(),
            plansDetected: z.array(z.string()).optional(),
            hasFreeOption: z.boolean().optional(),
            hasFreeTrial: z.boolean().optional(),
            pageLength: z.number().int().nonnegative().optional(),
            error: z.string().optional(),
          })).describe(
            "Per-page pricing signals returned in input order.",
          ),
          summary: z.object({
            pagesCompared: z.number().int().nonnegative(),
            pagesWithVisiblePrices: z.number().int().nonnegative(),
            pagesWithFreeOption: z.number().int().nonnegative(),
            pagesWithFreeTrial: z.number().int().nonnegative(),
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
            soc2: z.boolean(),
            iso27001: z.boolean(),
            gdpr: z.boolean(),
            hipaa: z.boolean(),
            dpa: z.boolean(),
            subprocessorList: z.boolean(),
            sso: z.boolean(),
            scim: z.boolean(),
            encryption: z.boolean(),
            dataResidency: z.boolean(),
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
                  "Public URL to probe, for example https://api.github.com.",
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
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const isPrimaryMcpPath = url.pathname === "/mcp";
    const isTrustedXpayPathRequest = hasTrustedXpayPath(url);
    const isTrustedXpayQueryRequest = hasTrustedXpayQuery(url);
    const servedMcpPath = isTrustedXpayPathRequest ? url.pathname : "/mcp";

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
            const usageKey = getUsageStorageKey("free", month, subjectId);
            const usage = await checkUsageLimit(env.API_KEYS, usageKey, FREE_MONTHLY_LIMIT);

            if (!usage.allowed) {
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

            await incrementUsage(env.API_KEYS, usageKey, "free", subjectId, month, toolName);
          }
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
            upstreamMode: "xpay_proxy",
            upstreamAuthHeader: XPAY_UPSTREAM_HEADER,
          }
          : {
            description: SERVER_CARD_DESCRIPTION,
            homepage,
            website: homepage,
            icon,
            pricing: `${publicOrigin}/pricing`,
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
  <title>Ground Truth — Pricing</title>
  <meta name="description" content="Verification layer for AI agents with free endpoint checks, agentic pay-per-use, and a team subscription for higher-volume verification.">
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
      <h1>Choose free checks, agentic pay-per-use, or a team plan.</h1>
      <p class="sub">Ground Truth gives AI agents live verification tools. Start with free endpoint checks, pay per tool call with x402-compatible clients, or use a team API key for broader monthly usage.</p>
    </div>

    <div class="plans">
      <div class="plan">
        <h2>Free</h2>
        <div class="price">$0</div>
        <p class="desc">Free tier includes limited monthly endpoint checks.</p>
        <ul>
          <li>Only <strong>check_endpoint</strong></li>
          <li>100 requests per calendar month</li>
          <li>Tracked by Cloudflare client IP in production, or an anonymous client identifier in local/dev</li>
          <li>No API key required</li>
        </ul>
        <a href="/mcp" class="btn btn-outline">Try Free Endpoint Check</a>
      </div>

      <div class="plan plan-pro">
        <h2>Agentic</h2>
        <div class="price">From $0.01<span>/call</span></div>
        <p class="desc">Use x402-compatible MCP clients or an xpay proxy to pay only when an agent runs a paid verification tool.</p>
        <ul>
          <li>No monthly subscription required</li>
          <li>Per-tool USDC pricing via x402</li>
          <li>Works with x402-aware clients or an xpay proxy</li>
          <li>Best for autonomous agents and variable workloads</li>
        </ul>
        <div class="price-list">
          <strong>Example tool prices</strong><br>
          <code>estimate_market</code> $${AGENTIC_TOOL_PRICES_USD.estimate_market.toFixed(2)}<br>
          <code>check_pricing</code> $${AGENTIC_TOOL_PRICES_USD.check_pricing.toFixed(2)}<br>
          <code>inspect_security_headers</code> $${AGENTIC_TOOL_PRICES_USD.inspect_security_headers.toFixed(2)}<br>
          <code>compare_pricing_pages</code> $${AGENTIC_TOOL_PRICES_USD.compare_pricing_pages.toFixed(2)}<br>
          <code>verify_claim</code> $${AGENTIC_TOOL_PRICES_USD.verify_claim.toFixed(2)}
        </div>
        <a href="/#mcp-setup" class="btn btn-outline" style="margin-top: 24px;">See Agentic Setup</a>
      </div>

      <div class="plan">
        <h2>Team</h2>
        <div class="price">$${TEAM_PLAN_MONTHLY_PRICE_USD}<span>/month</span></div>
        <p class="desc">Use a team API key for broader verification, predictable spend, and shared internal usage.</p>
        <ul>
          <li>Requires <strong>X-API-Key</strong></li>
          <li>Billing must be active</li>
          <li>${PRO_MONTHLY_LIMIT.toLocaleString()} requests per calendar month by default</li>
          <li>Usage tracked per API key and tool</li>
          <li>Includes pricing, compliance, market, competitor, and hypothesis tools</li>
        </ul>
        <form action="/api/checkout" method="POST">
          <button type="submit" class="btn btn-primary">Subscribe Team Plan</button>
        </form>
      </div>
    </div>

    <div class="note">
      <strong>How to choose:</strong> Free is for lightweight endpoint checks. <strong>Agentic</strong> is for pay-per-tool-call automation with x402 or xpay. <strong>Team</strong> is the predictable monthly plan for people and internal tools that prefer API-key billing.
    </div>

    <div class="faq">
      <h2>Questions</h2>
      <dl>
        <div class="faq-item">
          <dt>What is Ground Truth?</dt>
          <dd>Ground Truth is a verification layer for AI agents. Instead of trusting a model to guess, you give it a way to check live pricing, validate endpoints, compare competitors, and confirm claims before it responds.</dd>
        </div>
        <div class="faq-item">
          <dt>What is MCP?</dt>
          <dd>Model Context Protocol is the standard that lets AI apps call external tools. Ground Truth plugs into Claude Desktop, Cursor, and other MCP clients so your agent can verify before it acts.</dd>
        </div>
        <div class="faq-item">
          <dt>Do I need an API key for the free check?</dt>
          <dd>No. <strong>check_endpoint</strong> works immediately with no signup, up to 100 requests per calendar month.</dd>
        </div>
        <div class="faq-item">
          <dt>How do agentic payments work?</dt>
          <dd>Paid tools advertise x402 pricing metadata. An x402-aware client, or an xpay proxy in front of this server, can pay per tool call automatically using USDC.</dd>
        </div>
        <div class="faq-item">
          <dt>What happens if I cancel the team plan?</dt>
          <dd>Your team API key loses paid access immediately. You can still use the free tier for <strong>check_endpoint</strong> or switch to the agentic pay-per-use path.</dd>
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
        const stripePriceId = env.STRIPE_PRICE_ID || DEFAULT_STRIPE_PRICE_ID;
        
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
            "success_url": `${url.origin}/api/success?session_id={CHECKOUT_SESSION_ID}`,
            "cancel_url": `${url.origin}/pricing`,
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
        };
        
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
          monthlyQuota: existingKeyRecord?.monthlyQuota ?? PRO_MONTHLY_LIMIT,
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
    <h1>Welcome to Ground Truth Team!</h1>
    <p>Your team subscription is active. Here's your API key:</p>
    
    <div class="api-key-box" id="apiKeyBox">
      ${apiKey}
    </div>
    <button class="copy-btn" onclick="copyApiKey()">📋 Copy API Key</button>
    
    <div class="instructions">
      <h3>How to Use Your API Key</h3>
      <p>Direct MCP over HTTP is session-based. Initialize once, then send your API key on tool calls:</p>
      <pre>X-API-Key: ${apiKey}</pre>
      <p style="margin-top: 15px;">Default monthly quota: ${PRO_MONTHLY_LIMIT.toLocaleString()} tool requests.</p>
      
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
  <title>Ground Truth — Verification Layer for AI Agents</title>
  <meta name="description" content="Verification layer for AI agents with free endpoint checks, agentic pay-per-use, and a team subscription for pricing, compliance, and competitive verification.">
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
      <div class="eyebrow">Verification Layer For AI Agents</div>
      <h1>Verify before your agents act.</h1>
      <p class="sub">Ground Truth gives agents live verification tools for pricing, compliance, security posture, vendor diligence, and market checks. Use the free endpoint check, pay per tool call with x402-compatible clients, or use a team API key for predictable monthly access.</p>
      <div class="cta-row">
        <a href="/pricing" class="btn btn-primary">View Pricing</a>
        <a href="#mcp-setup" class="btn btn-secondary">See MCP Setup</a>
      </div>
      <div class="hero-meta">
        <span>Live data checks</span>
        <span>Agentic pay-per-use or team plan</span>
        <span>Cloudflare Workers</span>
      </div>
    </div>

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
      <h2>Free, Agentic, and Team</h2>
      <p class="section-intro">Use the free endpoint check, pay per tool call with x402-compatible automation, or subscribe to a team plan for predictable monthly usage.</p>
      <div class="pricing-grid">
        <div class="plan">
          <div class="label">Free</div>
          <h3>Endpoint checks</h3>
          <div class="price">$0</div>
          <p>Free tier includes limited monthly endpoint checks.</p>
          <ul>
            <li>Only <code>check_endpoint</code></li>
            <li>100 requests per calendar month</li>
            <li>No API key required for the free check</li>
          </ul>
        </div>
        <div class="plan pro">
          <div class="label">Agentic</div>
          <h3>Pay per tool call</h3>
          <div class="price">From $0.01<span>/call</span></div>
          <p>Ideal for autonomous agents, MCP clients with x402, or an xpay proxy in front of this server.</p>
          <ul>
            <li>Per-tool USDC pricing</li>
            <li>No monthly commitment</li>
            <li>Works well for variable workloads</li>
            <li>Includes pricing, compliance, security, market, and hypothesis tools</li>
          </ul>
        </div>
        <div class="plan">
          <div class="label">Team</div>
          <h3>Monthly API key plan</h3>
          <div class="price">$${TEAM_PLAN_MONTHLY_PRICE_USD}<span>/month</span></div>
          <p>Best for internal teams that want predictable spend, shared access, and a familiar API-key workflow.</p>
          <ul>
            <li>Requires <code>X-API-Key</code></li>
            <li>${PRO_MONTHLY_LIMIT.toLocaleString()} requests per calendar month by default</li>
            <li>Usage tracked per API key and tool</li>
            <li>Includes all paid verification tools</li>
          </ul>
        </div>
      </div>
      <div class="link-row">
        <a href="/pricing" class="btn btn-primary">See All Pricing</a>
        <a href="/mcp" class="btn btn-secondary">Try The Free Check</a>
      </div>
    </section>

    <section id="api-examples">
      <h2>API examples</h2>
      <p class="section-intro">Use Ground Truth directly over HTTP if you want verification in a script, backend, or agent loop.</p>
      <div class="code-grid">
        <div class="code-card">
          <h3>Direct API <code>curl</code> call</h3>
          <p>Initialize the MCP session, then verify a pricing claim against a live pricing page.</p>
          <div class="code-block">SESSION_ID="$(curl -i -s -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ground-truth-example","version":"1.0.0"}},"id":0}' | tr -d '\\r' | awk '/^mcp-session-id:/ {print $2}')"

curl -X POST https://ground-truth-mcp.anishdasmail.workers.dev/mcp \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Content-Type: application/json" \\
  -H "Mcp-Session-Id: $SESSION_ID" \\
  -H "X-API-Key: $GROUND_TRUTH_API_KEY" \\
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
  }'</div>
        </div>
        <div class="code-card">
          <h3>JavaScript <code>fetch</code> example</h3>
          <p>Compare package popularity from code.</p>
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
          <p>Add Ground Truth to <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>.</p>
          <pre>{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp",
      "headers": {
        "X-API-Key": "gt_live_your_key_here"
      }
    }
  }
}</pre>
        </div>
        <div class="setup-card">
          <h3>Cursor</h3>
          <p>Add Ground Truth to <code>.cursor/mcp.json</code> in your project or <code>~/.cursor/mcp.json</code> globally.</p>
          <pre>{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp",
      "headers": {
        "X-API-Key": "gt_live_your_key_here"
      }
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

    return new Response("Not found", { status: 404 });
  },
};
