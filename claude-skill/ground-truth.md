---
name: ground-truth
description: Use when you need to verify claims, check API endpoints, assess market competition, or test hypotheses against live data
allowed-tools:
  - WebFetch
  - Bash(curl:*)
  - AskUserQuestion
---

# /ground-truth — Live Data Verification

Verify claims and hypotheses against real-time data. Never trust training data when live checks are possible.

## Usage

```
/ground-truth <anything natural language>
```

**Examples:**
```
/ground-truth check https://api.openai.com/v1/models
/ground-truth market: "mcp memory server" on npm
/ground-truth pricing: https://stripe.com/pricing
/ground-truth compare: express fastify koa
/ground-truth verify: "Anthropic Claude API supports streaming" — check docs.anthropic.com
/ground-truth hypothesis: "competition in MCP memory tools is low" — test npm count < 10
```

---

## Step 1: Detect Mode

Parse the user's input and infer the check type. If ambiguous, ask one clarifying question.

| Input Pattern | Mode |
|---|---|
| URL only, or "check \<url\>" | **endpoint** |
| "market:" or "how many packages" or "npm/pypi count" | **market** |
| "pricing:" or "how much does" or pricing page URL | **pricing** |
| "compare:" or multiple package names | **compare** |
| "verify:" or "is it true that" or a factual claim + URL | **verify** |
| "hypothesis:" or "test if" or "assume that" | **hypothesis** |
| Unclear | Ask the user which mode |

---

## Step 2: Execute the Check

### MODE: endpoint

**What to do:** Use `curl` (not WebFetch) for precise HTTP status codes and millisecond timing.

```bash
curl -o /dev/null -s -w "status=%{http_code} time_ms=%{time_total*1000} content_type=%{content_type}" \
  -H "User-Agent: GroundTruth/1.0" \
  -L --max-time 10 \
  "<URL>"
```

Also fetch the first 1000 chars of the response body for structure inspection:
```bash
curl -s -H "User-Agent: GroundTruth/1.0" -L --max-time 10 "<URL>" | head -c 1000
```

**Report:**
- URL
- Accessible (true if 2xx)
- HTTP status code
- Response time in ms
- Content-Type header
- Auth required (401 or 403)
- Rate limited (429)
- Sample of response body (first 500 chars, formatted if JSON)

---

### MODE: market

**What to do:** Query the registry API directly.

**For npm:**
```
WebFetch: https://registry.npmjs.org/-/v1/search?text=<query>&size=20
```
Extract: `total` (total result count), top 10 `objects[].package.name`, `objects[].package.version`, `objects[].score.final`

**For PyPI:**
```
WebFetch: https://pypi.org/search/?q=<query>
```
Use Claude's reading of the HTML to extract package names, versions, and descriptions.

**Report:**
- Registry
- Query
- Total results count
- Top 10 packages: name, version, score/description
- Competitive signal: crowded (>50 results), moderate (10–50), or sparse (<10)?

---

### MODE: pricing

**What to do:** Fetch the pricing page and use semantic understanding (not regex) to extract pricing.

```
WebFetch: <pricing URL>
```

**Extract and report:**
- Detected price points (e.g., "$9/mo", "$49/user/month")
- Plan names (free, starter, pro, enterprise, etc.)
- Whether a free tier exists
- Whether a free trial is mentioned
- Highest price point found
- Pricing model type: per-seat, usage-based, flat, freemium, etc.
- Notable restrictions (e.g., "only 3 users on free tier")

Use judgment, not pattern matching. Read the page as a human would.

---

### MODE: compare

**What to do:** Fetch metadata for each package from the registry.

**npm:**
```
WebFetch: https://registry.npmjs.org/<package-name>
```
Extract: `description`, `dist-tags.latest`, `license`, `time.created`, `time[latest]` (last publish), total versions, `keywords`

**PyPI:**
```
WebFetch: https://pypi.org/pypi/<package-name>/json
```
Extract: `info.summary`, `info.version`, `info.license`, `info.author`, `info.keywords`

**Report as a comparison table:**

| Package | Version | Last Published | License | Description |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

Then provide a brief qualitative assessment of which appears most actively maintained and any notable differences.

---

### MODE: verify

**What to do:** Check each URL for evidence supporting or contradicting the claim. Use Claude's semantic reasoning, not keyword counting.

For each URL provided (or up to 5 URLs inferred from the claim context):
```
WebFetch: <url>
```

For each page, answer three questions:
1. Does this page support the claim?
2. Does this page contradict the claim?
3. Is the page relevant at all?

**Report:**
- Claim being verified
- For each source: URL, verdict (SUPPORTS / CONTRADICTS / IRRELEVANT), and a 1–2 sentence quote or paraphrase of the key evidence
- Overall verdict:
  - **CONFIRMED** — all relevant sources support it
  - **LIKELY TRUE** — majority support, none directly contradict
  - **CONTESTED** — sources disagree
  - **LIKELY FALSE** — majority contradict
  - **UNVERIFIABLE** — no relevant content found
- Confidence note: what would change this verdict?

---

### MODE: hypothesis

**What to do:** Run a structured series of tests against the hypothesis. Infer tests from the hypothesis if not explicitly provided.

**For each test, run the appropriate check:**

| Test Type | Action |
|---|---|
| `endpoint_exists` | curl the URL, pass if 2xx |
| `npm_count_above <N>` | search npm, compare total to N |
| `npm_count_below <N>` | search npm, compare total to N |
| `response_contains <text>` | fetch URL, check if text appears |
| `claim_supported_by <url>` | fetch URL, Claude reads for support |

**Report each test:**
```
✅ PASS — npm count for "mcp memory": 7 results (threshold: < 10)
❌ FAIL — endpoint_exists https://x.ai/api: status 404
✅ PASS — "free tier" found on stripe.com/pricing
```

**Final verdict:**
- All pass → **SUPPORTED**
- All fail → **REFUTED**
- Mixed → **PARTIALLY SUPPORTED** (list which passed, which failed)

---

## Step 3: Output Format

Always structure your final output as:

```
## Ground Truth Report

**Mode:** <mode>
**Checked:** <timestamp or "live">

### Checks Run
<results for each check>

### Verdict
<SUPPORTED / REFUTED / CONFIRMED / etc.>

### Confidence Notes
<what additional checks would increase confidence, or what caveats exist>
```

If the user's original claim was wrong, say so plainly. The entire point of this command is honest ground truth — not confirmation.

---

## Why Semantic > Syntactic

This skill has Claude's full reasoning capability, which makes it more capable than the MCP server for several tools:

| Tool | MCP server approach | This skill |
|---|---|---|
| `check_pricing` | 3 hardcoded regex patterns | Claude reads the page as a human would |
| `verify_claim` | 50% keyword hit-rate vote | Claude judges whether the page actually supports the claim |
| `estimate_market` (PyPI) | Regex on raw HTML | Claude reads the page content |

The MCP server used regex and threshold counting because it has no intelligence. This skill does — prefer reading pages semantically over pattern matching.
