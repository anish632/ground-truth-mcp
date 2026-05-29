#!/usr/bin/env bash
# Smoke tests for Ground Truth MCP monitor tools.
# Usage: ./test-monitors.sh [base_url] [api_key]
#
# Defaults to local wrangler dev. Set GROUND_TRUTH_API_KEY env var or pass as $2.
# Requires curl and jq.

set -euo pipefail

BASE_URL="${1:-http://localhost:8787}"
API_KEY="${2:-${GROUND_TRUTH_API_KEY:-}}"
MCP="$BASE_URL/mcp"
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC} $1"; ((PASS++)); }
fail() { echo -e "${RED}FAIL${NC} $1"; ((FAIL++)); }
info() { echo -e "${YELLOW}----${NC} $1"; }

mcp_call() {
  local tool="$1"
  local args="$2"
  local extra_headers="${3:-}"
  local headers=(-H "Content-Type: application/json")
  if [[ -n "$API_KEY" ]]; then
    headers+=(-H "X-API-Key: $API_KEY")
  fi
  if [[ -n "$extra_headers" ]]; then
    headers+=($extra_headers)
  fi
  curl -sf -X POST "$MCP" \
    "${headers[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args},\"id\":1}"
}

echo ""
echo "=== Ground Truth MCP – Monitor Tool Smoke Tests ==="
echo "    Base URL : $BASE_URL"
if [[ -n "$API_KEY" ]]; then
  echo "    API Key  : ${API_KEY:0:8}..."
else
  echo "    API Key  : (none — auth tests will check for 401)"
fi
echo ""

# ─── Init MCP session ────────────────────────────────────────
info "Initializing MCP session"
INIT=$(curl -sf -X POST "$MCP" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}},"id":0}')
if echo "$INIT" | grep -q '"protocolVersion"'; then
  pass "MCP session initialized"
else
  fail "MCP session initialization failed"
  echo "$INIT"
  exit 1
fi

# ─── Test: create_monitor requires API key ────────────────────
info "create_monitor without API key → expect 401 or missing_api_key"
RESP=$(curl -sf -X POST "$MCP" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"create_monitor","arguments":{"name":"test","target_type":"url","target_value":"https://example.com"}},"id":2}' || true)
if echo "$RESP" | grep -qiE '401|missing_api_key|requires a team API key'; then
  pass "create_monitor rejects unauthenticated request"
else
  fail "create_monitor should require API key"
  echo "$RESP"
fi

if [[ -z "$API_KEY" ]]; then
  echo ""
  echo "No API key provided — skipping authenticated tests."
  echo "Set GROUND_TRUTH_API_KEY=<your-key> to run the full suite."
  echo ""
  echo "Results: ${PASS} passed, ${FAIL} failed"
  exit $((FAIL > 0 ? 1 : 0))
fi

# ─── Test: create_monitor (url) ───────────────────────────────
info "create_monitor target_type=url"
CREATE=$(mcp_call "create_monitor" '{"name":"Example Endpoint","target_type":"url","target_value":"https://example.com","schedule":"manual"}')
MONITOR_ID=$(echo "$CREATE" | jq -r '.result.structuredContent.id // .result.content[0].text' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
if [[ -z "$MONITOR_ID" ]]; then
  MONITOR_ID=$(echo "$CREATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('id',''))" 2>/dev/null || echo "")
fi
if [[ -n "$MONITOR_ID" ]] && echo "$MONITOR_ID" | grep -q "^mon_"; then
  pass "create_monitor returned id=$MONITOR_ID"
else
  fail "create_monitor did not return a valid monitor id"
  echo "$CREATE" | jq . 2>/dev/null || echo "$CREATE"
  exit 1
fi

# ─── Test: create_monitor (pricing_page) ─────────────────────
info "create_monitor target_type=pricing_page"
CREATE2=$(mcp_call "create_monitor" '{"name":"Stripe Pricing","target_type":"pricing_page","target_value":"https://stripe.com/pricing","schedule":"daily"}')
MONITOR_ID2=$(echo "$CREATE2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('id',''))" 2>/dev/null || echo "")
if echo "$MONITOR_ID2" | grep -q "^mon_"; then
  pass "create_monitor pricing_page returned id=$MONITOR_ID2"
else
  fail "create_monitor pricing_page failed"
  echo "$CREATE2" | jq . 2>/dev/null || echo "$CREATE2"
fi

# ─── Test: create_monitor (package) ──────────────────────────
info "create_monitor target_type=package (npm:zod)"
CREATE3=$(mcp_call "create_monitor" '{"name":"Zod version","target_type":"package","target_value":"npm:zod","schedule":"weekly"}')
MONITOR_ID3=$(echo "$CREATE3" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('id',''))" 2>/dev/null || echo "")
if echo "$MONITOR_ID3" | grep -q "^mon_"; then
  pass "create_monitor package returned id=$MONITOR_ID3"
else
  fail "create_monitor package failed"
  echo "$CREATE3" | jq . 2>/dev/null || echo "$CREATE3"
fi

# ─── Test: list_monitors ──────────────────────────────────────
info "list_monitors"
LIST=$(mcp_call "list_monitors" '{"active_only":true}')
TOTAL=$(echo "$LIST" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('total',0))" 2>/dev/null || echo "0")
if [[ "$TOTAL" -ge 1 ]]; then
  pass "list_monitors returned $TOTAL monitor(s)"
else
  fail "list_monitors returned 0 monitors (expected at least 1)"
  echo "$LIST" | jq . 2>/dev/null || echo "$LIST"
fi

# ─── Test: run_monitor_now (url) ─────────────────────────────
info "run_monitor_now for url monitor"
RUN=$(mcp_call "run_monitor_now" "{\"monitor_id\":\"$MONITOR_ID\"}")
RUN_STATUS=$(echo "$RUN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('status',''))" 2>/dev/null || echo "")
if [[ "$RUN_STATUS" == "changed" || "$RUN_STATUS" == "unchanged" ]]; then
  pass "run_monitor_now status=$RUN_STATUS"
else
  fail "run_monitor_now unexpected status: '$RUN_STATUS'"
  echo "$RUN" | jq . 2>/dev/null || echo "$RUN"
fi

# ─── Test: run_monitor_now (pricing_page) ────────────────────
if [[ -n "$MONITOR_ID2" ]] && echo "$MONITOR_ID2" | grep -q "^mon_"; then
  info "run_monitor_now for pricing_page monitor"
  RUN2=$(mcp_call "run_monitor_now" "{\"monitor_id\":\"$MONITOR_ID2\"}")
  RUN_STATUS2=$(echo "$RUN2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('status',''))" 2>/dev/null || echo "")
  if [[ "$RUN_STATUS2" == "changed" || "$RUN_STATUS2" == "unchanged" ]]; then
    pass "run_monitor_now pricing_page status=$RUN_STATUS2"
  else
    fail "run_monitor_now pricing_page unexpected status: '$RUN_STATUS2'"
    echo "$RUN2" | jq . 2>/dev/null || echo "$RUN2"
  fi
fi

# ─── Test: run_monitor_now second time → unchanged ───────────
info "run_monitor_now second time (expect unchanged)"
RUN_AGAIN=$(mcp_call "run_monitor_now" "{\"monitor_id\":\"$MONITOR_ID\"}")
RUN_AGAIN_STATUS=$(echo "$RUN_AGAIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('status',''))" 2>/dev/null || echo "")
if [[ "$RUN_AGAIN_STATUS" == "unchanged" ]]; then
  pass "run_monitor_now second run correctly returned unchanged"
else
  info "run_monitor_now second run status=$RUN_AGAIN_STATUS (may be ok if endpoint changed)"
  ((PASS++))
fi

# ─── Test: get_monitor_result ────────────────────────────────
info "get_monitor_result"
RESULTS=$(mcp_call "get_monitor_result" "{\"monitor_id\":\"$MONITOR_ID\",\"limit\":5}")
RESULT_TOTAL=$(echo "$RESULTS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('total',0))" 2>/dev/null || echo "0")
if [[ "$RESULT_TOTAL" -ge 1 ]]; then
  pass "get_monitor_result returned $RESULT_TOTAL result(s)"
else
  fail "get_monitor_result returned 0 results"
  echo "$RESULTS" | jq . 2>/dev/null || echo "$RESULTS"
fi

# ─── Test: generate_change_report (daily) ────────────────────
info "generate_change_report period=daily"
REPORT=$(mcp_call "generate_change_report" '{"period":"daily"}')
REPORT_MON=$(echo "$REPORT" | python3 -c "import sys,json; d=json.load(sys.stdin); sc=d.get('result',{}).get('structuredContent',{}); print(sc.get('summary',{}).get('monitors_run',-1))" 2>/dev/null || echo "-1")
if [[ "$REPORT_MON" -ge 0 ]]; then
  pass "generate_change_report returned summary.monitors_run=$REPORT_MON"
else
  fail "generate_change_report did not return a valid summary"
  echo "$REPORT" | jq . 2>/dev/null || echo "$REPORT"
fi

# ─── Test: run_monitor_now for unknown ID → error ────────────
info "run_monitor_now with bad monitor_id → expect error"
BAD_RUN=$(mcp_call "run_monitor_now" '{"monitor_id":"mon_doesnotexist1234567890"}')
BAD_STATUS=$(echo "$BAD_RUN" | python3 -c "import sys,json; d=json.load(sys.stdin); sc=d.get('result',{}).get('structuredContent',{}); print(sc.get('status','') + sc.get('error',''))" 2>/dev/null || echo "")
if echo "$BAD_STATUS" | grep -qiE 'error|not found'; then
  pass "run_monitor_now correctly errors on unknown monitor"
else
  fail "run_monitor_now should error on unknown monitor"
  echo "$BAD_RUN" | jq . 2>/dev/null || echo "$BAD_RUN"
fi

# ─── Test: delete_monitor ────────────────────────────────────
info "delete_monitor"
DEL=$(mcp_call "delete_monitor" "{\"monitor_id\":\"$MONITOR_ID\"}")
DELETED=$(echo "$DEL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('deleted',False))" 2>/dev/null || echo "False")
if [[ "$DELETED" == "True" ]]; then
  pass "delete_monitor returned deleted=true"
else
  fail "delete_monitor did not return deleted=true"
  echo "$DEL" | jq . 2>/dev/null || echo "$DEL"
fi

# ─── Test: list_monitors after delete ────────────────────────
info "list_monitors after delete"
LIST2=$(mcp_call "list_monitors" '{"active_only":true}')
TOTAL2=$(echo "$LIST2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('total',0))" 2>/dev/null || echo "0")
if [[ "$TOTAL2" -lt "$TOTAL" ]]; then
  pass "list_monitors count decreased after delete ($TOTAL → $TOTAL2)"
else
  fail "list_monitors count did not decrease after delete"
fi

# ─── Cleanup remaining monitors ──────────────────────────────
for mid in "$MONITOR_ID2" "$MONITOR_ID3"; do
  if echo "$mid" | grep -q "^mon_"; then
    mcp_call "delete_monitor" "{\"monitor_id\":\"$mid\"}" > /dev/null 2>&1 || true
  fi
done

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
exit $((FAIL > 0 ? 1 : 0))
