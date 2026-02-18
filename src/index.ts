import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withX402, type X402Config } from "agents/x402";
import { z } from "zod";

export class GroundTruthMCP extends McpAgent<Env> {
  server = withX402(
    new McpServer({ name: "ground-truth", version: "0.2.0" }),
    {
      network: "base-sepolia",
      recipient: "0xB04BD750b67e7b00c95eAC8995eb9F8441309196",
      facilitator: { url: "https://x402.org/facilitator" },
    } satisfies X402Config,
  );

  async init() {
    // Free tool — let agents try before they buy
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
            headers: { "User-Agent": "GroundTruth/0.1" },
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

    // Paid tool — $0.01 per call
    this.server.paidTool(
      "estimate_market",
      "Count how many packages/servers exist in a space. " +
      "Searches npm, PyPI, or MCP registries and returns: total count, " +
      "top results with version history, last update dates, and activity " +
      "signals. Use this to validate competition claims.",
      0.01,
      {
        query: z.string().describe("Search query (e.g. 'mcp memory server')"),
        registry: z.enum(["npm", "pypi"]).default("npm"),
      },
      {},
      async ({ query, registry }) => {
        if (registry === "npm") {
          const resp = await fetch(
            `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=10`
          );
          const data: { objects?: { package: { name: string; description?: string; version: string }; score?: { final?: number } }[]; total?: number } = await resp.json();
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
        return { content: [{ type: "text" as const, text: "Registry not yet supported" }] };
      }
    );

    // Paid tool — $0.05 per call (more compute-intensive)
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
                  headers: { "User-Agent": "GroundTruth/0.1" },
                });
                passed = resp.ok;
                actual = `status ${resp.status}`;
                break;
              }
              case "npm_count_above":
              case "npm_count_below": {
                if (!test.query) { passed = false; actual = "no query provided"; break; }
                const resp = await fetch(
                  `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(test.query)}&size=1`
                );
                const data: { total?: number } = await resp.json();
                const total = data.total ?? 0;
                actual = total;
                passed = test.type === "npm_count_above"
                  ? total > (test.threshold ?? 0)
                  : total < (test.threshold ?? 0);
                break;
              }
              case "response_contains": {
                if (!test.url) { passed = false; actual = "no url provided"; break; }
                const resp = await fetch(test.url, {
                  headers: { "User-Agent": "GroundTruth/0.1" },
                });
                const body = await resp.text();
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
