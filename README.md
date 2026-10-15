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

This repo also ships a **stdio MCP server** (TypeScript, `@modelcontextprotocol/sdk`) under [`mcp/`](./mcp). It exposes the tool `edgar_company_filings_and_facts`, which runs the same Apify Actor via the Apify API. `initialize` and `tools/list` work **without** a token; tool calls require `APIFY_TOKEN`.

### Install & run (Node)

```bash
cd mcp
npm install
npm run build
APIFY_TOKEN=your_token node dist/index.js
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

For Glama, paste the repo-root Dockerfile from [`Dockerfile.mcp`](./Dockerfile.mcp) when adding the server (build context = repository root).

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
| `formTypes` | `string[]` | `[]` | Form filter; empty = all |
| `since` | `YYYY-MM-DD` | — | Keep filings with `filingDate >= since` |
| `maxFilingsPerCompany` | `int` | `10` | Cap filing rows per company |
| `metrics` | `string[]` | defaults | XBRL concept names; empty uses a curated us-gaap set |
| `maxFactsPerMetric` | `int` | `8` | Most-recent values per concept/unit |
| `includeTextExcerpt` | `bool` | `false` | Fetch primary document text |
| `excerptMaxChars` | `int` | `2000` | Excerpt length cap |

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

## Disclaimer

Data originates from the U.S. Securities and Exchange Commission EDGAR system. Fairquery and this Actor provide **no warranty** of completeness or fitness for trading decisions. **This is not investment advice.**
