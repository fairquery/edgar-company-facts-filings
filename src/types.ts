/** Shared types for EDGAR Company Facts & Filings Actor */

export const SCHEMA_VERSION = '1.0.0';

export type Mode = 'filings' | 'facts' | 'both';

export interface ActorInput {
    /** Tickers, CIKs (numeric or zero-padded), or company name fragments */
    companies: string[];
    mode?: Mode;
    /** Filing form types to keep, e.g. ["10-K","10-Q","8-K"]. Empty = all. */
    formTypes?: string[];
    /** ISO date (YYYY-MM-DD). Only filings with filingDate >= since. */
    since?: string;
    maxFilingsPerCompany?: number;
    /** XBRL concept names (e.g. Assets, Revenues, NetIncomeLoss). Empty = common defaults. */
    metrics?: string[];
    /** Fetch a short plain-text excerpt from the primary document of each kept filing. */
    includeTextExcerpt?: boolean;
    excerptMaxChars?: number;
    /** Max fact values per concept (most recent first). */
    maxFactsPerMetric?: number;
}

export interface TickerEntry {
    cik_str: number | string;
    ticker: string;
    title: string;
}

export interface ResolvedCompany {
    query: string;
    cik: string; // 10-digit
    ticker: string | null;
    name: string;
    sourceUrl: string;
}

export type RowType = 'company' | 'filing' | 'fact' | 'text_excerpt' | 'error';

export interface BaseRow {
    schema_version: string;
    type: RowType;
    source_url: string;
    scraped_at: string;
}

export interface CompanyRow extends BaseRow {
    type: 'company';
    query: string;
    cik: string;
    ticker: string | null;
    name: string;
    entity_type?: string;
    sic?: string;
    sic_description?: string;
    exchanges?: string[];
    ein?: string;
    fiscal_year_end?: string;
}

export interface FilingRow extends BaseRow {
    type: 'filing';
    cik: string;
    ticker: string | null;
    name: string;
    form: string;
    filing_date: string;
    report_date?: string;
    accession_number: string;
    primary_document?: string;
    primary_doc_description?: string;
    document_url?: string;
    filing_url?: string;
    is_xbrl?: boolean;
    is_inline_xbrl?: boolean;
    size?: number;
}

export interface FactRow extends BaseRow {
    type: 'fact';
    cik: string;
    ticker: string | null;
    name: string;
    taxonomy: string;
    concept: string;
    label?: string;
    unit: string;
    value: number | string | boolean | null;
    end?: string;
    start?: string;
    filed?: string;
    form?: string;
    frame?: string;
    fy?: number;
    fp?: string;
    accession_number?: string;
}

export interface TextExcerptRow extends BaseRow {
    type: 'text_excerpt';
    cik: string;
    ticker: string | null;
    name: string;
    form: string;
    filing_date: string;
    accession_number: string;
    document_url: string;
    excerpt: string;
    excerpt_chars: number;
}

export interface ErrorRow extends BaseRow {
    type: 'error';
    code: string;
    message: string;
    retryable: boolean;
    query?: string;
    cik?: string;
    context?: Record<string, unknown>;
}

export type OutputRow = CompanyRow | FilingRow | FactRow | TextExcerptRow | ErrorRow;

export interface RunSummary {
    schema_version: string;
    started_at: string;
    finished_at: string;
    mode: Mode;
    companies_requested: number;
    companies_resolved: number;
    filings_emitted: number;
    facts_emitted: number;
    text_excerpts_emitted: number;
    errors: number;
    sec_requests: number;
    input: ActorInput;
}

export const CHARGE_EVENTS = {
    companyResolved: 'company-resolved',
    filing: 'filing',
    financialFact: 'financial-fact',
    textExcerpt: 'text-excerpt',
} as const;

/** Default us-gaap concepts when metrics is empty */
export const DEFAULT_METRICS = [
    'Assets',
    'Liabilities',
    'StockholdersEquity',
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'NetIncomeLoss',
    'EarningsPerShareDiluted',
    'CashAndCashEquivalentsAtCarryingValue',
    'OperatingIncomeLoss',
    'CommonStockSharesOutstanding',
];

export const USER_AGENT = 'Fairquery fairquery@proton.me';
export const MAX_RPS = 5;
