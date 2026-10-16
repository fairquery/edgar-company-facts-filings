#!/usr/bin/env node
/**
 * Fairquery EDGAR stdio MCP server.
 * - edgar_resolve_company: free, calls SEC's public ticker map directly (no token, no cost).
 * - edgar_company_filings_and_facts: runs the public Apify Actor fairquery/edgar-company-facts-filings
 *   (requires APIFY_TOKEN, pay-per-event).
 * initialize and tools/list work without any token.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { READ_ONLY_OPEN_WORLD, compact, errorResult, proxyActor, rowsOutputSchema, rowsResult } from './common.js';

const ACTOR_ID = 'fairquery~edgar-company-facts-filings';
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_USER_AGENT = 'Fairquery fairquery@proton.me';

type TickerEntry = { cik_str: number; ticker: string; title: string };
let tickerCache: { at: number; rows: TickerEntry[] } | undefined;

async function loadTickers(): Promise<TickerEntry[]> {
    if (tickerCache && Date.now() - tickerCache.at < 6 * 3600_000) return tickerCache.rows;
    const res = await fetch(SEC_TICKERS_URL, { headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`SEC ticker map HTTP ${res.status}`);
    const rows = Object.values((await res.json()) as Record<string, TickerEntry>);
    tickerCache = { at: Date.now(), rows };
    return rows;
}

function resolveOne(rows: TickerEntry[], query: string, limit: number): Record<string, unknown>[] {
    const q = query.trim();
    const base = { type: 'company_match', query: q, source_url: SEC_TICKERS_URL };
    const fmt = (r: TickerEntry, match: string) => ({
        ...base,
        match,
        cik: String(r.cik_str).padStart(10, '0'),
        ticker: r.ticker,
        name: r.title,
        submissions_url: `https://data.sec.gov/submissions/CIK${String(r.cik_str).padStart(10, '0')}.json`,
    });
    if (/^\d{1,10}$/.test(q)) {
        const hit = rows.filter((r) => r.cik_str === Number(q));
        if (hit.length) return hit.slice(0, limit).map((r) => fmt(r, 'cik'));
    }
    const up = q.toUpperCase();
    const tick = rows.filter((r) => r.ticker.toUpperCase() === up);
    if (tick.length) return tick.slice(0, limit).map((r) => fmt(r, 'ticker'));
    const name = rows.filter((r) => r.title.toUpperCase().includes(up));
    if (name.length) return name.slice(0, limit).map((r) => fmt(r, 'name'));
    return [{ type: 'error', code: 'COMPANY_NOT_FOUND', message: `No SEC ticker map entry for: ${q}`, retryable: false, query: q }];
}

function createServer(): McpServer {
    const server = new McpServer({ name: 'fairquery-edgar', version: '1.1.0' });

    server.registerTool(
        'edgar_resolve_company',
        {
            title: 'Resolve company to SEC CIK (free)',
            description: [
                'Resolve US company tickers, CIKs or name fragments to official SEC CIK numbers, tickers and registrant names using the SEC public ticker map (company_tickers.json).',
                'Use this first when you only need an identifier (e.g. "what is Nvidia\'s CIK?") or want to confirm which company a name refers to before fetching filings/facts. For filings or financial data use edgar_company_filings_and_facts instead.',
                'Behavior: read-only HTTP GET to sec.gov, no API token, no cost; the map is cached for 6 hours. Covers SEC registrants with a listed ticker only (no delisted/private filers).',
                'Returns {count, items}: one "company_match" row per match (cik zero-padded to 10 digits, ticker, name, match = cik|ticker|name, submissions_url), or an "error" row with code COMPANY_NOT_FOUND. Exact ticker/CIK matches win over name substring matches.',
            ].join('\n'),
            inputSchema: {
                queries: z
                    .array(z.string().min(1).max(200))
                    .min(1)
                    .max(50)
                    .describe('1-50 tickers ("NVDA"), CIKs ("1045810" or zero-padded) or case-insensitive name fragments ("nvidia")'),
                maxMatchesPerQuery: z
                    .number()
                    .int()
                    .min(1)
                    .max(25)
                    .default(5)
                    .describe('Max rows per query for name-fragment searches (default 5)'),
            },
            outputSchema: rowsOutputSchema,
            annotations: { title: 'Resolve company to SEC CIK (free)', ...READ_ONLY_OPEN_WORLD },
        },
        async ({ queries, maxMatchesPerQuery }) => {
            try {
                const rows = await loadTickers();
                return rowsResult(queries.flatMap((q) => resolveOne(rows, q, maxMatchesPerQuery ?? 5)));
            } catch (e) {
                return errorResult('SEC_FETCH_FAILED', e instanceof Error ? e.message : String(e), true);
            }
        },
    );

    server.registerTool(
        'edgar_company_filings_and_facts',
        {
            title: 'EDGAR company filings & XBRL facts',
            description: [
                'Fetch structured SEC EDGAR data for US public companies: entity metadata, recent filings (10-K, 10-Q, 8-K, S-1, DEF 14A, ...) with document URLs, XBRL financial facts (Assets, Revenues, NetIncomeLoss, EarningsPerShareDiluted, ...) and optional plain-text excerpts of primary filing documents.',
                'When to use: an agent needs filing lists/links or reported financial values from official SEC data. mode="filings" for filing history/links, "facts" for financial numbers, "both" for both. Use edgar_resolve_company instead if you only need a CIK. Not for real-time quotes, prices, options, non-US companies or investment advice.',
                'Behavior: read-only; runs the Fairquery Apify Actor fairquery/edgar-company-facts-filings via the Apify API, which queries sec.gov (throttled to <=5 req/s). Requires the APIFY_TOKEN environment variable. Typical run 5-60 s; the call waits up to ~5 minutes.',
                'Cost (billed to the Apify account, pay per event): $0.00005 per run, $0.002 per resolved company, $0.002 per filing row, $0.0005 per fact row, $0.003 per text excerpt. Keep maxFilingsPerCompany, metrics and maxFactsPerMetric small to limit cost; e.g. 1 company, 5 filings, 3 metrics x 4 values ~ $0.018.',
                'Returns {count, items}. Every row has schema_version, type (company | filing | fact | text_excerpt | error), source_url and scraped_at. filing rows: cik, ticker, form, filing_date, report_date, accession_number, primary_document, document_url. fact rows: taxonomy, concept, label, unit, value, start, end, filed, form. error rows: code (INPUT_EMPTY, COMPANY_NOT_FOUND, RESOLVE_FAILED, SUBMISSIONS_FETCH_FAILED, FACTS_FETCH_FAILED, EXCERPT_FETCH_FAILED), message, retryable. Unresolvable companies produce an error row, not a failure.',
            ].join('\n'),
            inputSchema: {
                companies: z
                    .array(z.string().min(1))
                    .min(1)
                    .max(50)
                    .describe('Tickers ("AAPL"), CIKs ("320193") or company name fragments ("Apple"). Example: ["AAPL","MSFT"]'),
                mode: z
                    .enum(['filings', 'facts', 'both'])
                    .default('both')
                    .describe('"filings" = filing list only, "facts" = XBRL facts only, "both" (default). A company row is always included when resolved.'),
                formTypes: z
                    .array(z.string())
                    .optional()
                    .describe('Filter filings by form type, e.g. ["10-K","10-Q"] or ["8-K"]. Omit/empty = all forms. Ignored when mode="facts".'),
                since: z
                    .string()
                    .regex(/^\d{4}-\d{2}-\d{2}$/)
                    .optional()
                    .describe('Only filings with filingDate >= this date (YYYY-MM-DD), e.g. "2023-01-01".'),
                maxFilingsPerCompany: z
                    .number()
                    .int()
                    .min(1)
                    .max(100)
                    .optional()
                    .describe('Max filing rows per company, newest first (default 10). Each row is billed.'),
                metrics: z
                    .array(z.string())
                    .optional()
                    .describe('XBRL us-gaap/dei concept names (case-sensitive), e.g. ["Assets","Revenues","NetIncomeLoss","EarningsPerShareDiluted"]. Omit for a curated default set (~10 concepts).'),
                maxFactsPerMetric: z
                    .number()
                    .int()
                    .min(1)
                    .max(50)
                    .optional()
                    .describe('Most-recent values kept per concept and unit (default 8). Each fact row is billed.'),
                includeTextExcerpt: z
                    .boolean()
                    .optional()
                    .describe('Also fetch a plain-text excerpt of each filing\'s primary document (default false; $0.003 each, slower).'),
                excerptMaxChars: z
                    .number()
                    .int()
                    .min(100)
                    .max(50000)
                    .optional()
                    .describe('Max characters per excerpt (default 2000). Only used with includeTextExcerpt=true.'),
            },
            outputSchema: rowsOutputSchema,
            annotations: { title: 'EDGAR company filings & XBRL facts', ...READ_ONLY_OPEN_WORLD },
        },
        async (args) => proxyActor(ACTOR_ID, compact({ ...args, mode: args.mode ?? 'both' })),
    );

    return server;
}

async function main(): Promise<void> {
    await createServer().connect(new StdioServerTransport());
}

main().catch((err) => {
    console.error('fairquery-edgar MCP server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
});
