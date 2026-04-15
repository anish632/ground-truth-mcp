# Ground Truth MCP

> Let AI agents validate their own claims with real, live data from the web.

[![MCP](https://img.shields.io/badge/MCP-1.11.0-blue)](https://modelcontextprotocol.io)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com)
[![Stripe](https://img.shields.io/badge/Stripe-Billing-purple)](https://stripe.com)

**Live URL:** https://ground-truth-mcp.anish632.workers.dev

---

## 🎯 What is Ground Truth?

Ground Truth is an MCP server that provides AI agents with fact-checking and market research tools. Instead of hallucinating or guessing, agents can:

- ✅ Check if an API endpoint actually exists
- 📊 Count real market competitors
- 💰 Extract actual pricing from websites
- 🔍 Compare packages side-by-side
- 🧪 Cross-reference claims against live sources
- ⚗️ Test hypotheses with structured tests

All results come from live data fetched in real-time, with 5-minute caching for performance.

---

## 🚀 Quick Start

### Free Tier (No Signup)

Try the `check_endpoint` tool immediately:

```bash
curl -X POST https://ground-truth-mcp.anish632.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "check_endpoint",
      "arguments": {"url": "https://api.github.com"}
    },
    "id": 1
  }'
```

### Pro Tier ($9/month)

1. Visit [pricing page](https://ground-truth-mcp.anish632.workers.dev/pricing)
2. Subscribe via Stripe
3. Get your API key: `gt_live_...`
4. Add to requests:

```bash
curl -X POST https://ground-truth-mcp.anish632.workers.dev/mcp \
  -H "X-API-Key: gt_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"estimate_market","arguments":{"query":"react","registry":"npm"}},"id":1}'
```

---

## 🛠️ Available Tools

| Tool | Free? | Description |
|------|-------|-------------|
| `check_endpoint` | ✅ Yes | Probe any URL, get status, timing, auth requirements |
| `estimate_market` | 💳 Pro | Count packages in npm/PyPI to gauge market size |
| `check_pricing` | 💳 Pro | Extract pricing from any website |
| `compare_competitors` | 💳 Pro | Side-by-side package comparison |
| `verify_claim` | 💳 Pro | Cross-reference claims with live sources |
| `test_hypothesis` | 💳 Pro | Automated fact-checking with structured tests |

Full API documentation: [API_USAGE.md](./API_USAGE.md)

---

## 💰 Pricing

### Free Tier
- **check_endpoint** - Unlimited forever

### Pro Tier - $9/month
- **All 5 premium tools** - Unlimited usage
- **5-minute caching** - Fast responses
- **99.9% uptime SLA**
- **Cancel anytime** - No questions asked

[Subscribe now →](https://ground-truth-mcp.anish632.workers.dev/pricing)

---

## 🏗️ Tech Stack

- **Runtime:** Cloudflare Workers (edge computing)
- **Storage:** Durable Objects with SQLite (caching + usage logs)
- **API Keys:** Cloudflare KV (encrypted at rest)
- **Billing:** Stripe Checkout + Subscriptions
- **Protocol:** Model Context Protocol (MCP)
- **Language:** TypeScript

---

## 📚 Documentation

- **[SETUP.md](./SETUP.md)** - Deployment & configuration guide
- **[API_USAGE.md](./API_USAGE.md)** - API reference & examples
- **[IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md)** - Implementation details

---

## 🔧 Development

### Prerequisites

- Node.js 18+
- npm or pnpm
- Cloudflare account
- Stripe account

### Local Setup

1. **Clone the repo:**
   ```bash
   cd "/Users/anishdas/Apps/Ground Truth/ground-truth-mcp"
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create KV namespace:**
   ```bash
   npx wrangler kv namespace create API_KEYS
   ```

4. **Update wrangler.jsonc** with KV namespace ID

5. **Set secrets:**
   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

6. **Run locally:**
   ```bash
   npm start
   # or
   npx wrangler dev
   ```

7. **Deploy:**
   ```bash
   npm run deploy
   # or
   npx wrangler deploy
   ```

Full setup guide: [SETUP.md](./SETUP.md)

---

## 🧪 Testing

### Test Free Tier (No Auth)

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "check_endpoint",
      "arguments": {"url": "https://example.com"}
    },
    "id": 1
  }'
```

### Test Auth Rejection

```bash
# Should return 402 (payment required)
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "estimate_market",
      "arguments": {"query": "test", "registry": "npm"}
    },
    "id": 1
  }'
```

### Test Stripe Checkout

1. Visit http://localhost:8787/pricing
2. Click "Subscribe Now"
3. Use test card: `4242 4242 4242 4242`
4. Complete checkout
5. Verify API key displayed on success page

---

## 🔐 Security

- **API Keys:** Stored in Cloudflare KV (encrypted at rest)
- **Stripe Keys:** Stored as Worker secrets (encrypted)
- **Webhook Validation:** Signature verification (simplified for MVP)
- **Key Revocation:** Inactive keys marked on subscription cancellation
- **Audit Trail:** Keys not deleted, only marked inactive

---

## 🚦 Status & Monitoring

- **Homepage:** https://ground-truth-mcp.anish632.workers.dev
- **Stats:** https://ground-truth-mcp.anish632.workers.dev/stats
- **Stripe Dashboard:** https://dashboard.stripe.com
- **Cloudflare Dashboard:** https://dash.cloudflare.com

---

## 📊 Architecture

```
┌─────────────┐
│   User      │
└──────┬──────┘
       │
       ├─── Free Tier (no auth)
       │    └─► check_endpoint
       │
       ├─── Pro Tier (API key)
       │    ├─► X-API-Key header
       │    ├─► Validate against KV
       │    └─► estimate_market, check_pricing, etc.
       │
       └─── x402 (fallback)
            └─► Crypto payment for single call
       
┌─────────────────────────────────────┐
│   Cloudflare Worker                  │
├─────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐ │
│  │ Auth         │  │ Stripe       │ │
│  │ Middleware   │  │ Integration  │ │
│  └──────────────┘  └──────────────┘ │
│         │                 │          │
│  ┌──────▼──────┐  ┌──────▼────────┐ │
│  │ KV Store    │  │ Durable       │ │
│  │ (API Keys)  │  │ Objects       │ │
│  └─────────────┘  │ (Cache+Logs)  │ │
│                   └───────────────┘ │
└─────────────────────────────────────┘
```

---

## 🤝 Contributing

Not accepting external contributions at this time (private project), but feel free to fork for your own use.

---

## 📜 License

MIT License - see LICENSE file for details

---

## 🆘 Support

- **Email:** anishdasmail@gmail.com
- **Issues:** https://github.com/anish632/ground-truth-mcp/issues
- **Twitter:** [@anish632](https://twitter.com/anish632)

---

## 🎯 Use Cases

### For AI Agents
- Validate market research before presenting findings
- Fact-check claims against live sources
- Compare competitors with real data
- Test hypotheses with structured verification

### For Developers
- Pre-validate APIs before recommending them
- Check pricing without manual web scraping
- Estimate package counts for market sizing
- Automated fact-checking in CI/CD

### For Researchers
- Cross-reference claims with live data
- Track package versions over time
- Monitor pricing changes
- Validate academic hypotheses

---

## 🏆 What Makes Ground Truth Different?

✅ **Live Data:** No stale databases, all results from real-time fetching  
✅ **Caching:** 5-minute cache for performance without sacrificing freshness  
✅ **MCP Native:** Built for AI agents from day one  
✅ **Edge Computing:** Fast responses from Cloudflare's global network  
✅ **Free Tier:** No credit card required to try it  
✅ **Transparent Pricing:** $9/month, unlimited usage, no hidden fees  
✅ **x402 Fallback:** Pay-per-call with crypto if you don't want a subscription  

---

## 📈 Roadmap

- [x] Core fact-checking tools
- [x] Stripe billing integration
- [x] API key authentication
- [x] Free tier (check_endpoint)
- [x] Webhook handling for subscriptions
- [ ] Usage analytics dashboard
- [ ] Email notifications
- [ ] Team accounts
- [ ] Enterprise tier
- [ ] Custom integrations

---

## 🙏 Acknowledgments

- Built with [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- Powered by [Cloudflare Workers](https://workers.cloudflare.com)
- Payments by [Stripe](https://stripe.com)
- x402 integration by [@x402](https://x402.org)

---

**Made with ❤️ by [Anish Das](https://github.com/anish632)**

_Last updated: March 20, 2026_
