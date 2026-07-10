#!/bin/bash

# Ground Truth MCP - 15-Second Activation Test
# Run this to verify your Ground Truth connection works
# Usage: ./test-activation.sh [server_url]

set -e

SERVER_URL="${1:-https://ground-truth-mcp.anishdasmail.workers.dev/mcp}"
TMP_FILE=$(mktemp)

echo "🎯 Ground Truth MCP - 15-Second Activation Test"
echo "=============================================="
echo ""

# Step 1: Initialize MCP session
echo "📡 Step 1/3: Initializing MCP session..."
RESPONSE=$(curl -s -D "$TMP_FILE" -X POST "$SERVER_URL" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"activation-test","version":"1.0.0"}},"id":0}')

# Extract session ID from headers (exact match)
SESSION_ID=$(grep -i '^mcp-session-id:' "$TMP_FILE" | tr -d '\r' | sed 's/^mcp-session-id: *//i')

if [ -z "$SESSION_ID" ]; then
  echo "❌ FAILED: Could not initialize MCP session"
  echo "   Checking headers for mcp-session-id..."
  grep -i 'mcp-session-id' "$TMP_FILE" || echo "   No mcp-session-id found in headers"
  echo "   Response status: $(grep '^HTTP' "$TMP_FILE" | head -1)"
  echo "   Check that $SERVER_URL is reachable"
  exit 1
fi

echo "   ✅ Session initialized: $SESSION_ID"
echo ""

# Step 2: Call check_endpoint
echo "🎯 Step 2/3: Calling check_endpoint tool..."
RESPONSE=$(curl -s -X POST "$SERVER_URL" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"check_endpoint","arguments":{"url":"https://example.com"}},"id":1}')

# Check for expected fields in response
if echo "$RESPONSE" | grep -q "accessible"; then
  echo "   ✅ Tool called successfully"
else
  echo "❌ FAILED: Tool call did not return expected response"
  echo "   Response: $RESPONSE"
  exit 1
fi

echo ""

# Step 3: Verify response structure
echo "📋 Step 3/3: Verifying response structure..."
if echo "$RESPONSE" | grep -q "\"accessible\": *true"; then
  ACCESSIBLE="true"
elif echo "$RESPONSE" | grep -q "\"accessible\": *false"; then
  ACCESSIBLE="false"
else
  echo "❌ FAILED: Could not determine accessibility"
  exit 1
fi

STATUS=$(echo "$RESPONSE" | grep -o '"status": *[0-9]*' | grep -o '[0-9]*')
URL=$(echo "$RESPONSE" | grep -o '"url": *"[^"]*"' | grep -o 'https://[^"]*')

cat << EOF
   ✅ ACTIVATION SUCCESSFUL!

   Results:
   • URL: $URL
   • Accessible: $ACCESSIBLE
   • Status: $STATUS
   • Server: Working
   • MCP Connection: Verified

🎉 Ground Truth is working perfectly!
EOF

# Cleanup
rm -f "$TMP_FILE"

exit 0