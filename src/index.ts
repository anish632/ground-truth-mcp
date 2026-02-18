import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withX402, type X402Config } from "agents/x402";
import { z } from "zod";

// --- Cache types ---
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
  const resp = await fetch(url, { headers: { "User-Agent": "GroundTruth/0.2" } });
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
    const sql = this.sql;

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
            headers: { "User-Agent": "GroundTruth/0.2" },
          });
          const elapsed = Date.now() - start;
          const body = await resp.text();
          const sample = body.slice(0, 1000);

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
                  headers: { "User-Agent": "GroundTruth/0.2" },
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
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return GroundTruthMCP.serve("/mcp").fetch(request, env, ctx);
    }

    // Root page with base.dev verification meta tag
    if (url.pathname === "/") {
      return new Response(
        `<!DOCTYPE html>
<html>
<head>
  <meta name="base:app_id" content="69956c02e0d5d2cf831b5fc8" />
  <title>Ground Truth MCP</title>
</head>
<body>
  <h1>Ground Truth MCP Server</h1>
  <p>MCP endpoint: <a href="/mcp">/mcp</a></p>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};
