# EDGAR Company Facts & Filings for Agents

**Resolves US tickers, CIKs or company names via SEC EDGAR and returns filings and XBRL financial facts as structured rows, from $1.50 per 1,000 companies.** You pay $0.0015 per resolved company, $0.001 per filing row, $0.0002 per fact row and $0.002 per text excerpt. Error rows are free. Example: 2 companies with 5 filings each and 16 fact rows each cost 2 × $0.0015 + 10 × $0.001 + 32 × $0.0002 = **$0.02**, plus Apify's $0.00005 Actor-start fee.

Public Apify Actor that turns the SEC’s public EDGAR data into clean, structured rows for AI agents and MCP clients. Look up by **ticker**, **CIK**, or **company name**. Returns official entity metadata, recent filings (10-K, 10-Q, 8-K and more) with document URLs, XBRL company facts (Assets, Revenues, NetIncomeLoss, diluted EPS and more), and optional plain-text excerpts. Every row carries a schema version, a source SEC URL, and a timestamp. Errors are machine-readable codes.

> **Not investment advice.** Output is a structured mirror of public SEC EDGAR data for research and tooling. It is not a recommendation to buy, sell, or hold any security.

## When to use this (LLM / tool selection)

Use this Actor when an agent needs:

- Map a **ticker, CIK, or company name** → official SEC CIK / entity metadata
- Recent **SEC filings** (10-K, 10-Q, 8-K, …) with document URLs
- **XBRL company facts** (Assets, NetIncomeLoss, EPS, …) from `companyfacts`
- Optional **plain-text excerpts** from primary filing documents

Do **not** use it for realtime quotes, options chains, insider Form 4 parsing beyond what submissions expose, or non-US registries.

## MCP connection (Apify hosted)

Connect any MCP client to Apify’s MCP server with this Actor scoped in:

```json
{
  "mcpServers": {
    "fairquery-edgar": {
      "type": "http",
      "url": "https://mcp.apify.com/?tools=fetch-actor-details,fairquery/edgar-company-facts-filings"
    }
  }
}
```

Clients without OAuth can add `"headers": {"Authorization": "Bearer <APIFY_TOKEN>"}`.

**MCP URL:** `https://mcp.apify.com/?tools=fetch-actor-details,fairquery/edgar-company-facts-filings`

**Actor id:** `fairquery/edgar-company-facts-filings` (lowercase).

### Example agent prompts

- "Using the EDGAR tool, get Apple's and Microsoft's 10-K and 10-Q filings since 2023 and their latest Assets, NetIncomeLoss and diluted EPS."
- "Find the CIK for Nvidia and list its last five 8-K filings with links."

## Data sources (SEC fair access)

| Resource | URL |
| --- | --- |
| Tickers map | `https://www.sec.gov/files/company_tickers.json` |
| Submissions | `https://data.sec.gov/submissions/CIK##########.json` |
| Company facts | `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json` |

The Actor sends `User-Agent: Fairquery fairquery@proton.me` and throttles to **≤ 5 requests/second**.

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `companies` | `string[]` | — | Tickers (`AAPL`), CIKs (`320193`), or name fragments (`Apple`) |
| `mode` | `filings` \| `facts` \| `both` | `both` | Which row types to emit (always emits `company` when resolved) |
| `formTypes` | `string[]` | `["10-K","10-Q","8-K"]` | Form filter (case-insensitive); pass `[]` for all forms |
| `since` | `YYYY-MM-DD` | — | Keep filings with `filingDate >= since` |
| `maxFilingsPerCompany` | `int` (1–200) | `5` | Cap filing rows per company |
| `metrics` | `string[]` | `["Assets","NetIncomeLoss","EarningsPerShareDiluted","Revenues"]` | XBRL concept names (case-insensitive); `[]` uses a curated 10-concept us-gaap set |
| `maxFactsPerMetric` | `int` (1–50) | `4` | Most-recent values per concept/unit |
| `includeTextExcerpt` | `bool` | `false` | Fetch primary document text |
| `excerptMaxChars` | `int` (200–20,000) | `2000` | Excerpt length cap in characters |

### Example input

```json
{
  "companies": ["AAPL", "MSFT"],
  "mode": "both",
  "formTypes": ["10-K", "10-Q"],
  "since": "2023-01-01",
  "maxFilingsPerCompany": 5,
  "metrics": ["Assets", "NetIncomeLoss", "EarningsPerShareDiluted"],
  "includeTextExcerpt": false
}
```

Minimal:

```json
{"companies":["AAPL"],"mode":"both","formTypes":["10-K"],"metrics":["Assets","NetIncomeLoss"]}
```

## Output

One **dataset row per company, filing, fact, text excerpt, or error**. Every row includes:

- `schema_version` — currently `1.0.0`
- `type` — `company` | `filing` | `fact` | `text_excerpt` | `error`
- `source_url` — SEC URL the row came from
- `scraped_at` — ISO timestamp

### Error rows (machine-readable)

```json
{
  "schema_version": "1.0.0",
  "type": "error",
  "code": "COMPANY_NOT_FOUND",
  "message": "Could not resolve company query: ZZNOTREAL",
  "retryable": false,
  "query": "ZZNOTREAL",
  "source_url": "https://data.sec.gov/"
}
```

Codes include: `INPUT_EMPTY`, `COMPANY_NOT_FOUND`, `RESOLVE_FAILED`, `SUBMISSIONS_FETCH_FAILED`, `FACTS_FETCH_FAILED`, `EXCERPT_FETCH_FAILED`.

### Run summary

Key-value store record **`RUN_SUMMARY`** with counts, SEC request total, and echoed input.

## Pricing

No subscription. You pay for these events:

| Event | Price | When |
| --- | --- | --- |
| `company-resolved` | $0.0015 | Each successfully resolved company row |
| `filing` | $0.001 | Each filing row |
| `financial-fact` | $0.0002 | Each XBRL fact row |
| `text-excerpt` | $0.002 | Each primary-document text excerpt row |
| `apify-actor-start` | $0.00005 | Once per run, per GB of memory (Apify default event) |

Error rows (`COMPANY_NOT_FOUND`, `FACTS_FETCH_FAILED`, …) are **not charged**.

**Worked example:** `{"companies": ["AAPL", "MSFT"], "mode": "both", "maxFilingsPerCompany": 5, "metrics": ["Assets", "NetIncomeLoss", "EarningsPerShareDiluted", "Revenues"], "maxFactsPerMetric": 4}` returns 2 company rows, up to 10 filing rows and up to 32 fact rows: 2 × $0.0015 + 10 × $0.001 + 32 × $0.0002 = **$0.02** at most, plus $0.00005. Turning on `includeTextExcerpt` adds $0.002 per filing.

To cap spend, use `mode: "facts"` or `"filings"`, lower `maxFilingsPerCompany` / `maxFactsPerMetric`, or set a maximum cost per run in the run options (the Actor stops cleanly at the limit). Prices are from the Store pricing tab (October 2026).

## Memory / runtime

Default **256 MB**, timeout 300s. HTTP-only (no browser).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| API call rejected: `companies` is required | The input had no companies. The sample tickers in the Console form are prefill only and are not sent with API calls. |
| `COMPANY_NOT_FOUND` | The ticker, CIK or name fragment is not in the SEC ticker map (for example a non-US or delisted company). Try the CIK. These rows are free. |
| Fewer filings than expected | `formTypes` defaults to 10-K, 10-Q and 8-K. Pass `[]` for all forms, and check `since` and `maxFilingsPerCompany`. |
| A metric is missing from the facts | The company does not report that us-gaap concept (for example `Revenues` vs `RevenueFromContractWithCustomerExcludingAssessedTax`). Use the exact XBRL concept name. |
| `SUBMISSIONS_FETCH_FAILED` / `FACTS_FETCH_FAILED` | SEC servers were slow or rate-limiting (`retryable: true`). The Actor stays at or below 5 requests/second; re-run later. |

## FAQ

**Where does the data come from?**

From the SEC's public EDGAR JSON endpoints (ticker map, submissions, companyfacts), fetched with a declared User-Agent under SEC fair-access rules.

**Is this investment advice?**

No. It is a structured mirror of public SEC data for research and tooling.

**Does it include real-time prices or non-US companies?**

No. It covers SEC registrants only, with no market data.

**How much does a run cost?**

From $0.0015 per resolved company, plus $0.001 per filing row, $0.0002 per fact row and $0.002 per excerpt. A two-company example with filings and facts costs about $0.02.

**Can an AI agent call it?**

Yes, through [Apify MCP](https://mcp.apify.com) (see the scoped URL in the MCP section above). The stdio MCP server in the GitHub repo also has free tools that query sec.gov directly.

## Fairquery family

Other Fairquery tools on the Apify Store. Each one returns structured rows with machine-readable error codes, and error rows are never charged:

- [Email Validator for Agents (MX, Disposable, Typo)](https://apify.com/fairquery/email-validator-mx-disposable): syntax, MX, disposable, role and typo checks without sending mail; $0.79 per 1,000 emails
- [Website Contact & Company Enricher](https://apify.com/fairquery/website-contact-company-enricher): domain in, public business emails, phones, socials and company details out; $3 per 1,000 domains
- [Website Tech, SEO & llms.txt Check for Agents](https://apify.com/fairquery/website-tech-seo-ai-readiness): tech stack, SEO score, AI-crawler rules and llms.txt per site; $1.50 per 1,000 sites
- [Sanctions & Watchlist Screener (OFAC, EU, UK, UN)](https://apify.com/fairquery/sanctions-watchlist-screener): fuzzy name screening against official sanctions lists; $3 per 1,000 names + $0.007 per run
- [LLM Data Guard: PII & Secret Redactor](https://apify.com/fairquery/llm-data-guard-pii-secrets): redact PII and secrets before text reaches an LLM; $1.50 per 1,000 documents + $0.20 per 1,000 findings
- [Dependency Vulnerability Check for Agents](https://apify.com/fairquery/osv-dependency-vulnerability-check): packages and lockfiles against OSV.dev; $0.50 per 1,000 packages + $1.50 per 1,000 vulnerabilities
- **MCP server** [`@fairquery/agent-trust-mcp`](https://www.npmjs.com/package/@fairquery/agent-trust-mcp): one MCP server for Claude Desktop, Cursor and VS Code (`npx -y @fairquery/agent-trust-mcp`). It has 7 free tools that need no token, plus paid tools that call the PII, email, sanctions and OSV Actors with your own Apify token.

All Fairquery Actors: https://apify.com/fairquery

## Kits & templates

Optional guides from Fairquery for wiring this Actor into agents and automations (the Actor works fine without them):

- [AI Agent Data Toolkit Quick-Start](https://fairquery.gumroad.com/l/qayngz) (PDF): MCP setup for Claude Desktop and Cursor, API calls, recipes, cost estimates.
- [n8n + Zapier Workflow Template Pack](https://fairquery.gumroad.com/l/koffbf): 10 importable n8n workflows for the four Fairquery Actors, plus Zapier setup guides.
- [Agent Prompt Pack for Research & Lead Ops](https://fairquery.gumroad.com/l/djdilu): 69 prompts for company research, lead cleaning, SEO and security reviews.
- [Agent Starter Kit: 10 copy-paste MCP + n8n recipes](https://fairquery.gumroad.com/l/idvrck) ($5): 10 copy-paste MCP + n8n recipes, with ready-made Claude/Cursor configs and 3 starter workflows.

## Disclaimer

Data originates from the U.S. Securities and Exchange Commission EDGAR system. Fairquery and this Actor provide **no warranty** of completeness or fitness for trading decisions. **This is not investment advice.**

## Links

- Apify Store: https://apify.com/fairquery/edgar-company-facts-filings
- MCP: https://mcp.apify.com/?tools=fetch-actor-details,fairquery/edgar-company-facts-filings
- GitHub: https://github.com/fairquery/edgar-company-facts-filings
- Contact: fairquery@proton.me
- License: MIT
