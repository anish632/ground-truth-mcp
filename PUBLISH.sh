#!/bin/bash
# Ground Truth - npm Publication Script
# Run this after completing npm browser login

set -e

echo "🚀 Ground Truth Publication Script"
echo "======================================"
echo ""

# Check npm login
echo "1️⃣  Verifying npm login..."
if npm whoami > /dev/null 2>&1; then
  NPM_USER=$(npm whoami)
  echo "✅ Logged in as: $NPM_USER"
else
  echo "❌ Not logged in to npm!"
  echo "   Run: npm login --auth-type=web"
  exit 1
fi

# Check if package exists
echo ""
echo "2️⃣  Checking if package already exists on npm..."
if npm view ground-truth-mcp > /dev/null 2>&1; then
  echo "⚠️  Package 'ground-truth-mcp' already exists on npm!"
  echo "   Bump the version in package.json before publishing again"
  exit 1
else
  echo "✅ Package name is available"
fi

# Publish to npm
echo ""
echo "3️⃣  Publishing to npm..."
npm publish --access public

# Verify
echo ""
echo "4️⃣  Verifying publication..."
sleep 3
npm view ground-truth-mcp

echo ""
echo "✅ Successfully published to npm!"
echo ""
echo "📦 Next steps:"
echo "   1. Confirm npm metadata still matches the current Ground Truth positioning"
echo "   2. Review README, server.json, and glama.json on the published package"
echo ""
echo "   MCP registry:"
echo "   1. Install mcp-publisher: brew install mcp-publisher"
echo "   2. Login: mcp-publisher login github"
echo "   3. Publish: mcp-publisher publish"
echo ""
echo "   Optional - Smithery.ai:"
echo "   1. Install CLI: npm install -g @smithery/cli"
echo "   2. Login: smithery auth login"
echo "   3. Publish: smithery mcp publish https://ground-truth-mcp.anishdasmail.workers.dev/mcp -n anish632/ground-truth"
