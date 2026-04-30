# Ground Truth — Claude Code Skill

A zero-deployment version of Ground Truth that runs directly inside Claude Code. It gives you the same verification workflow without needing to run the MCP server.

## What This Is

Ground Truth is a verification layer for AI agents. This skill is the Claude Code version.

Claude Code supports "skills" — markdown instruction files that give Claude structured workflows. This skill packages the Ground Truth checks into a single `/ground-truth` command you run conversationally.

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
/ground-truth market: "edge orm" on npm
/ground-truth pricing: https://stripe.com/pricing
/ground-truth compare: react vue
/ground-truth verify: "AWS Business support includes 24/7 phone support" — check aws.amazon.com/premiumsupport/plans
/ground-truth hypothesis: "there are fewer than 50 MCP tools on npm" — test npm count < 50
```

## How It Compares to the MCP Server

| | MCP Server | Claude Code Skill |
|---|---|---|
| **Setup** | Connect to remote URL | Copy one file |
| **Cost** | Free endpoint checks, pay-per-use, or $9/mo team plan | Free (uses your Claude subscription) |
| **Callable by other agents** | Yes (via MCP) | No (session-only) |
| **Pricing extraction** | Regex patterns | Semantic reading — more accurate |
| **Claim verification** | Keyword hit-rate | Claude reads and reasons about the page |
| **Caching** | 5-min SQLite cache | Session memory only |

## When to Use Each

**Use the MCP server when:**
- Other AI agents need to call these checks programmatically
- You want persistent caching across many calls
- You're integrating with Claude Desktop, Cursor, or other MCP clients

**Use this skill when:**
- You're already in Claude Code and want zero setup
- You need pricing or claim verification (semantic understanding beats regex)
- You want to customize the workflow or add new check types

## Requirements

- [Claude Code](https://claude.ai/claude-code) CLI installed
- Active Claude subscription
