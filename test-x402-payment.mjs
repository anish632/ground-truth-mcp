#!/usr/bin/env node
/**
 * x402 Payment End-to-End Test
 *
 * Tests the full payment loop against the Ground Truth MCP server:
 *   1. Initialize MCP session (get session ID)
 *   2. List tools (verify free + paid annotations)
 *   3. Call free tool (check_endpoint)
 *   4. Call paid tool → get x402 error in _meta
 *   5. Sign EIP-3009 USDC authorization on Base Sepolia
 *   6. Retry with payment token in _meta → get tool result
 *
 * Usage:
 *   PRIVATE_KEY=0x... node test-x402-payment.mjs [url]
 *
 * Requirements:
 *   - A Base Sepolia wallet with test USDC (get from faucet.circle.com)
 *   - The wallet's private key as an env var
 */

import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";

// --- Config ---
const SERVER_URL =
  process.argv[2] || "https://ground-truth-mcp.anishdasmail.workers.dev/mcp";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Error: Set PRIVATE_KEY env var (e.g. PRIVATE_KEY=0xabc...)");
  process.exit(1);
}

// --- Setup wallet + x402 client ---
const account = privateKeyToAccount(PRIVATE_KEY);
const signer = toClientEvmSigner(account);
const paymentClient = new x402Client();
paymentClient.register("eip155:*", new ExactEvmScheme(signer));

console.log(`Wallet: ${account.address}`);
console.log(`Server: ${SERVER_URL}\n`);

// --- MCP session state ---
let sessionId = null;
let reqId = 0;

// --- Parse SSE response ---
function parseSSE(text) {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        return JSON.parse(line.slice(6));
      } catch {}
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --- MCP JSON-RPC request ---
async function mcpRequest(method, params = {}) {
  const body = {
    jsonrpc: "2.0",
    id: ++reqId,
    method,
    params,
  };
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }
  const resp = await fetch(SERVER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  // Capture session ID from first response
  const sid = resp.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  const text = await resp.text();
  return { status: resp.status, headers: resp.headers, data: parseSSE(text), raw: text };
}

// --- Test 1: Initialize ---
async function testInitialize() {
  console.log("--- Test 1: Initialize MCP session ---");
  const { status, data } = await mcpRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "x402-test", version: "1.0.0" },
  });

  if (status !== 200 || !data?.result) {
    console.error(`  FAIL: HTTP ${status}`);
    return false;
  }

  console.log(`  OK: Server "${data.result.serverInfo?.name}" v${data.result.serverInfo?.version}`);
  console.log(`  Session: ${sessionId}`);
  return true;
}

// --- Test 2: List tools ---
async function testListTools() {
  console.log("\n--- Test 2: List tools ---");
  const { status, data } = await mcpRequest("tools/list");

  if (status !== 200 || !data?.result) {
    console.error(`  FAIL: HTTP ${status}`);
    return false;
  }

  const tools = data.result.tools || [];
  console.log(`  OK: ${tools.length} tools available`);
  for (const t of tools) {
    const meta = t._meta;
    const isPaid = meta?.["agents-x402/paymentRequired"];
    const price = meta?.["agents-x402/priceUSD"];
    console.log(`    - ${t.name}${isPaid ? ` ($${price})` : " (free)"}`);
  }
  return true;
}

// --- Test 3: Call free tool ---
async function testFreeTool() {
  console.log("\n--- Test 3: Call free tool (check_endpoint) ---");
  const { status, data } = await mcpRequest("tools/call", {
    name: "check_endpoint",
    arguments: { url: "https://httpbin.org/get" },
  });

  if (status !== 200 || !data?.result) {
    console.error(`  FAIL: HTTP ${status}`);
    return false;
  }

  if (data.result.isError) {
    console.error(`  FAIL: Tool returned error`);
    return false;
  }

  const text = data.result.content?.[0]?.text;
  if (text) {
    const parsed = JSON.parse(text);
    console.log(`  OK: ${parsed.url} → status ${parsed.status}, ${parsed.responseTimeMs}ms`);
    return true;
  }

  console.error("  FAIL: No content");
  return false;
}

// --- Test 4: Call paid tool (x402 flow) ---
async function testPaidTool() {
  console.log("\n--- Test 4: Call paid tool (estimate_market, $0.01) ---");

  // Step 4a: Initial request — expect x402 error in _meta
  console.log("  Step 4a: Initial request (expect payment required)...");
  const { status, data } = await mcpRequest("tools/call", {
    name: "estimate_market",
    arguments: { query: "mcp server", registry: "npm" },
  });

  if (status !== 200) {
    console.error(`  FAIL: Unexpected HTTP ${status}`);
    return false;
  }

  const x402Error = data?.result?._meta?.["x402/error"];
  if (!x402Error || x402Error.error !== "PAYMENT_REQUIRED") {
    console.log("  Tool returned without requiring payment — x402 gate may not be active");
    console.log("  Response:", JSON.stringify(data?.result).slice(0, 300));
    return false;
  }

  console.log("  OK: Got PAYMENT_REQUIRED in _meta");
  const accepts = x402Error.accepts || [];
  if (accepts.length === 0) {
    console.error("  FAIL: No payment options");
    return false;
  }

  const req = accepts[0];
  console.log(`  Network: ${req.network}`);
  console.log(`  Amount:  ${req.amount} atomic units (${Number(req.amount) / 1e6} USDC)`);
  console.log(`  Pay to:  ${req.payTo}`);
  console.log(`  Asset:   ${req.asset}`);
  console.log(`  Scheme:  ${req.scheme}`);

  // Step 4b: Create payment payload
  console.log("\n  Step 4b: Signing EIP-3009 payment authorization...");
  try {
    // Build the PaymentRequired structure the x402 client expects
    const paymentRequired = {
      x402Version: x402Error.x402Version ?? 2,
      resource: x402Error.resource ?? {
        url: "x402://estimate_market",
        description: "",
        mimeType: "application/json",
      },
      accepts,
    };

    const paymentPayload = await paymentClient.createPaymentPayload(paymentRequired);
    console.log("  OK: Payment payload signed");

    // Step 4c: Base64-encode and retry with payment in _meta
    const token = btoa(JSON.stringify(paymentPayload));
    console.log(`  Token length: ${token.length} chars`);

    console.log("\n  Step 4c: Retrying with payment token in _meta...");
    const { status: paidStatus, data: paidData } = await mcpRequest("tools/call", {
      name: "estimate_market",
      arguments: { query: "mcp server", registry: "npm" },
      _meta: { "x402/payment": token },
    });

    if (paidStatus !== 200) {
      console.error(`  FAIL: HTTP ${paidStatus}`);
      return false;
    }

    // Check if payment was accepted
    const paidX402Error = paidData?.result?._meta?.["x402/error"];
    if (paidX402Error) {
      console.error(`  FAIL: Payment rejected — ${paidX402Error.error}`);
      if (paidX402Error.payer) {
        console.log(`  Payer identified: ${paidX402Error.payer}`);
      }
      return false;
    }

    if (paidData?.result?.isError) {
      console.error("  FAIL: Tool returned error after payment");
      console.log("  Content:", paidData.result.content?.[0]?.text?.slice(0, 300));
      return false;
    }

    // Success!
    const text = paidData?.result?.content?.[0]?.text;
    if (text) {
      const parsed = JSON.parse(text);
      console.log(`  OK: Payment accepted! Got ${parsed.totalResults} results for "${parsed.query}"`);

      // Check for settlement confirmation in _meta
      const settlement = paidData?.result?._meta?.["x402/settlement"];
      if (settlement) {
        console.log(`  OK: Settlement confirmed: ${JSON.stringify(settlement)}`);
      }

      return true;
    }

    console.error("  FAIL: No content in paid response");
    return false;
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
    if (err.stack) console.error(`  Stack: ${err.stack.split("\n").slice(0, 3).join("\n  ")}`);
    if (
      err.message.includes("allowance") ||
      err.message.includes("balance") ||
      err.message.includes("insufficient")
    ) {
      console.log("\n  Hint: Make sure your wallet has test USDC on Base Sepolia");
      console.log("  Get test USDC: https://faucet.circle.com");
    }
    return false;
  }
}

// --- Run ---
async function main() {
  console.log("=== Ground Truth MCP — x402 Payment E2E Test ===\n");

  const initOk = await testInitialize();
  if (!initOk) {
    console.error("\nAborting: Could not initialize MCP session");
    process.exit(1);
  }

  const listOk = await testListTools();
  const freeOk = await testFreeTool();
  const paidOk = await testPaidTool();

  console.log("\n=== Results ===");
  console.log(`  Initialize:  ${initOk ? "PASS" : "FAIL"}`);
  console.log(`  List tools:  ${listOk ? "PASS" : "FAIL"}`);
  console.log(`  Free tool:   ${freeOk ? "PASS" : "FAIL"}`);
  console.log(`  Paid tool:   ${paidOk ? "PASS" : "FAIL"}`);

  if (!paidOk) {
    console.log("\nPaid tool test may fail if:");
    console.log("  1. Your wallet has no test USDC (get from faucet.circle.com)");
    console.log("  2. The x402 facilitator at x402.org is down");
    console.log("  3. EIP-3009 authorization signing failed");
    console.log("\nGetting PAYMENT_REQUIRED confirms the payment gate works.");
    console.log("Getting past it confirms the full USDC payment loop.");
  }

  process.exit(initOk && listOk && freeOk && paidOk ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
