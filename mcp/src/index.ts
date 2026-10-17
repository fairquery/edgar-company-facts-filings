#!/usr/bin/env node
/**
 * Fairquery EDGAR stdio MCP server.
 * Free tools (direct sec.gov, no token): edgar_resolve_company, edgar_list_filings, edgar_get_filing_document,
 *   edgar_get_company_facts, edgar_get_concept_across_companies.
 * - edgar_batch_export (paid): runs the public Apify Actor fairquery/edgar-company-facts-filings
 *   (requires APIFY_TOKEN, pay-per-event).
 * initialize and tools/list work without any token.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { READ_ONLY_OPEN_WORLD, compact, errorResult, jsonResult, pagedOutputSchema, pagedResult, proxyActor, rowsOutputSchema, rowsResult } from './common.js';
import { SEC_TICKERS_URL, SecHttpError, htmlToText, loadTickers, padCik, resolveCik, secJson, secText, type TickerEntry } from './sec.js';

const ACTOR_ID = 'fairquery~edgar-company-facts-filings';
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
    const server = new McpServer({ name: 'fairquery-edgar', version: '1.2.2' });

    server.registerTool(
        'edgar_resolve_company',
        {
            title: 'Resolve company to SEC CIK (free)',
            description: [
                'Resolve US company tickers, CIKs or name fragments to official SEC CIK numbers, tickers and registrant names using the SEC public ticker map (company_tickers.json).',
                'Use this first when you only need an identifier (e.g. "what is Nvidia\'s CIK?") or want to confirm which company a name refers to before fetching filings/facts. Next steps: edgar_list_filings for filings, edgar_get_company_facts for financial data.',
                'Behavior: read-only HTTP GET to sec.gov, no API token, no cost; the map is cached for 6 hours. Covers SEC registrants with a listed ticker only (no delisted/private filers).',
                'RETURNS: {count, items}: one "company_match" row per match (cik zero-padded to 10 digits, ticker, name, match = cik|ticker|name, submissions_url), or an "error" row with code COMPANY_NOT_FOUND. Exact ticker/CIK matches win over name substring matches.',
                "WHEN NOT TO USE: not for filings (edgar_list_filings) or financial values (edgar_get_company_facts); other tools already accept tickers/names directly.",
                "COST: free - direct sec.gov requests from this MCP server, no APIFY_TOKEN, no Apify billing.",
                'PARAMETERS: queries: each string is resolved independently and returns its own rows (or its own COMPANY_NOT_FOUND row), so mixed batches never fail as a whole. Precedence per query: all-digit strings are tried as a CIK first (leading zeros optional; must be in the ticker map), then an exact ticker (case-insensitive; class shares like "BRK-B" use a dash), then a case-insensitive substring of the registrant name; the first rule that matches wins and later rules are not applied. maxMatchesPerQuery caps the rows of every query, but only matters for broad name fragments (e.g. "bank") and for CIKs with several tickers (GOOG/GOOGL); raise it (max 25) to see more candidates, then pass the chosen ticker or cik to the other tools.',
                "EXAMPLE: {\"queries\":[\"NVDA\",\"apple\"]} -> {count:2, items:[{type:\"company_match\", cik:\"0001045810\", ticker:\"NVDA\", name:\"NVIDIA CORP\", match:\"ticker\"}, ...]}",
            ].join('\n'),
            inputSchema: {
                queries: z
                    .array(z.string().min(1).max(200))
                    .min(1)
                    .max(50)
                    .describe('Required. 1-50 strings, 1-200 chars each: a ticker ("NVDA", "BRK-B"), a CIK of 1-10 digits ("1045810" or "0001045810") or a case-insensitive registrant-name fragment ("nvidia"). Example: ["NVDA","apple","320193"]'),
                maxMatchesPerQuery: z
                    .number()
                    .int()
                    .min(1)
                    .max(25)
                    .default(5)
                    .describe('Optional integer 1-25, default 5. Max company_match rows returned per query (matters for name fragments and multi-ticker CIKs). Example: 10'),
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

    const companyArg = z
        .string()
        .min(1)
        .max(200)
        .describe('Required, 1-200 chars. Ticker ("AAPL", case-insensitive), CIK of 1-10 digits ("320193" or "0000320193"; any SEC filer, even without a ticker) or registrant-name fragment ("Apple"; the first SEC ticker-map match is used). Call edgar_resolve_company first if a name is ambiguous.');
    const limitArg = (def: number, max: number) =>
        z.number().int().min(1).max(max).default(def).describe(`Optional page size: items to return, integer 1-${max} (default ${def}). Example: ${Math.min(def, 10)}`);
    const offsetArg = z.number().int().min(0).default(0).describe('Optional zero-based number of items to skip, integer >= 0 (default 0); pass nextOffset from the previous response, e.g. 20');
    const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

    async function requireCompany(q: string) {
        const c = await resolveCik(q);
        if (!c) throw Object.assign(new Error(`No SEC company matches "${q}"`), { code: 'COMPANY_NOT_FOUND' });
        return c;
    }
    function fail(e: unknown) {
        const code = (e as { code?: string }).code;
        if (code) return errorResult(code, (e as Error).message, false);
        if (e instanceof SecHttpError && e.status === 404) return errorResult('NOT_FOUND', e.message, false);
        return errorResult('SEC_FETCH_FAILED', e instanceof Error ? e.message : String(e), true);
    }

    type Recent = Record<string, (string | number)[]>;
    type Submissions = { cik: string; name: string; tickers?: string[]; filings: { recent: Recent; files: { name: string }[] } };
    function recentRows(cik: string, r: Recent): Record<string, unknown>[] {
        const n = (r.accessionNumber ?? []).length;
        const out: Record<string, unknown>[] = [];
        for (let i = 0; i < n; i++) {
            const acc = String(r.accessionNumber[i]);
            const doc = String(r.primaryDocument[i] ?? '');
            const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}`;
            out.push({
                accession_number: acc,
                form: r.form[i],
                filing_date: r.filingDate[i],
                report_date: r.reportDate?.[i] || null,
                primary_document: doc || null,
                primary_doc_description: r.primaryDocDescription?.[i] || null,
                items: r.items?.[i] || null,
                size_bytes: r.size?.[i] ?? null,
                document_url: doc ? `${base}/${doc}` : null,
                index_url: `${base}/${acc}-index.htm`,
            });
        }
        return out;
    }
    async function allFilings(cik: string, includeOlder: boolean) {
        const sub = await secJson<Submissions>(`https://data.sec.gov/submissions/CIK${cik}.json`);
        let rows = recentRows(cik, sub.filings.recent);
        if (includeOlder) {
            for (const f of sub.filings.files ?? []) {
                rows = rows.concat(recentRows(cik, await secJson<Recent>(`https://data.sec.gov/submissions/${f.name}`)));
            }
        }
        return { sub, rows };
    }

    server.registerTool(
        'edgar_list_filings',
        {
            title: 'List SEC filings for a company',
            description: [
                'List a single company\'s SEC EDGAR filings (newest first) with form type, filing/report dates, accession number and direct document URLs, filtered by form type and date range, with limit/offset paging.',
                'Use to find which filings exist (e.g. "Apple\'s 10-Ks since 2020", "Tesla 8-Ks this year") and to get an accession_number / document_url for edgar_get_filing_document. Not for financial values (use edgar_get_company_facts).',
                'Behavior: free, read-only GET to data.sec.gov submissions API (no token). By default searches the ~1000 most recent filings; set includeOlder=true to also load the full historical archive (more requests).',
                'RETURNS: {count,total,offset,hasMore,nextOffset,meta:{cik,name,tickers},items:[{accession_number,form,filing_date,report_date,primary_document,primary_doc_description,items,size_bytes,document_url,index_url}]}. Errors: COMPANY_NOT_FOUND, NOT_FOUND, SEC_FETCH_FAILED.',
                "WHEN NOT TO USE: for document text use edgar_get_filing_document; for XBRL numbers use edgar_get_company_facts; for many companies at once use edgar_batch_export (paid).",
                "COST: free - direct sec.gov requests from this MCP server, no APIFY_TOKEN, no Apify billing.",
                'PARAMETERS: company: a numeric value is always used as a CIK; text is matched as ticker, then name fragment (first match). formTypes: exact, case-insensitive equality on the form field, so "10-K" does not include amendments - add "10-K/A" explicitly; insider filings are "4", proxies "DEF 14A". since/until: both inclusive and compared with filing_date (not report_date); combine them for a window, e.g. since "2024-01-01" + until "2024-12-31". includeOlder: the default searches only the ~1000 newest filings, so for date windows older than a few years (or for very active filers) set it to true, which adds one SEC request per archive file. Filters are applied before paging: total counts matching filings, rows are newest first, and you continue with offset = nextOffset.',
                "EXAMPLE: {\"company\":\"AAPL\",\"formTypes\":[\"10-K\"],\"since\":\"2020-01-01\",\"limit\":5} -> 5 newest Apple 10-K rows with accession_number and document_url.",
            ].join('\n'),
            inputSchema: {
                company: companyArg,
                formTypes: z.array(z.string().min(1)).max(20).optional().describe('Optional, default omitted = all forms. 1-20 exact SEC form types (case-insensitive equality; amendments like "10-K/A" must be listed separately). Example: ["10-K","10-Q"], ["8-K"], ["4"], ["DEF 14A"]'),
                since: dateArg.optional().describe('Optional inclusive lower bound on filing_date, format YYYY-MM-DD (pattern ^\\d{4}-\\d{2}-\\d{2}$), e.g. "2020-01-01". Default: no lower bound.'),
                until: dateArg.optional().describe('Optional inclusive upper bound on filing_date, format YYYY-MM-DD (pattern ^\\d{4}-\\d{2}-\\d{2}$), e.g. "2024-12-31". Default: no upper bound.'),
                includeOlder: z.boolean().default(false).describe('Optional boolean, default false. true also loads the archived filings older than the ~1000 most recent (one extra SEC request per archive file). Example: true'),
                limit: limitArg(20, 200),
                offset: offsetArg,
            },
            outputSchema: pagedOutputSchema,
            annotations: { title: 'List SEC filings for a company', ...READ_ONLY_OPEN_WORLD },
        },
        async ({ company, formTypes, since, until, includeOlder, limit, offset }) => {
            try {
                const c = await requireCompany(company);
                const { sub, rows } = await allFilings(c.cik, includeOlder ?? false);
                const forms = formTypes?.length ? new Set(formTypes.map((f) => f.toUpperCase())) : undefined;
                const filtered = rows
                    .filter((r) => !forms || forms.has(String(r.form).toUpperCase()))
                    .filter((r) => !since || String(r.filing_date) >= since)
                    .filter((r) => !until || String(r.filing_date) <= until)
                    .sort((a, b) => String(b.filing_date).localeCompare(String(a.filing_date)));
                return pagedResult(filtered, offset ?? 0, limit ?? 20, {
                    cik: c.cik,
                    name: sub.name,
                    tickers: sub.tickers ?? [],
                    source_url: `https://data.sec.gov/submissions/CIK${c.cik}.json`,
                });
            } catch (e) {
                return fail(e);
            }
        },
    );

    server.registerTool(
        'edgar_get_filing_document',
        {
            title: 'Get SEC filing document text',
            description: [
                'Fetch the text of an SEC filing document from the sec.gov EDGAR archives, converted from HTML to plain text, returned in character-paged chunks.',
                'Use to read the actual content of a filing (risk factors, MD&A, 8-K press release, ...). Identify the document by documentUrl (from edgar_list_filings), or by company + accessionNumber (the primary document is used unless document names another file in the filing).',
                'Behavior: free, read-only GET to www.sec.gov (no token). Large 10-Ks can exceed 500k characters; read them in pages with offset/maxChars (nextOffset is returned). Only https://www.sec.gov/Archives/ URLs are accepted.',
                'RETURNS: {document_url,content_type,total_chars,offset,returned_chars,hasMore,nextOffset,text}. Errors: INVALID_URL, COMPANY_NOT_FOUND, FILING_NOT_FOUND, NOT_FOUND, SEC_FETCH_FAILED.',
                "WHEN NOT TO USE: to find which filings exist use edgar_list_filings first; for structured financial values use edgar_get_company_facts (no text parsing needed).",
                "COST: free - direct sec.gov requests from this MCP server, no APIFY_TOKEN, no Apify billing.",
                'PARAMETERS: give EITHER documentUrl (wins if present; company/accessionNumber/document are then ignored) OR company + accessionNumber (both required together, else INVALID_INPUT). accessionNumber accepts dashed "0000320193-24-000123" or 18 plain digits; without document the filing\'s primary document is fetched (looked up in recent, then archived filings), with document that file name inside the same filing folder is fetched directly (e.g. an exhibit "ex99-1.htm" listed on index_url). offset and maxChars are measured in characters of the converted text (or of the raw body when raw=true), not bytes: loop with offset = nextOffset until hasMore is false. raw=true returns the original HTML/XML unchanged, so total_chars and offsets differ from text mode; do not mix offsets from the two modes. Non-HTML files (.txt) are returned as is in either mode.',
                "EXAMPLE: {\"company\":\"AAPL\",\"accessionNumber\":\"0000320193-24-000123\",\"maxChars\":20000} -> first 20000 chars of the 10-K text with nextOffset for the next page.",
            ].join('\n'),
            inputSchema: {
                documentUrl: z.string().url().optional().describe('Optional (alternative to company + accessionNumber). Full URL that must start with https://www.sec.gov/Archives/ (else INVALID_URL), usually document_url from edgar_list_filings. Example: https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm'),
                company: companyArg.optional(),
                accessionNumber: z.string().regex(/^\d{10}-?\d{2}-?\d{6}$/).optional().describe('Optional; required together with company when documentUrl is omitted. Format 10-2-6 digits with optional dashes (pattern ^\\d{10}-?\\d{2}-?\\d{6}$), e.g. "0000320193-24-000123" or "000032019324000123"'),
                document: z.string().max(200).optional().describe('Optional, <= 200 chars, used only with company + accessionNumber. File name inside the filing folder to fetch instead of the primary document, e.g. "ex99-1.htm". Default: primary document'),
                offset: z.number().int().min(0).default(0).describe('Optional integer >= 0, default 0. Character offset into the (converted) document to start from; pass nextOffset from the previous page. Example: 20000'),
                maxChars: z.number().int().min(500).max(100000).default(20000).describe('Optional integer 500-100000, default 20000. Max characters returned in this page. Example: 50000'),
                raw: z.boolean().default(false).describe('Optional boolean, default false. true returns the raw HTML/XML body instead of extracted plain text (offsets then refer to the raw body)'),
            },
            outputSchema: {
                document_url: z.string(),
                content_type: z.string(),
                total_chars: z.number().int(),
                offset: z.number().int(),
                returned_chars: z.number().int(),
                hasMore: z.boolean(),
                nextOffset: z.number().int().nullable(),
                text: z.string(),
            },
            annotations: { title: 'Get SEC filing document text', ...READ_ONLY_OPEN_WORLD },
        },
        async ({ documentUrl, company, accessionNumber, document, offset, maxChars, raw }) => {
            try {
                let url = documentUrl;
                if (!url) {
                    if (!company || !accessionNumber) return errorResult('INVALID_INPUT', 'Provide documentUrl, or company + accessionNumber.');
                    const c = await requireCompany(company);
                    const digits = accessionNumber.replace(/-/g, '');
                    const acc = `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
                    const base = `https://www.sec.gov/Archives/edgar/data/${Number(c.cik)}/${digits}`;
                    if (document) url = `${base}/${document}`;
                    else {
                        let hit = (await allFilings(c.cik, false)).rows.find((r) => r.accession_number === acc);
                        if (!hit) hit = (await allFilings(c.cik, true)).rows.find((r) => r.accession_number === acc);
                        if (!hit) return errorResult('FILING_NOT_FOUND', `Accession ${acc} not found for CIK ${c.cik}`);
                        url = String(hit.document_url ?? `${base}/${acc}.txt`);
                    }
                }
                if (!/^https:\/\/www\.sec\.gov\/Archives\//.test(url)) return errorResult('INVALID_URL', 'documentUrl must start with https://www.sec.gov/Archives/');
                const { text: body, contentType } = await secText(url);
                const full = raw || !/html|xml/i.test(contentType + url.slice(-5)) ? body : htmlToText(body);
                const start = Math.min(offset ?? 0, full.length);
                const chunk = full.slice(start, start + (maxChars ?? 20000));
                const hasMore = start + chunk.length < full.length;
                return jsonResult({
                    document_url: url,
                    content_type: contentType,
                    total_chars: full.length,
                    offset: start,
                    returned_chars: chunk.length,
                    hasMore,
                    nextOffset: hasMore ? start + chunk.length : null,
                    text: chunk,
                });
            } catch (e) {
                return fail(e);
            }
        },
    );

    type FactPoint = { val: number; start?: string; end: string; fy?: number; fp?: string; form?: string; filed?: string; accn?: string; frame?: string };
    type CompanyFacts = { cik: number; entityName: string; facts: Record<string, Record<string, { label?: string; description?: string; units: Record<string, FactPoint[]> }>> };

    server.registerTool(
        'edgar_get_company_facts',
        {
            title: 'Get XBRL financial facts for a company',
            description: [
                'Get reported XBRL financial data (us-gaap, ifrs-full, dei, ...) for one company from the SEC companyfacts API, e.g. Assets, Revenues, NetIncomeLoss, EarningsPerShareDiluted.',
                'Two modes: (1) omit concepts to LIST the concepts the company reports (name, label, units, number of values) so you can pick exact names; (2) pass concepts to get their time-series values, newest first, optionally filtered by form (10-K/10-Q), fiscal period or date. Use edgar_get_concept_across_companies to compare one concept across many companies.',
                'Behavior: free, read-only GET to data.sec.gov (no token). Concept names are case-sensitive. Values are as reported (duplicates across filings possible; set dedupe=true to keep one value per period).',
                'RETURNS: paged {count,total,offset,hasMore,nextOffset,meta:{cik,name},items}. List mode items: {taxonomy,concept,label,units,values}. Values mode items: {taxonomy,concept,label,unit,value,start,end,fy,fp,form,filed,accession_number,frame}. Errors: COMPANY_NOT_FOUND, NOT_FOUND (no XBRL data), SEC_FETCH_FAILED.',
                "WHEN NOT TO USE: for filing documents/text use edgar_list_filings + edgar_get_filing_document; for one concept across all companies use edgar_get_concept_across_companies.",
                "COST: free - direct sec.gov requests from this MCP server, no APIFY_TOKEN, no Apify billing.",
                'PARAMETERS: concepts switches the mode: omitted/empty = list mode (only taxonomy and search apply; forms, fiscalPeriod, since and dedupe are ignored), non-empty = values mode (search is ignored). Concept names are case-sensitive and must match exactly as listed (e.g. "NetIncomeLoss", not "netincome"); names the company never reported come back in meta.missing_concepts instead of failing. Many companies report revenue as "RevenueFromContractWithCustomerExcludingAssessedTax" rather than "Revenues", so run list mode with search "revenue" first. taxonomy applies in both modes. In values mode the filters combine with AND: forms matches the form of the filing that reported the value (["10-K"] = annual reports), fiscalPeriod matches fp ("FY" = full year; "Q4" is rarely reported separately), since compares the period end date. dedupe=true keeps one value per concept/unit/start-end period (the latest filed, i.e. restated) - set false to see every filing\'s figure. Rows are sorted by period end, newest first, then paged with limit/offset.',
                "EXAMPLE: {\"company\":\"MSFT\",\"concepts\":[\"Revenues\"],\"fiscalPeriod\":\"FY\",\"limit\":5} -> 5 newest annual Revenues values in USD.",
            ].join('\n'),
            inputSchema: {
                company: companyArg,
                concepts: z.array(z.string().min(1)).max(25).optional().describe('Optional; omit = list mode. 1-25 exact, case-sensitive XBRL concept names = values mode. Example: ["Revenues","NetIncomeLoss","Assets"]'),
                taxonomy: z.string().optional().describe('Optional, default omitted = all taxonomies. Exact taxonomy key: "us-gaap", "ifrs-full", "dei" or "srt". Example: "us-gaap"'),
                search: z.string().optional().describe('Optional, list mode only. Case-insensitive substring matched against concept name or label. Example: "revenue"'),
                forms: z.array(z.string()).optional().describe('Optional, values mode only, default all forms. Form types of the reporting filing (case-insensitive), e.g. ["10-K"] for annual or ["10-Q"] for quarterly figures'),
                fiscalPeriod: z.enum(['FY', 'Q1', 'Q2', 'Q3', 'Q4']).optional().describe('Optional, values mode only, one of "FY" | "Q1" | "Q2" | "Q3" | "Q4"; default all periods. Example: "FY"'),
                since: dateArg.optional().describe('Optional, values mode only. Keep values whose period end date >= this date, format YYYY-MM-DD, e.g. "2021-01-01"'),
                dedupe: z.boolean().default(true).describe('Optional boolean, values mode only, default true = one value per concept/unit/period (latest filed); false = every reported value incl. repeats from later filings'),
                limit: limitArg(50, 500),
                offset: offsetArg,
            },
            outputSchema: pagedOutputSchema,
            annotations: { title: 'Get XBRL financial facts for a company', ...READ_ONLY_OPEN_WORLD },
        },
        async ({ company, concepts, taxonomy, search, forms, fiscalPeriod, since, dedupe, limit, offset }) => {
            try {
                const c = await requireCompany(company);
                const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${c.cik}.json`;
                const data = await secJson<CompanyFacts>(url);
                const meta = { cik: c.cik, name: data.entityName, source_url: url };
                const taxes = Object.entries(data.facts ?? {}).filter(([t]) => !taxonomy || t === taxonomy);
                if (!concepts?.length) {
                    const s = search?.toLowerCase();
                    const rows = taxes
                        .flatMap(([t, cs]) =>
                            Object.entries(cs).map(([name, v]) => ({
                                taxonomy: t,
                                concept: name,
                                label: v.label ?? null,
                                units: Object.keys(v.units),
                                values: Object.values(v.units).reduce((n, a) => n + a.length, 0),
                            })),
                        )
                        .filter((r) => !s || r.concept.toLowerCase().includes(s) || String(r.label ?? '').toLowerCase().includes(s))
                        .sort((a, b) => a.concept.localeCompare(b.concept));
                    return pagedResult(rows, offset ?? 0, limit ?? 50, { ...meta, mode: 'list_concepts' });
                }
                const formSet = forms?.length ? new Set(forms.map((f) => f.toUpperCase())) : undefined;
                let rows: Record<string, unknown>[] = [];
                const missing: string[] = [];
                for (const concept of concepts) {
                    const found = taxes.filter(([, cs]) => cs[concept]);
                    if (!found.length) missing.push(concept);
                    for (const [t, cs] of found) {
                        const v = cs[concept];
                        for (const [unit, pts] of Object.entries(v.units)) {
                            let list = pts
                                .filter((p) => !formSet || formSet.has(String(p.form).toUpperCase()))
                                .filter((p) => !fiscalPeriod || p.fp === fiscalPeriod)
                                .filter((p) => !since || p.end >= since);
                            if (dedupe ?? true) {
                                const m = new Map<string, FactPoint>();
                                for (const p of list) {
                                    const k = `${p.start ?? ''}|${p.end}`;
                                    const prev = m.get(k);
                                    if (!prev || String(p.filed) > String(prev.filed)) m.set(k, p);
                                }
                                list = [...m.values()];
                            }
                            rows = rows.concat(
                                list.map((p) => ({
                                    taxonomy: t,
                                    concept,
                                    label: v.label ?? null,
                                    unit,
                                    value: p.val,
                                    start: p.start ?? null,
                                    end: p.end,
                                    fy: p.fy ?? null,
                                    fp: p.fp ?? null,
                                    form: p.form ?? null,
                                    filed: p.filed ?? null,
                                    accession_number: p.accn ?? null,
                                    frame: p.frame ?? null,
                                })),
                            );
                        }
                    }
                }
                rows.sort((a, b) => String(b.end).localeCompare(String(a.end)) || String(a.concept).localeCompare(String(b.concept)));
                return pagedResult(rows, offset ?? 0, limit ?? 50, { ...meta, mode: 'values', missing_concepts: missing });
            } catch (e) {
                return fail(e);
            }
        },
    );

    type Frame = { taxonomy: string; tag: string; ccp: string; uom: string; label: string; pts: number; data: { accn: string; cik: number; entityName: string; loc?: string; start?: string; end: string; val: number }[] };

    server.registerTool(
        'edgar_get_concept_across_companies',
        {
            title: 'Compare one XBRL concept across all companies',
            description: [
                'Cross-company query: get one XBRL concept (e.g. Revenues, Assets, NetIncomeLoss) for one calendar period for every SEC filer that reported it, using the SEC frames API. Sortable and paged.',
                'Use for screening and peer comparison ("largest companies by total assets at end of 2023", "net income of all filers in CY2023"). For one company\'s history use edgar_get_company_facts.',
                'Period format: "CY2023" (annual duration), "CY2023Q2" (quarterly duration), "CY2023Q4I" (instant, for balance-sheet items like Assets). Unit e.g. "USD", "USD-per-shares", "shares", "pure".',
                'Behavior: free, read-only GET to data.sec.gov (no token). Returns paged {count,total,offset,hasMore,nextOffset,meta:{taxonomy,concept,label,unit,period,source_url},items:[{rank,cik,entity_name,value,start,end,location,accession_number}]}. Optional ciks filter restricts to given companies. Errors: NOT_FOUND (no such concept/unit/period frame), SEC_FETCH_FAILED.',
                "WHEN NOT TO USE: for one company's time series use edgar_get_company_facts; for filings use edgar_list_filings.",
                "COST: free - direct sec.gov requests from this MCP server, no APIFY_TOKEN, no Apify billing.",
                'PARAMETERS: period must match the concept type: flow items (Revenues, NetIncomeLoss) use durations "CY2023" or "CY2023Q2"; balance-sheet items (Assets, Liabilities, StockholdersEquity) need an instant such as "CY2023Q4I" - the wrong kind returns NOT_FOUND. Calendar periods are SEC-aligned approximations of each filer\'s fiscal period. concept, unit and taxonomy are case-sensitive path parts of one SEC frame, so all three must exist together: EPS uses unit "USD-per-shares", share counts "shares", ratios "pure"; dei concepts (e.g. EntityCommonStockSharesOutstanding) need taxonomy "dei". companies filters the frame after download (any ticker/CIK/name; unresolvable entries are silently skipped); rank is computed after that filter and the chosen sort, so rank 1 = largest value among the kept companies with value_desc. limit/offset then page the ranked rows.',
                "EXAMPLE: {\"concept\":\"Assets\",\"period\":\"CY2023Q4I\",\"limit\":10} -> top 10 filers by total assets at end of 2023.",
            ].join('\n'),
            inputSchema: {
                concept: z.string().min(1).describe('Required. Exact XBRL concept name, case-sensitive, e.g. "Assets", "Revenues", "NetIncomeLoss"'),
                period: z.string().regex(/^CY\d{4}(Q[1-4]I?)?$/).describe('Required. Calendar frame, pattern ^CY\\d{4}(Q[1-4]I?)?$: "CY2023" = annual duration, "CY2023Q2" = quarterly duration, "CY2023Q4I" = instant at quarter end (balance-sheet items)'),
                unit: z.string().default('USD').describe('Optional, default "USD". Case-sensitive unit of measure: "USD", "USD-per-shares" (EPS), "shares", "pure" (ratios), or another currency code such as "EUR"'),
                taxonomy: z.string().default('us-gaap').describe('Optional, default "us-gaap". One of "us-gaap", "ifrs-full", "dei", "srt"'),
                sort: z.enum(['value_desc', 'value_asc', 'name']).default('value_desc').describe('Optional, one of "value_desc" | "value_asc" | "name", default "value_desc" (largest first); "name" = entity name A-Z'),
                companies: z.array(z.string().min(1)).max(50).optional().describe('Optional, default omitted = all filers. 1-50 tickers, CIKs or name fragments to keep. Example: ["AAPL","MSFT","GOOGL"]'),
                limit: limitArg(25, 500),
                offset: offsetArg,
            },
            outputSchema: pagedOutputSchema,
            annotations: { title: 'Compare one XBRL concept across all companies', ...READ_ONLY_OPEN_WORLD },
        },
        async ({ concept, period, unit, taxonomy, sort, companies, limit, offset }) => {
            try {
                const url = `https://data.sec.gov/api/xbrl/frames/${taxonomy ?? 'us-gaap'}/${concept}/${unit ?? 'USD'}/${period}.json`;
                const f = await secJson<Frame>(url);
                let data = f.data;
                if (companies?.length) {
                    const ciks = new Set<number>();
                    for (const q of companies) {
                        const c = await resolveCik(q);
                        if (c) ciks.add(Number(c.cik));
                    }
                    data = data.filter((d) => ciks.has(d.cik));
                }
                const s = sort ?? 'value_desc';
                data = [...data].sort((a, b) => (s === 'name' ? a.entityName.localeCompare(b.entityName) : s === 'value_asc' ? a.val - b.val : b.val - a.val));
                const rows = data.map((d, i) => ({
                    rank: i + 1,
                    cik: padCik(d.cik),
                    entity_name: d.entityName,
                    value: d.val,
                    start: d.start ?? null,
                    end: d.end,
                    location: d.loc ?? null,
                    accession_number: d.accn,
                }));
                return pagedResult(rows, offset ?? 0, limit ?? 25, { taxonomy: f.taxonomy, concept: f.tag, label: f.label, unit: f.uom, period: f.ccp, source_url: url });
            } catch (e) {
                return fail(e);
            }
        },
    );

    server.registerTool(
        'edgar_batch_export',
        {
            title: 'Batch export filings & facts via Apify Actor (paid)',
            description: [
                'Bulk export (paid, via Apify) of structured SEC EDGAR data for up to 50 US companies in one call: entity metadata, recent filings (10-K, 10-Q, 8-K, S-1, DEF 14A, ...) with document URLs, XBRL financial facts (Assets, Revenues, NetIncomeLoss, EarningsPerShareDiluted, ...) and optional plain-text excerpts of primary filing documents.',
                'WHEN TO USE: an agent needs filing lists/links or reported financial values from official SEC data. mode="filings" for filing history/links, "facts" for financial numbers, "both" for both. Prefer the free single-purpose tools (edgar_resolve_company, edgar_list_filings, edgar_get_company_facts, edgar_get_filing_document) for interactive lookups; use this tool for multi-company batch exports billed to your Apify account. Not for real-time quotes, prices, options, non-US companies or investment advice.',
                'BEHAVIOR: read-only; runs the Fairquery Apify Actor fairquery/edgar-company-facts-filings via the Apify API, which queries sec.gov (throttled to <=5 req/s). Requires the APIFY_TOKEN environment variable. Typical run 5-60 s; the call waits up to ~5 minutes.',
                'COST: paid (billed to your Apify account, pay-per-event): $0.00005 per run, $0.002 per resolved company, $0.002 per filing row, $0.0005 per fact row, $0.003 per text excerpt. Keep maxFilingsPerCompany, metrics and maxFactsPerMetric small to limit cost; e.g. 1 company, 5 filings, 3 metrics x 4 values ~ $0.018.',
                'RETURNS: {count, items}. Every row has schema_version, type (company | filing | fact | text_excerpt | error), source_url and scraped_at. filing rows: cik, ticker, form, filing_date, report_date, accession_number, primary_document, document_url. fact rows: taxonomy, concept, label, unit, value, start, end, filed, form. error rows: code (INPUT_EMPTY, COMPANY_NOT_FOUND, RESOLVE_FAILED, SUBMISSIONS_FETCH_FAILED, FACTS_FETCH_FAILED, EXCERPT_FETCH_FAILED), message, retryable. Unresolvable companies produce an error row, not a failure.',
                "WHEN NOT TO USE: single-company or interactive lookups - use the free tools above (same SEC data, no cost).",
                'PARAMETERS: companies: each entry is resolved by the Actor as ticker, CIK or name fragment and billed once when resolved; unresolvable entries yield a free COMPANY_NOT_FOUND row. mode controls which other parameters apply: formTypes, since, maxFilingsPerCompany and includeTextExcerpt/excerptMaxChars only affect "filings"/"both"; metrics and maxFactsPerMetric only affect "facts"/"both". Billed rows per call = resolved companies + companies x min(maxFilingsPerCompany, matching filings) + companies x metrics x units x maxFactsPerMetric (+ one excerpt per filing row when includeTextExcerpt=true), so size those three numbers first. Omitted optional fields take the Actor\'s input defaults: formTypes ["10-K","10-Q","8-K"] (pass [] for every form type), maxFilingsPerCompany 5, metrics Assets, NetIncomeLoss, EarningsPerShareDiluted, Revenues (pass [] for a built-in 10-concept set), maxFactsPerMetric 4, excerptMaxChars 2000. since compares filing_date (inclusive); metrics are case-sensitive us-gaap/dei names.',
                "EXAMPLE: {\"companies\":[\"AAPL\",\"MSFT\"],\"mode\":\"facts\",\"metrics\":[\"Revenues\"],\"maxFactsPerMetric\":4} -> company + fact rows (~$0.02).",
            ].join('\n'),
            inputSchema: {
                companies: z
                    .array(z.string().min(1))
                    .min(1)
                    .max(50)
                    .describe('Required. 1-50 tickers ("AAPL"), CIKs ("320193") or company name fragments ("Apple"); $0.002 per resolved company. Example: ["AAPL","MSFT"]'),
                mode: z
                    .enum(['filings', 'facts', 'both'])
                    .default('both')
                    .describe('Optional, one of "filings" | "facts" | "both", default "both". "filings" = filing rows only, "facts" = XBRL fact rows only; a company row is always included when resolved. Example: "facts"'),
                formTypes: z
                    .array(z.string())
                    .optional()
                    .describe('Optional; omitted = Actor default ["10-K","10-Q","8-K"], [] = all forms. Exact form types (case-insensitive), e.g. ["10-K","10-Q"] or ["8-K"]. Ignored when mode="facts".'),
                since: z
                    .string()
                    .regex(/^\d{4}-\d{2}-\d{2}$/)
                    .optional()
                    .describe('Optional, default no lower bound. Only filings with filing date >= this date, format YYYY-MM-DD (pattern ^\\d{4}-\\d{2}-\\d{2}$), e.g. "2023-01-01". Ignored when mode="facts".'),
                maxFilingsPerCompany: z
                    .number()
                    .int()
                    .min(1)
                    .max(100)
                    .optional()
                    .describe('Optional integer 1-100, default 5 (Actor default). Max filing rows per company, newest first; each row is billed $0.002. Example: 3'),
                metrics: z
                    .array(z.string())
                    .optional()
                    .describe('Optional; omitted = Actor default ["Assets","NetIncomeLoss","EarningsPerShareDiluted","Revenues"], [] = built-in 10-concept set. Case-sensitive us-gaap/dei concept names. Example: ["Assets","Revenues"]. Ignored when mode="filings".'),
                maxFactsPerMetric: z
                    .number()
                    .int()
                    .min(1)
                    .max(50)
                    .optional()
                    .describe('Optional integer 1-50, default 4 (Actor default). Most-recent values kept per concept and unit; each fact row is billed $0.0005. Example: 4'),
                includeTextExcerpt: z
                    .boolean()
                    .optional()
                    .describe('Optional boolean, default false. true adds a plain-text excerpt row of each filing\'s primary document ($0.003 each, slower). Ignored when mode="facts".'),
                excerptMaxChars: z
                    .number()
                    .int()
                    .min(100)
                    .max(50000)
                    .optional()
                    .describe('Optional integer, default 2000 characters per excerpt; the Actor accepts 200-20000 (values outside fail its input validation). Only used with includeTextExcerpt=true. Example: 5000'),
            },
            outputSchema: rowsOutputSchema,
            annotations: { title: 'Batch export filings & facts via Apify Actor (paid)', ...READ_ONLY_OPEN_WORLD },
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
