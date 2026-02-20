# Ground Truth — Claude Code Skill

An alternative implementation of ground-truth verification as a [Claude Code](https://claude.ai/claude-code) skill. Instead of deploying a server, you get the same capabilities directly inside your Claude Code session — with semantic reasoning instead of regex.

## What This Is

Claude Code supports "skills" — markdown instruction files that give Claude structured workflows to follow. This skill implements all six ground-truth tools from the MCP server as a single `/ground-truth` command you invoke conversationally.

## Installation

Copy `ground-truth.md` to your Claude Code commands directory:

```bash
# User-level (available in all projects)
cp ground-truth.md ~/.claude/commands/ground-truth.md

# Or project-level (available only in current project)
mkdir -p .claude/commands
cp ground-truth.md .claude/commands/ground-truth.md
```

Then use it in any Claude Code session:

```
/ground-truth check https://api.openai.com/v1/models
/ground-truth market: "mcp memory server" on npm
/ground-truth pricing: https://stripe.com/pricing
/ground-truth compare: express fastify koa
/ground-truth verify: "Stripe has a free tier" — check stripe.com/pricing
/ground-truth hypothesis: "competition in MCP tools is low" — test npm count < 10
```

## How It Compares to the MCP Server

| | MCP Server | Claude Code Skill |
|---|---|---|
| **Setup** | Deploy to Cloudflare Workers | Copy one file |
| **Cost** | $0.01–$0.05 per tool call (x402) | Free (uses your Claude subscription) |
| **Callable by other agents** | Yes (via MCP protocol) | No (session-only) |
| **Pricing extraction** | Regex patterns | Semantic reading — more accurate |
| **Claim verification** | 50% keyword hit-rate | Claude reads and reasons about the page |
| **Endpoint checks** | `fetch()` with status codes | `curl` with millisecond timing |
| **PyPI search** | HTML regex scraping | Semantic reading of search results |
| **Caching** | 5-min SQLite cache across calls | Session memory (no cross-session cache) |

## When to Use Each

**Use the MCP server when:**
- You need other AI agents to call these checks programmatically
- You want to monetize access to the checks via x402
- You need persistent caching across many calls

**Use this skill when:**
- You're already using Claude Code and want zero deployment overhead
- You need pricing or claim verification (semantic understanding beats regex here)
- You want to customize the workflow or add new check types

## Extending the Skill

The skill is plain markdown. Add new modes by extending Step 1's detection table and Step 2's execution instructions. No TypeScript, no deployment, no Wrangler config.

## Requirements

- [Claude Code](https://claude.ai/claude-code) CLI installed
- Active Claude subscription
