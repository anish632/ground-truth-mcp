# Ground Truth MCP

**✅ WORKING IN 15 SECONDS: NO SIGNUP. NO API KEY. JUST WORKS.**

---

## 🎯 DO THIS NOW (15 seconds)

### Step 1: Copy this config
```json
{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp"
    }
  }
}
```

### Step 2: Paste this prompt to your AI
> Use Ground Truth check_endpoint tool with url=https://example.com. Do not answer from memory. Call the tool.

### Step 3: You should see this (✅ SUCCESS!)
```json
{
  "url": "https://example.com/",
  "accessible": true,
  "status": 200,
  "contentType": "text/html",
  "responseTimeMs": 89
}
```

**If you see this JSON, Ground Truth is working perfectly.**

If your AI answers from memory instead of using the tool, try: "Use the check_endpoint MCP tool right now with url=https://example.com"

---

## 🏆 That's It! You're Done.

You've successfully connected to Ground Truth MCP and verified it works.

**What just happened:**
- ✅ You proved MCP connection works
- ✅ You verified a live endpoint in real-time  
- ✅ You got structured data, not hallucinated answers

**No signup. No API key. No credit card. Just verification.**

---

## 🌟 What Ground Truth Does

Ground Truth stops AI agents from being wrong by **verifying live public data** before they use it in answers, code, or decisions.

### Free Tools (No signup required)
- `check_endpoint` - Verify any URL/API responds (100 calls/month free)
- `inspect_security_headers` - Check security posture of any site

### Paid Tools (Unlock with team key)
- `check_pricing` - Extract prices from any pricing page
- `estimate_market` - Search npm/PyPI for package counts
- `compare_competitors` - Compare packages side-by-side
- `compare_pricing_pages` - Compare multiple pricing pages
- `verify_claim` - Verify claims against live sources
- `assess_compliance_posture` - Scan trust pages for compliance signals
- `test_hypothesis` - Run multi-step verification tests

---

## 💡 Use Cases That Actually Matter

### Before recommending an API
> "Use the `/v1/users` endpoint for user management"

→ **Verify first:** `check_endpoint url=https://api.example.com/v1/users`

### Before quoting a price
> "Stripe costs $8/user/month for teams"

→ **Verify first:** `check_pricing url=https://stripe.com/pricing`

### Before claiming compliance
> "This vendor supports SOC 2 and GDPR"

→ **Verify first:** `assess_compliance_posture url=https://vendor.example.com/security`

### Before saying a competitor doesn't exist
> "There are no good edge ORM alternatives to Prisma"

→ **Verify first:** `estimate_market query="edge orm" registry="npm"`

---

## 📊 Activation Challenge

**Current Baseline:** 1,075 profile views → 0 tool calls = **0% activation**

**Target:** >1% activation (10+ successful first calls per 1,000 views)

**You just became a data point!** By completing the 15-second test above, you're helping solve this.

---

## 🔧 Setup (Only after activation works)

### Claude Desktop
```json
{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp"
    }
  }
}
```
Add to: `~/Library/Application Support/Claude/claude_desktop_config.json`

### Cursor  
```json
{
  "mcpServers": {
    "ground-truth": {
      "url": "https://ground-truth-mcp.anishdasmail.workers.dev/mcp"
    }
  }
}
```
Add to: `.cursor/mcp.json` or `~/.cursor/mcp.json`

### Any MCP Client
URL: `https://ground-truth-mcp.anishdasmail.workers.dev/mcp`

---

## 🚀 Advanced Features (After activation)

### Team Plans
- **$9/month**: All paid tools, 5,000 calls/month, saved monitors
- **$29/month**: Team features, higher limits, alerts  
- **$99/month**: Enterprise, Slack/email alerts, audit history

### Monitoring Example
```json
{
  "name": "Stripe pricing watch",
  "target_type": "pricing_page",
  "target_value": "https://stripe.com/pricing",
  "schedule": "daily"
}
```

### Pay-per-use
For x402-compatible clients: $0.01-0.06 per paid tool call via USDC stablecoin

---

## 🛠️ Troubleshooting

### Server not connecting
- URL: `https://ground-truth-mcp.anishdasmail.workers.dev/mcp`
- Health: `curl -I https://ground-truth-mcp.anishdasmail.workers.dev/.well-known/mcp/server-card.json`
- Restart MCP client after config changes

### No tool calls appearing
- Use exact tool name: `check_endpoint`
- **Do NOT add X-API-Key for first call**
- Try: "Use the check_endpoint MCP tool right now with url=https://example.com"

### AI answered from memory
Your MCP client may not be properly configured. Try a different client or be explicit: "Use the MCP check_endpoint tool, do not answer from memory."

---

## 📖 More Info

- [API Usage Guide](API_USAGE.md)
- [Setup & Deployment](SETUP.md) 
- [Monitors & Alerts](#-advanced-features)
- [Pricing Page](https://ground-truth-mcp.anishdasmail.workers.dev/pricing)

---

## 🎯 Quick Summary

**Copy** → **Paste** → **See JSON** → **✅ SUCCESS**

That's it. Now try a real URL:
> Use Ground Truth check_endpoint tool with url=[your-url]

---

**Live:** https://ground-truth-mcp.anishdasmail.workers.dev  
**Status:** ✅ Operational  
**Support:** anishdasmail@gmail.com  
**License:** MIT

[![MCP](https://img.shields.io/badge/MCP-1.11.0-blue)](https://modelcontextprotocol.io)  
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com)  
[![Glama Score](https://glama.ai/mcp/servers/anish632/ground-truth-mcp/badges/score.svg)](https://glama.ai/mcp/servers/anish632/ground-truth-mcp)

**Made by [Anish Das](https://github.com/anish632)**

_Last updated: July 9, 2026 - Activation-focused rewrite_