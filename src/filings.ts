import { submissionsUrl } from './sec-client.js';
import { SCHEMA_VERSION, type FilingRow, type ResolvedCompany } from './types.js';

export interface SubmissionsPayload {
    cik?: string;
    name?: string;
    entityType?: string;
    sic?: string;
    sicDescription?: string;
    exchanges?: string[];
    ein?: string;
    fiscalYearEnd?: string;
    tickers?: string[];
    filings?: {
        recent?: Record<string, Array<string | number | boolean | null>>;
        files?: Array<{ name: string; filingCount: number; filingFrom: string; filingTo: string }>;
    };
}

export function parseFilings(
    company: ResolvedCompany,
    submissions: SubmissionsPayload,
    opts: {
        formTypes?: string[];
        since?: string;
        maxFilingsPerCompany?: number;
        nowIso: string;
    },
): FilingRow[] {
    const recent = submissions.filings?.recent;
    if (!recent || !Array.isArray(recent.accessionNumber)) return [];

    const n = recent.accessionNumber.length;
    const formFilter =
        opts.formTypes && opts.formTypes.length > 0
            ? new Set(opts.formTypes.map((f) => f.toUpperCase()))
            : null;
    const since = opts.since || null;
    const max = opts.maxFilingsPerCompany ?? 25;
    const cik10 = company.cik;
    const cikNoPad = cik10.replace(/^0+/, '') || '0';
    const rows: FilingRow[] = [];

    for (let i = 0; i < n; i++) {
        const form = String(recent.form?.[i] ?? '');
        const filingDate = String(recent.filingDate?.[i] ?? '');
        if (formFilter && !formFilter.has(form.toUpperCase())) continue;
        if (since && filingDate && filingDate < since) continue;

        const accession = String(recent.accessionNumber?.[i] ?? '');
        const accessionNodash = accession.replace(/-/g, '');
        const primaryDocument = recent.primaryDocument?.[i]
            ? String(recent.primaryDocument[i])
            : undefined;
        const documentUrl =
            primaryDocument && accessionNodash
                ? `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${accessionNodash}/${primaryDocument}`
                : undefined;
        const filingUrl = accessionNodash
            ? `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${accessionNodash}/`
            : undefined;

        rows.push({
            schema_version: SCHEMA_VERSION,
            type: 'filing',
            source_url: submissionsUrl(cik10),
            scraped_at: opts.nowIso,
            cik: cik10,
            ticker: company.ticker,
            name: company.name,
            form,
            filing_date: filingDate,
            report_date: recent.reportDate?.[i] ? String(recent.reportDate[i]) : undefined,
            accession_number: accession,
            primary_document: primaryDocument,
            primary_doc_description: recent.primaryDocDescription?.[i]
                ? String(recent.primaryDocDescription[i])
                : undefined,
            document_url: documentUrl,
            filing_url: filingUrl,
            is_xbrl: Boolean(recent.isXBRL?.[i]),
            is_inline_xbrl: Boolean(recent.isInlineXBRL?.[i]),
            size: typeof recent.size?.[i] === 'number' ? (recent.size[i] as number) : undefined,
        });

        if (rows.length >= max) break;
    }

    return rows;
}

/** Strip tags and collapse whitespace for a short excerpt. */
export function htmlToExcerpt(html: string, maxChars: number): string {
    let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#\d+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
    return text;
}
