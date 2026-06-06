#!/bin/bash

# Ground Truth MCP - Live Usage Data Pull Script
# Pulls actual usage data from the running MCP server and platforms

echo "🚀 Ground Truth MCP - Pulling Live Usage Data"
echo "=============================================="
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_success() {
    echo -e "${GREEN}✅${NC} $1"
}

log_info() {
    echo -e "${BLUE}ℹ️${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠️${NC} $1"
}

log_error() {
    echo -e "${RED}❌${NC} $1"
}

# Create temp directory
TMP_DIR=$(mktemp -d)
OUTPUT_FILE="$TMP_DIR/usage-data.json"

# Function to make MCP API calls
mcp_call() {
    local method="$1"
    local params="$2"
    local extra_headers="$3"
    
    # First initialize session
    local init_response=$(curl -s -D "$TMP_DIR/headers.txt" -X POST "https://ground-truth-mcp.anishdasmail.workers.dev/mcp" \
      -H "Accept: application/json, text/event-stream" \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"usage-pull","version":"1.0"}},"id":1}')
    
    local session_id=$(grep -i "mcp-session-id:" "$TMP_DIR/headers.txt" | tail -1 | awk '{print $2}' | tr -d '\r\n')
    
    if [[ -z "$session_id" ]]; then
        echo "Failed to initialize MCP session"
        return 1
    fi
    
    # Make the actual call
    local response=$(curl -s -X POST "https://ground-truth-mcp.anishdasmail.workers.dev/mcp" \
      -H "Accept: application/json, text/event-stream" \
      -H "Content-Type: application/json" \
      -H "Mcp-Session-Id: $session_id" \
      -H "X-Anonymous-Client-Id: live-usage-query-$(date +%s)" \
      -H "$extra_headers" \
      -d "$params")
    
    echo "$response"
}

echo "📊 Pulling MCP Server Information..."
echo ""

# Initialize the JSON output
echo '{' > "$OUTPUT_FILE"
echo '  "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'",' >> "$OUTPUT_FILE"
echo '  "serverStatus": {' >> "$OUTPUT_FILE"

# Test main server
MAIN_SERVER_RESPONSE=$(curl -s -I "https://ground-truth-mcp.anishdasmail.workers.dev" | head -1 | awk '{print $2}')
if [[ "$MAIN_SERVER_RESPONSE" == "200" ]]; then
    echo '    "mainServer": "Active"' >> "$OUTPUT_FILE"
    log_success "Main MCP server is Active"
else
    echo '    "mainServer": "Down"' >> "$OUTPUT_FILE"
    log_error "Main MCP server is Down"
fi

# Test Xpay server
XPAY_SERVER_RESPONSE=$(curl -s -I "https://ground-truth-mcp-xpay.anishdasmail.workers.dev" | head -1 | awk '{print $2}')
if [[ "$XPAY_SERVER_RESPONSE" == "200" ]]; then
    echo '    "xpayServer": "Active"' >> "$OUTPUT_FILE"
    log_success "Xpay upstream server is Active"
else
    echo '    "xpayServer": "Down"' >> "$OUTPUT_FILE"
    log_error "Xpay upstream server is Down"
fi

# Test Glama profile
GLAMA_RESPONSE=$(curl -s -I "https://glama.ai/mcp/servers/anish632/ground-truth-mcp" | head -1 | awk '{print $2}')
if [[ "$GLAMA_RESPONSE" == "200" ]]; then
    echo '    "glamaProfile": "Active"' >> "$OUTPUT_FILE"
    log_success "Glama profile is Active"
else
    echo '    "glamaProfile": "Down"' >> "$OUTPUT_FILE"
    log_error "Glama profile is Down"
fi

# Test Smithery page
SMITHERY_RESPONSE=$(curl -s -I "https://smithery.ai/servers/anish632/ground-truth" | head -1 | awk '{print $2}')
if [[ "$SMITHERY_RESPONSE" == "200" ]]; then
    echo '    "smitheryPage": "Active"' >> "$OUTPUT_FILE"
    log_success "Smithery page is Active"
else
    echo '    "smitheryPage": "Down"' >> "$OUTPUT_FILE"
    log_error "Smithery page is Down"
fi

# Close serverStatus
TOTAL_ACTIVE=0
if [[ "$MAIN_SERVER_RESPONSE" == "200" ]]; then ((TOTAL_ACTIVE++)); fi
if [[ "$XPAY_SERVER_RESPONSE" == "200" ]]; then ((TOTAL_ACTIVE++)); fi
if [[ "$GLAMA_RESPONSE" == "200" ]]; then ((TOTAL_ACTIVE++)); fi
if [[ "$SMITHERY_RESPONSE" == "200" ]]; then ((TOTAL_ACTIVE++)); fi

echo '  },' >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo '  "summary": {' >> "$OUTPUT_FILE"
echo "    "platformsActive": $TOTAL_ACTIVE," >> "$OUTPUT_FILE"
echo "    "platformsTotal": 4," >> "$OUTPUT_FILE"
echo "    "dataRetrievalTime": "'$(date +%s)'" >> "$OUTPUT_FILE"
echo '  },' >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

# Pull MCP tools data
echo "🛠️  Pulling MCP Tools Data..."
echo ""

TOOLS_RESPONSE=$(mcp_call "tools/call" '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_resources","arguments":{}},"id":1}')

if [[ -n "$TOOLS_RESPONSE" ]]; then
    # Extract tool lists
    FREE_TOOLS=$(echo "$TOOLS_RESPONSE" | grep -o '"freeTools":\[[^]]*\]' | head -1)
    PAID_TOOLS=$(echo "$TOOLS_RESPONSE" | grep -o '"paidTools":\[[^]]*\]' | head -1)
    MONITOR_TOOLS=$(echo "$TOOLS_RESPONSE" | grep -o '"monitorTools":\[[^]]*\]' | head -1)
    SERVER_VERSION=$(echo "$TOOLS_RESPONSE" | grep -o '"serverVersion":"[^"]*"' | head -1)
    
    echo '  "mcpData": {' >> "$OUTPUT_FILE"
    echo "    $FREE_TOOLS," >> "$OUTPUT_FILE"
    echo "    $PAID_TOOLS," >> "$OUTPUT_FILE"
    echo "    $MONITOR_TOOLS," >> "$OUTPUT_FILE"
    echo "    $SERVER_VERSION" >> "$OUTPUT_FILE"
    echo '  },' >> "$OUTPUT_FILE"
    echo "" >> "$OUTPUT_FILE"
    
    # Count tools
    FREE_COUNT=$(echo "$FREE_TOOLS" | grep -o ',' | wc -l | tr -d ' ')
    PAID_COUNT=$(echo "$PAID_TOOLS" | grep -o ',' | wc -l | tr -d ' ')
    MONITOR_COUNT=$(echo "$MONITOR_TOOLS" | grep -o ',' | wc -l | tr -d ' ')
    
    log_success "Pulled MCP tools data: $FREE_COUNT free, $PAID_COUNT paid, $MONITOR_COUNT monitor tools"
    
    # Extract clean version
    VERSION=$(echo "$SERVER_VERSION" | sed 's/.*: "//;s/"//')
    log_info "Server version: $VERSION"
else
    log_error "Failed to pull MCP tools data"
fi

# Add usage tracking info
echo "📈 Adding Usage Tracking Structure..."
echo ""

echo '  "usageTracking": {' >> "$OUTPUT_FILE"
echo '    "storage": "Cloudflare KV (API_KEYS namespace)",' >> "$OUTPUT_FILE"
echo '    "keyPattern": "usage:{subjectType}:{month}:{subjectId}",' >> "$OUTPUT_FILE"
echo '    "subjectTypes": ["free", "free_verify_claim", "pro"],' >> "$OUTPUT_FILE"
echo '    "valueStructure": {' >> "$OUTPUT_FILE"
echo '      "month": "YYYY-MM format",' >> "$OUTPUT_FILE"
echo '      "subjectType": "string",' >> "$OUTPUT_FILE"
echo '      "subjectId": "hashed identifier",' >> "$OUTPUT_FILE"
echo '      "total": "number",' >> "$OUTPUT_FILE"
echo '      "byTool": "object",' >> "$OUTPUT_FILE"
echo '      "updatedAt": "ISO timestamp"' >> "$OUTPUT_FILE"
echo '    },' >> "$OUTPUT_FILE"
echo '    "quotas": {' >> "$OUTPUT_FILE"
echo '      "free": {"limit": 100, "period": "monthly"},' >> "$OUTPUT_FILE"
echo '      "verify_claim_free": {"limit": 5, "period": "monthly"},' >> "$OUTPUT_FILE"
echo '      "starter": {"limit": 2500, "period": "monthly", "price": "$5/month"},' >> "$OUTPUT_FILE"
echo '      "team": {"limit": 5000, "period": "monthly", "price": "$9/month"}' >> "$OUTPUT_FILE"
echo '    }' >> "$OUTPUT_FILE"
echo '  }' >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

# Add platform URLs
echo '  "platforms": {' >> "$OUTPUT_FILE"
echo '    "mainServer": "https://ground-truth-mcp.anishdasmail.workers.dev",' >> "$OUTPUT_FILE"
echo '    "xpayServer": "https://ground-truth-mcp-xpay.anishdasmail.workers.dev",' >> "$OUTPUT_FILE"
echo '    "glama": "https://glama.ai/mcp/servers/anish632/ground-truth-mcp",' >> "$OUTPUT_FILE"
echo '    "smithery": "https://smithery.ai/servers/anish632/ground-truth"' >> "$OUTPUT_FILE"
echo '  }' >> "$OUTPUT_FILE"

# Close JSON
echo '' >> "$OUTPUT_FILE"
echo '}' >> "$OUTPUT_FILE"

echo "" > "$OUTPUT_FILE.tmp"
# Pretty print the JSON using jq if available
if command -v jq &> /dev/null; then
    jq . "$OUTPUT_FILE" > "$OUTPUT_FILE.tmp" && mv "$OUTPUT_FILE.tmp" "$OUTPUT_FILE"
fi

# Display summary
echo ""
echo "📊 Live Usage Data Summary"
echo "=========================="
echo ""

# Read and display the output
if [[ -f "$OUTPUT_FILE" ]]; then
    echo "Data saved to: $OUTPUT_FILE"
    echo ""
    
    # Show key metrics
    log_success "Platform Status: $TOTAL_ACTIVE/4 platforms active"
    log_success "Server Version: $VERSION"
    log_success "Tools Available: $((FREE_COUNT + 1)) free, $((PAID_COUNT + 1)) paid, $((MONITOR_COUNT + 1)) monitor"
    
    echo ""
    echo "📋 Full Data:"
    cat "$OUTPUT_FILE" | head -20
    echo "..."
    
    # Copy to final location
    cp "$OUTPUT_FILE" "./live-usage-data-$(date +%Y-%m-%d-%H%M%S).json"
    echo ""
    log_success "Live usage data saved to: ./live-usage-data-$(date +%Y-%m-%d-%H%M%S).json"
else
    log_error "Failed to generate usage data file"
fi

# Cleanup
rm -rf "$TMP_DIR"

echo ""
echo "🎯 Data Pull Complete!"

# Show file location
ls -la ./live-usage-data-*.json 2>/dev/null | tail -1