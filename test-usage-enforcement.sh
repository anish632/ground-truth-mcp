#!/bin/bash

set -euo pipefail

SERVER_URL="${1:-${GROUND_TRUTH_URL:-http://localhost:8787/mcp}}"
ACTIVE_TEAM_KEY="${ACTIVE_TEAM_KEY:-${ACTIVE_PRO_KEY:-}}"
INACTIVE_TEAM_KEY="${INACTIVE_TEAM_KEY:-${INACTIVE_PRO_KEY:-}}"
TMP_RESPONSE_FILE="$(mktemp)"
TMP_HEADERS_FILE="$(mktemp)"
MCP_SESSION_ID=""

cleanup() {
  rm -f "$TMP_RESPONSE_FILE"
  rm -f "$TMP_HEADERS_FILE"
}

trap cleanup EXIT

initialize_session() {
  local status

  status="$(
    curl -s -D "$TMP_HEADERS_FILE" -o "$TMP_RESPONSE_FILE" -w "%{http_code}" \
      -X POST "$SERVER_URL" \
      -H "Accept: application/json, text/event-stream" \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ground-truth-usage-test","version":"1.0.0"}},"id":0}'
  )"

  if [ "$status" != "200" ]; then
    echo "FAIL: MCP initialize"
    echo "Expected: 200"
    echo "Actual:   $status"
    echo "Response:"
    cat "$TMP_RESPONSE_FILE"
    exit 1
  fi

  MCP_SESSION_ID="$(
    tr -d '\r' < "$TMP_HEADERS_FILE" | awk 'tolower($1) == "mcp-session-id:" { print $2 }'
  )"

  if [ -z "$MCP_SESSION_ID" ]; then
    echo "FAIL: MCP initialize did not return mcp-session-id"
    echo "Headers:"
    cat "$TMP_HEADERS_FILE"
    exit 1
  fi
}

post_json() {
  local payload="$1"
  shift || true

  curl -s -o "$TMP_RESPONSE_FILE" -w "%{http_code}" \
    -X POST "$SERVER_URL" \
    -H "Accept: application/json, text/event-stream" \
    -H "Content-Type: application/json" \
    -H "Mcp-Session-Id: $MCP_SESSION_ID" \
    "$@" \
    -d "$payload"
}

assert_status() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" = "$actual" ]; then
    echo "PASS: $label ($actual)"
    return
  fi

  echo "FAIL: $label"
  echo "Expected: $expected"
  echo "Actual:   $actual"
  echo "Response:"
  cat "$TMP_RESPONSE_FILE"
  exit 1
}

assert_body_contains() {
  local pattern="$1"
  local label="$2"

  if grep -q "$pattern" "$TMP_RESPONSE_FILE"; then
    echo "PASS: $label"
    return
  fi

  echo "FAIL: $label"
  echo "Expected body to contain: $pattern"
  echo "Response:"
  cat "$TMP_RESPONSE_FILE"
  exit 1
}

echo "Ground Truth usage enforcement checks"
echo "Server: $SERVER_URL"
echo ""

initialize_session

free_payload='{"jsonrpc":"2.0","method":"tools/call","params":{"name":"check_endpoint","arguments":{"url":"https://example.com"}},"id":1}'
paid_payload='{"jsonrpc":"2.0","method":"tools/call","params":{"name":"estimate_market","arguments":{"query":"edge orm","registry":"npm"}},"id":2}'
invalid_key_payload='{"jsonrpc":"2.0","method":"tools/call","params":{"name":"compare_competitors","arguments":{"packages":["react","vue"],"registry":"npm"}},"id":3}'
inactive_key_payload='{"jsonrpc":"2.0","method":"tools/call","params":{"name":"verify_claim","arguments":{"claim":"Stripe has a free tier","evidence_urls":["https://stripe.com/pricing"],"keywords":["free"]}},"id":4}'

echo "1. Free check_endpoint works"
status="$(post_json "$free_payload" -H "X-Anonymous-Client-Id: free-smoke-$(date +%s)")"
assert_status "200" "$status" "free check_endpoint"

echo ""
echo "2. Unpaid paid-tool requests return MCP payment metadata"
status="$(post_json "$paid_payload")"
assert_status "200" "$status" "unpaid agentic request"
assert_body_contains '"x402/error"' "x402 payment-required metadata present"
assert_body_contains 'PAYMENT_REQUIRED' "payment-required error code present"

echo ""
echo "3. Invalid team API key is rejected"
status="$(post_json "$invalid_key_payload" -H "X-API-Key: gt_live_invalid")"
assert_status "401" "$status" "invalid team API key"

echo ""
echo "4. Inactive team subscription is rejected"
if [ -n "$INACTIVE_TEAM_KEY" ]; then
  status="$(post_json "$inactive_key_payload" -H "X-API-Key: $INACTIVE_TEAM_KEY")"
  assert_status "402" "$status" "inactive team subscription"
else
  echo "SKIP: set INACTIVE_TEAM_KEY (or INACTIVE_PRO_KEY) to verify inactive billing returns 402"
fi

echo ""
echo "5. Free monthly quota returns 429 after 100 requests"
quota_client_id="free-quota-$(date +%s)"
for i in $(seq 1 100); do
  status="$(post_json "$free_payload" -H "X-Anonymous-Client-Id: $quota_client_id")"
  if [ "$status" != "200" ]; then
    echo "FAIL: free quota warm-up request $i returned $status"
    cat "$TMP_RESPONSE_FILE"
    exit 1
  fi
done
status="$(post_json "$free_payload" -H "X-Anonymous-Client-Id: $quota_client_id")"
assert_status "429" "$status" "free monthly quota enforcement"

echo ""
echo "6. Active team key can call all paid tools"
if [ -n "$ACTIVE_TEAM_KEY" ]; then
  status="$(post_json "$free_payload" -H "X-API-Key: $ACTIVE_TEAM_KEY")"
  assert_status "200" "$status" "check_endpoint with active team key"

  status="$(post_json "$paid_payload" -H "X-API-Key: $ACTIVE_TEAM_KEY")"
  assert_status "200" "$status" "estimate_market with active team key"

  status="$(post_json '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"check_pricing","arguments":{"url":"https://stripe.com/pricing"}},"id":5}' -H "X-API-Key: $ACTIVE_TEAM_KEY")"
  assert_status "200" "$status" "check_pricing with active team key"

  status="$(post_json '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"inspect_security_headers","arguments":{"url":"https://example.com"}},"id":6}' -H "X-API-Key: $ACTIVE_TEAM_KEY")"
  assert_status "200" "$status" "inspect_security_headers with active team key"

  status="$(post_json '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"compare_pricing_pages","arguments":{"pages":[{"name":"Stripe","url":"https://stripe.com/pricing"},{"name":"Vercel","url":"https://vercel.com/pricing"}]}},"id":7}' -H "X-API-Key: $ACTIVE_TEAM_KEY")"
  assert_status "200" "$status" "compare_pricing_pages with active team key"

  status="$(post_json "$invalid_key_payload" -H "X-API-Key: $ACTIVE_TEAM_KEY")"
  assert_status "200" "$status" "compare_competitors with active team key"

  status="$(post_json "$inactive_key_payload" -H "X-API-Key: $ACTIVE_TEAM_KEY")"
  assert_status "200" "$status" "verify_claim with active team key"

  status="$(post_json '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"assess_compliance_posture","arguments":{"url":"https://stripe.com/security"}},"id":8}' -H "X-API-Key: $ACTIVE_TEAM_KEY")"
  assert_status "200" "$status" "assess_compliance_posture with active team key"

  status="$(post_json '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"test_hypothesis","arguments":{"hypothesis":"GitHub API is reachable","tests":[{"description":"GitHub API endpoint exists","type":"endpoint_exists","url":"https://api.github.com"}]}},"id":9}' -H "X-API-Key: $ACTIVE_TEAM_KEY")"
  assert_status "200" "$status" "test_hypothesis with active team key"
else
  echo "SKIP: set ACTIVE_TEAM_KEY (or ACTIVE_PRO_KEY) to verify team access across all paid tools"
fi

echo ""
echo "Done."
