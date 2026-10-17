# Fairquery EDGAR: SEC Company Filings & Financial Facts

**[Apify Store](https://apify.com/fairquery/edgar-company-facts-filings)** · **MCP via Apify** · Contact: [fairquery@proton.me](mailto:fairquery@proton.me)

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


## Local stdio MCP server

This repo also ships a **stdio MCP server** (TypeScript, `@modelcontextprotocol/sdk`) under [`mcp/`](./mcp) with single-purpose tools. Five are **free** and call sec.gov directly (no token, brand User-Agent `Fairquery`, throttled to ≤5 req/s); one optional bulk tool runs the Apify Actor. `initialize` and `tools/list` work **without** a token.

| Tool | What it does | Paging | Cost |
|---|---|---|---|
| `edgar_resolve_company` | Ticker / CIK / name fragment → SEC CIK, ticker, registrant name | – | free |
| `edgar_list_filings` | One company's filings, filter by `formTypes`, `since`, `until`; optional full history | `limit`/`offset` | free |
| `edgar_get_filing_document` | Primary (or named) filing document from sec.gov Archives as plain text, by URL or accession number | `offset`/`maxChars` (chars) | free |
| `edgar_get_company_facts` | XBRL facts: list available concepts (with `search`) or time series for `concepts`, filter by form / fiscal period / date | `limit`/`offset` | free |
| `edgar_get_concept_across_companies` | One concept for one period across all filers (SEC frames API), sortable, optional company filter | `limit`/`offset` | free |
| `edgar_batch_export` | Multi-company export of filings + facts + excerpts via the Apify Actor | – | pay-per-event, needs `APIFY_TOKEN` |

Paged tools return `{count, total, offset, hasMore, nextOffset, meta, items}`. Errors are returned as `{error, message, retryable}` with codes such as `COMPANY_NOT_FOUND`, `FILING_NOT_FOUND`, `NOT_FOUND`, `INVALID_URL`, `SEC_FETCH_FAILED`.

Live test of all free tools: `cd mcp && npm run build && node scripts/live-test.mjs`.

### Install & run (Node)

```bash
cd mcp
npm install
npm run build
node dist/index.js            # free tools
APIFY_TOKEN=your_token node dist/index.js   # also enables edgar_batch_export
```

### MCP client config (Cursor / Claude Desktop)

```json
{
  "mcpServers": {
    "fairquery-edgar": {
      "command": "node",
      "args": ["/absolute/path/to/edgar-company-facts-filings/mcp/dist/index.js"],
      "env": {
        "APIFY_TOKEN": "your_apify_token"
      }
    }
  }
}
```

### Docker

Build from `mcp/`:

```bash
cd mcp
docker build -t fairquery-edgar-mcp .
docker run -i -e APIFY_TOKEN=your_token fairquery-edgar-mcp
```

The repo-root `Dockerfile` builds this stdio MCP server (build context = repository root) and is what Glama uses. The Apify Actor image is built from [`.actor/Dockerfile`](./.actor/Dockerfile).

### Glama

`glama.json` lists `fairquery` as maintainer. After Glama indexes the server, claim ownership if needed.

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

## Pricing (pay-per-event)

No subscription. Users are charged for these events (plus Apify’s default `apify-actor-start`):

| Event | Price | When |
| --- | --- | --- |
| `apify-actor-start` | $0.00005 | Once when the run starts (Apify default) |
| `company-resolved` | $0.002 | Each successfully resolved company row |
| `filing` | $0.002 | Each filing row |
| `financial-fact` | $0.0005 | Each XBRL fact row |
| `text-excerpt` | $0.003 | Each primary-document text excerpt row |

Primary Store display event: **company-resolved**.

## Memory / runtime

Default **256 MB**, timeout 300s. HTTP-only (no browser).

## Local development

```bash
npm install
# put input in storage/key_value_stores/default/INPUT.json
npx apify run
npm test
```

Optional local PPE dry-run: `ACTOR_TEST_PAY_PER_EVENT=1 npx apify run`.

## Links

- **Apify Store:** https://apify.com/fairquery/edgar-company-facts-filings
- **MCP:** https://mcp.apify.com/?tools=fetch-actor-details,fairquery/edgar-company-facts-filings
- **Contact:** fairquery@proton.me

## License

MIT

## Kits & templates

Optional guides from Fairquery for wiring this Actor into agents and automations (the Actor works fine without them):

- [AI Agent Data Toolkit Quick-Start](https://fairquery.gumroad.com/l/qayngz) (PDF): MCP setup for Claude Desktop and Cursor, API calls, recipes, cost estimates.
- [n8n + Zapier Workflow Template Pack](https://fairquery.gumroad.com/l/koffbf): 10 importable n8n workflows for the four Fairquery Actors, plus Zapier setup guides.
- [Agent Prompt Pack for Research & Lead Ops](https://fairquery.gumroad.com/l/djdilu): 69 prompts for company research, lead cleaning, SEO and security reviews.
- [Agent Starter Kit: 10 copy-paste MCP + n8n recipes](https://fairquery.gumroad.com/l/idvrck) ($5): 10 copy-paste MCP + n8n recipes, with ready-made Claude/Cursor configs and 3 starter workflows.

## Disclaimer

Data originates from the U.S. Securities and Exchange Commission EDGAR system. Fairquery and this Actor provide **no warranty** of completeness or fitness for trading decisions. **This is not investment advice.**
