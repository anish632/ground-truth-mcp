import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_REMOTE_URL = "https://ground-truth-mcp.anishdasmail.workers.dev/mcp";

function log(message, error) {
  if (error) {
    process.stderr.write(`[glama-bridge] ${message}: ${error}\n`);
    return;
  }

  process.stderr.write(`[glama-bridge] ${message}\n`);
}

async function main() {
  const remoteUrl = new URL(process.env.GROUND_TRUTH_REMOTE_URL || DEFAULT_REMOTE_URL);
  const headers = {};

  if (process.env.GROUND_TRUTH_API_KEY) {
    headers["X-API-Key"] = process.env.GROUND_TRUTH_API_KEY;
  }

  const client = new Client({
    name: "ground-truth-glama-bridge",
    version: "0.3.0",
  });

  client.onerror = (error) => log("Upstream client error", error instanceof Error ? error.message : String(error));

  const upstreamTransport = new StreamableHTTPClientTransport(remoteUrl, {
    requestInit: { headers },
  });

  await client.connect(upstreamTransport);

  const upstreamInfo = client.getServerVersion();
  const server = new Server(
    {
      name: upstreamInfo?.name || "ground-truth",
      version: upstreamInfo?.version || "0.3.0",
    },
    {
      capabilities: {
        tools: {
          listChanged: true,
        },
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return await client.listTools(request.params);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await client.callTool(request.params);
  });

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);

  log(`Connected stdio bridge to ${remoteUrl.toString()}`);
}

main().catch(async (error) => {
  log("Bridge startup failed", error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
