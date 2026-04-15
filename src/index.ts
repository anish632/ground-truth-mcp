import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withX402, type X402Config } from "agents/x402";
import { z } from "zod";

// --- Environment bindings ---
interface Env {
  GROUND_TRUTH_MCP: DurableObjectNamespace;
  API_KEYS: KVNamespace;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

// --- Cache types ---
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// --- Remote Telemetry Config ---
const TELEMETRY_ENABLED = process.env.GROUND_TRUTH_TELEMETRY !== "false";
const NEON_DB_URL = "postgresql://neondb_owner:npg_Eekbuc84GiTW@ep-fragrant-dawn-ai5pgip6-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require";
const SERVER_VERSION = "0.3.0";

// --- Free tier tools ---
const FREE_TOOLS = ["check_endpoint"];

// --- API Key helpers ---
function generateApiKey(): string {
  const chars = "0123456789abcdef";
  let key = "gt_live_";
  for (let i = 0; i < 32; i++) {
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

async function validateApiKey(kv: KVNamespace, apiKey: string): Promise<boolean> {
  try {
    const data = await kv.get(apiKey, "json");
    if (!data) return false;
    const keyData = data as { active: boolean; email: string; stripeCustomerId: string; createdAt: string };
    return keyData.active === true;
  } catch {
    return false;
  }
}

// --- Remote telemetry logger ---
async function logRemoteUsage(tool: string, success: boolean): Promise<void> {
  if (!TELEMETRY_ENABLED) return;
  
  try {
    const platform = typeof process !== 'undefined' ? process.platform : 'unknown';
    
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
  const ts = Date.now();
  sql`INSERT OR REPLACE INTO cache (key, data, ts) VALUES (${key}, ${data}, ${ts})`;
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
  server = withX402(
    new McpServer({ name: "ground-truth", version: "0.3.0" }),
    {
      network: "base-sepolia",
      recipient: "0xB04BD750b67e7b00c95eAC8995eb9F8441309196",
      facilitator: { url: "https://x402.org/facilitator" },
    } satisfies X402Config,
  );

  async init() {
    // Initialize cache table
    this.sql`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, data TEXT, ts INTEGER)`;
    // Initialize usage log table
    this.sql`CREATE TABLE IF NOT EXISTS usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT, ts INTEGER, success INTEGER)`;
    const sql = this.sql.bind(this) as SqlTagFn;
    const logUsage = (tool: string, success: boolean) => {
      try { 
        // Local SQLite logging
        this.sql`INSERT INTO usage_log (tool, ts, success) VALUES (${tool}, ${Date.now()}, ${success ? 1 : 0})`; 
        
        // Remote telemetry (non-blocking)
        logRemoteUsage(tool, success);
      } catch (_) {}
    };

    // ───────────────────────────────────────────────
    // FREE: check_endpoint
    // ───────────────────────────────────────────────
    this.server.tool(
      "check_endpoint",
      "Probe a URL/API endpoint and report: status, auth requirements, " +
      "response time, content type, rate limit headers, and a sample of " +
      "the response structure. Use this to verify whether an API actually " +
      "exists and what it returns before recommending it.",
      {
        url: z.string().url().describe("The URL to probe"),
      },
      async ({ url }) => {
        const start = Date.now();
        try {
          const resp = await fetch(url, {
            headers: { "User-Agent": "GroundTruth/0.3" },
          });
          const elapsed = Date.now() - start;
          const body = await resp.text();
          const sample = body.slice(0, 1000);
          logUsage("check_endpoint", true);

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                url,
                accessible: resp.ok,
                status: resp.status,
                contentType: resp.headers.get("content-type"),
                responseTimeMs: elapsed,
                authRequired: resp.status === 401 || resp.status === 403,
                rateLimited: resp.status === 429,
                sampleResponse: sample,
              }, null, 2),
            }],
          };
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          logUsage("check_endpoint", false);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                url,
                accessible: false,
                error: message,
                responseTimeMs: Date.now() - start,
              }, null, 2),
            }],
          };
        }
      }
    );

    // ───────────────────────────────────────────────
    // PAID $0.01: estimate_market (npm + PyPI)
    // ───────────────────────────────────────────────
    this.server.paidTool(
      "estimate_market",
      "Count how many packages/servers exist in a space. " +
      "Searches npm or PyPI and returns: total count, " +
      "top results with versions and activity signals. " +
      "Results are cached for 5 minutes.",
      0.01,
      {
        query: z.string().describe("Search query (e.g. 'mcp memory server')"),
        registry: z.enum(["npm", "pypi"]).default("npm").describe("Which registry to search"),
      },
      {},
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
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                query, registry,
                totalResults: data.total,
                topResults: results,
              }, null, 2),
            }],
          };
        }

        if (registry === "pypi") {
          const data = await searchPyPI(sql, query);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                query, registry,
                totalResults: data.total,
                topResults: data.results,
              }, null, 2),
            }],
          };
        }

        return { content: [{ type: "text" as const, text: "Registry not supported" }] };
      }
    );

    // ───────────────────────────────────────────────
    // PAID $0.02: check_pricing
    // ───────────────────────────────────────────────
    this.server.paidTool(
      "check_pricing",
      "Fetch a product or service's pricing page and extract pricing signals. " +
      "Returns detected price points, plan names, and whether free tiers exist. " +
      "Use this to verify pricing claims before presenting them.",
      0.02,
      {
        url: z.string().url().describe("URL of the pricing page to analyze"),
      },
      {},
      async ({ url }) => {
        try {
          const { body, fromCache } = await cachedFetch(sql, url);
          // Extract pricing signals from page content
          const priceRegex = /\$\d[\d,]*(?:\.\d{2})?(?:\s*\/\s*(?:mo(?:nth)?|yr|year|user|seat|req|call|token))?/gi;
          const prices = [...new Set(body.match(priceRegex) || [])].slice(0, 20);
          const planRegex = /(?:free|starter|basic|pro|premium|enterprise|business|team|hobby|growth|scale)\s*(?:plan|tier)?/gi;
          const plans = [...new Set((body.match(planRegex) || []).map(p => p.trim().toLowerCase()))];
          const hasFree = /free\s*(?:plan|tier|forever|trial)|(?:\$0|0\.00)/i.test(body);
          const hasFreeTrial = /free\s*trial|try\s*(?:it\s*)?free|start\s*free/i.test(body);

          logUsage("check_pricing", true);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                url,
                cached: fromCache,
                pricesFound: prices,
                plansDetected: plans,
                hasFreeOption: hasFree,
                hasFreeTrial: hasFreeTrial,
                pageLength: body.length,
              }, null, 2),
            }],
          };
        } catch (e: unknown) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ url, error: e instanceof Error ? e.message : String(e) }, null, 2),
            }],
          };
        }
      }
    );

    // ───────────────────────────────────────────────
    // PAID $0.03: compare_competitors
    // ───────────────────────────────────────────────
    this.server.paidTool(
      "compare_competitors",
      "Compare two or more npm/PyPI packages side-by-side. " +
      "Returns version, description, and npm score for each. " +
      "Use this to validate 'X is better than Y' claims.",
      0.03,
      {
        packages: z.array(z.string()).min(2).max(10)
          .describe("Package names to compare (e.g. ['express', 'fastify', 'koa'])"),
        registry: z.enum(["npm", "pypi"]).default("npm"),
      },
      {},
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
          return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ packages, registry, comparisons }, null, 2),
          }],
        };
      }
    );

    // ───────────────────────────────────────────────
    // PAID $0.05: verify_claim
    // ───────────────────────────────────────────────
    this.server.paidTool(
      "verify_claim",
      "Cross-reference a factual claim against multiple live sources. " +
      "Provide the claim and a list of URLs to check. Returns whether each " +
      "source supports or contradicts the claim based on substring matching. " +
      "Use this to fact-check before presenting information.",
      0.05,
      {
        claim: z.string().describe("The factual claim to verify"),
        evidence_urls: z.array(z.string().url()).min(1).max(10)
          .describe("URLs to cross-reference against"),
        keywords: z.array(z.string()).min(1).max(20)
          .describe("Keywords that should appear if the claim is true"),
      },
      {},
      async ({ claim, evidence_urls, keywords }) => {
        const sources = [];
        for (const url of evidence_urls) {
          try {
            const { body, fromCache } = await cachedFetch(sql, url);
            const bodyLower = body.toLowerCase();
            const keywordHits = keywords.filter(kw => bodyLower.includes(kw.toLowerCase()));
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
          return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
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
            }, null, 2),
          }],
        };
      }
    );

    // ───────────────────────────────────────────────
    // PAID $0.05: test_hypothesis
    // ───────────────────────────────────────────────
    this.server.paidTool(
      "test_hypothesis",
      "Test a specific factual claim against live data. " +
      "Give it a hypothesis and a list of tests to run. " +
      "Returns pass/fail for each test and an overall verdict. " +
      "Use this to grade your own research before presenting it.",
      0.05,
      {
        hypothesis: z.string().describe("The claim to test"),
        tests: z.array(z.object({
          description: z.string(),
          type: z.enum(["endpoint_exists", "npm_count_above", "npm_count_below", "response_contains"]),
          url: z.string().optional(),
          query: z.string().optional(),
          threshold: z.number().optional(),
          substring: z.string().optional(),
        })),
      },
      {},
      async ({ hypothesis, tests }) => {
        const results = [];
        for (const test of tests) {
          let passed: boolean | null = null;
          let actual: string | number | null = null;

          try {
            switch (test.type) {
              case "endpoint_exists": {
                if (!test.url) { passed = false; actual = "no url provided"; break; }
                const resp = await fetch(test.url, {
                  headers: { "User-Agent": "GroundTruth/0.3" },
                });
                passed = resp.ok;
                actual = `status ${resp.status}`;
                break;
              }
              case "npm_count_above":
              case "npm_count_below": {
                if (!test.query) { passed = false; actual = "no query provided"; break; }
                const data = await searchNpm(sql, test.query, 1);
                const total = data.total ?? 0;
                actual = total;
                passed = test.type === "npm_count_above"
                  ? total > (test.threshold ?? 0)
                  : total < (test.threshold ?? 0);
                break;
              }
              case "response_contains": {
                if (!test.url) { passed = false; actual = "no url provided"; break; }
                const { body } = await cachedFetch(sql, test.url);
                passed = test.substring ? body.includes(test.substring) : false;
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
          return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              hypothesis,
              tests: results,
              verdict: {
                passed: passedCount,
                failed: results.length - passedCount,
                summary: passedCount === results.length ? "SUPPORTED" :
                         passedCount === 0 ? "REFUTED" : "PARTIALLY SUPPORTED",
              },
            }, null, 2),
          }],
        };
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // ───────────────────────────────────────────────
    // MCP endpoint with API key middleware
    // ───────────────────────────────────────────────
    if (url.pathname === "/mcp") {
      const apiKey = request.headers.get("X-API-Key");
      
      // Check if this is a paid tool request (x402 payment header exists)
      const hasX402Payment = request.headers.get("x-402-payment") !== null;
      
      // If no API key and no x402 payment, only allow free tools
      if (!apiKey && !hasX402Payment) {
        // Clone request to inspect MCP call without consuming body
        const clonedReq = request.clone();
        try {
          const body = await clonedReq.json();
          const toolName = body?.params?.name;
          
          // If requesting a paid tool without API key or x402, reject
          if (toolName && !FREE_TOOLS.includes(toolName)) {
            return new Response(
              JSON.stringify({
                error: "Authentication required",
                message: `Tool '${toolName}' requires a valid API key or x402 payment. Get an API key at /pricing`,
                freeTier: FREE_TOOLS,
              }),
              {
                status: 402,
                headers: { "Content-Type": "application/json" },
              }
            );
          }
        } catch {
          // If we can't parse the body, continue to MCP handler
        }
      }
      
      // If API key provided, validate it
      if (apiKey && !hasX402Payment) {
        const isValid = await validateApiKey(env.API_KEYS, apiKey);
        if (!isValid) {
          return new Response(
            JSON.stringify({
              error: "Invalid API key",
              message: "The provided API key is invalid or inactive. Get a new key at /pricing",
            }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      }
      
      // API key is valid or x402 payment present, or it's a free tool - proceed to MCP
      return GroundTruthMCP.serve("/mcp").fetch(request, env, ctx);
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
  <title>Ground Truth MCP - Pricing</title>
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
      max-width: 900px; 
      width: 100%;
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 40px 30px;
      text-align: center;
    }
    .header h1 { font-size: 2.5rem; margin-bottom: 10px; }
    .header p { font-size: 1.1rem; opacity: 0.9; }
    .content { padding: 40px 30px; }
    .pricing-card {
      border: 2px solid #667eea;
      border-radius: 12px;
      padding: 30px;
      margin-bottom: 30px;
      background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
    }
    .pricing-card h2 { color: #667eea; margin-bottom: 15px; font-size: 1.8rem; }
    .price { font-size: 3rem; font-weight: bold; color: #764ba2; margin: 20px 0; }
    .price span { font-size: 1.2rem; font-weight: normal; color: #666; }
    .features { 
      list-style: none;
      margin: 20px 0;
    }
    .features li {
      padding: 10px 0;
      padding-left: 30px;
      position: relative;
      color: #333;
    }
    .features li:before {
      content: "✓";
      position: absolute;
      left: 0;
      color: #667eea;
      font-weight: bold;
      font-size: 1.3rem;
    }
    .cta-button {
      display: inline-block;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 15px 40px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: bold;
      font-size: 1.1rem;
      transition: transform 0.2s, box-shadow 0.2s;
      border: none;
      cursor: pointer;
    }
    .cta-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
    }
    .free-tier {
      background: #f0f4f8;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 30px;
    }
    .free-tier h3 { color: #667eea; margin-bottom: 10px; }
    .free-tier ul { margin-left: 20px; color: #555; }
    .footer {
      text-align: center;
      padding: 20px;
      color: #999;
      font-size: 0.9rem;
    }
    .footer a { color: #667eea; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Ground Truth MCP</h1>
      <p>Let AI agents validate their own claims with real data</p>
    </div>
    <div class="content">
      <div class="free-tier">
        <h3>🎁 Free Tier</h3>
        <ul>
          <li><strong>check_endpoint</strong> - Probe any URL/API endpoint (unlimited, forever free)</li>
        </ul>
      </div>

      <div class="pricing-card">
        <h2>🚀 Pro Plan</h2>
        <div class="price">$9<span>/month</span></div>
        <ul class="features">
          <li>Unlimited calls to all premium tools</li>
          <li><strong>estimate_market</strong> - Count packages in npm/PyPI</li>
          <li><strong>check_pricing</strong> - Extract pricing from any website</li>
          <li><strong>compare_competitors</strong> - Side-by-side package comparison</li>
          <li><strong>verify_claim</strong> - Cross-reference claims with live sources</li>
          <li><strong>test_hypothesis</strong> - Automated fact-checking</li>
          <li>5-minute response caching for faster results</li>
          <li>Cancel anytime, no questions asked</li>
        </ul>
        <form action="/api/checkout" method="POST">
          <button type="submit" class="cta-button">Subscribe Now →</button>
        </form>
      </div>

      <div class="footer">
        <p>Questions? Email <a href="mailto:anishdasmail@gmail.com">anishdasmail@gmail.com</a></p>
        <p style="margin-top: 10px;"><a href="/">← Back to Home</a></p>
      </div>
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
        
        // Create Stripe checkout session
        const checkoutResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${stripe}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            "payment_method_types[0]": "card",
            "line_items[0][price]": "price_1TD5jiKOR3CPCI6H5nBr8KV8",
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
        
        for (const key of existingKeysList.keys) {
          const data = await env.API_KEYS.get(key.name, "json") as { stripeCustomerId: string; apiKey: string } | null;
          if (data?.stripeCustomerId === session.customer) {
            apiKey = data.apiKey || key.name;
            break;
          }
        }
        
        // If no existing key, generate new one
        if (!apiKey) {
          apiKey = generateApiKey();
          await env.API_KEYS.put(apiKey, JSON.stringify({
            active: true,
            email: session.customer_details?.email || "unknown",
            stripeCustomerId: session.customer,
            subscriptionId: session.subscription,
            createdAt: new Date().toISOString(),
          }));
        }

        return new Response(
          `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Ground Truth MCP Pro!</title>
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
    <h1>Welcome to Ground Truth MCP Pro!</h1>
    <p>Your subscription is active. Here's your API key:</p>
    
    <div class="api-key-box" id="apiKeyBox">
      ${apiKey}
    </div>
    <button class="copy-btn" onclick="copyApiKey()">📋 Copy API Key</button>
    
    <div class="instructions">
      <h3>How to Use Your API Key</h3>
      <p>Add this header to all your MCP requests:</p>
      <pre>X-API-Key: ${apiKey}</pre>
      
      <p style="margin-top: 15px;">Example with curl:</p>
      <pre>curl -X POST https://ground-truth-mcp.anish632.workers.dev/mcp \\
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
            object: {
              customer: string;
              subscription: string;
              customer_details?: { email?: string };
            };
          };
        };

        if (event.type === "checkout.session.completed") {
          // Already handled in /api/success, but we can log here
          console.log("Checkout completed:", event.data.object.customer);
        } else if (event.type === "customer.subscription.deleted") {
          // Mark API key as inactive
          const customerId = event.data.object.customer;
          const keysList = await env.API_KEYS.list({ prefix: "gt_live_" });
          
          for (const key of keysList.keys) {
            const data = await env.API_KEYS.get(key.name, "json") as { stripeCustomerId: string } | null;
            if (data?.stripeCustomerId === customerId) {
              await env.API_KEYS.put(key.name, JSON.stringify({
                ...data,
                active: false,
                cancelledAt: new Date().toISOString(),
              }));
              break;
            }
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
  <title>Ground Truth MCP</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container { 
      max-width: 800px; 
      text-align: center;
    }
    h1 { font-size: 3rem; margin-bottom: 20px; }
    p { font-size: 1.2rem; margin-bottom: 30px; opacity: 0.9; }
    .links { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; }
    .link-btn {
      background: white;
      color: #667eea;
      padding: 15px 30px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: bold;
      transition: transform 0.2s, box-shadow 0.2s;
      display: inline-block;
    }
    .link-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(0,0,0,0.2);
    }
    .pricing-link {
      background: #ffd700;
      color: #764ba2;
    }
    .features {
      margin-top: 50px;
      text-align: left;
      background: rgba(255,255,255,0.1);
      padding: 30px;
      border-radius: 12px;
      backdrop-filter: blur(10px);
    }
    .features h2 { margin-bottom: 20px; text-align: center; }
    .features ul { list-style: none; }
    .features li {
      padding: 10px 0;
      padding-left: 30px;
      position: relative;
    }
    .features li:before {
      content: "✓";
      position: absolute;
      left: 0;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Ground Truth MCP Server</h1>
    <p>Let AI agents validate their own claims with real, live data from the web.</p>
    
    <div class="links">
      <a href="/mcp" class="link-btn">MCP Endpoint</a>
      <a href="/pricing" class="link-btn pricing-link">💳 Pricing & API Keys</a>
      <a href="/stats" class="link-btn">📊 Stats</a>
    </div>
    
    <div class="features">
      <h2>🛠 Available Tools</h2>
      <ul>
        <li><strong>check_endpoint</strong> (FREE) - Probe any URL/API endpoint</li>
        <li><strong>estimate_market</strong> ($9/mo) - Count packages in npm/PyPI</li>
        <li><strong>check_pricing</strong> ($9/mo) - Extract pricing from websites</li>
        <li><strong>compare_competitors</strong> ($9/mo) - Side-by-side comparisons</li>
        <li><strong>verify_claim</strong> ($9/mo) - Cross-reference claims</li>
        <li><strong>test_hypothesis</strong> ($9/mo) - Automated fact-checking</li>
      </ul>
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
        const id = env.GROUND_TRUTH_MCP.idFromName("ground-truth");
        const stub = env.GROUND_TRUTH_MCP.get(id);
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
