import { companyFactsUrl } from './sec-client.js';
import { DEFAULT_METRICS, SCHEMA_VERSION, type FactRow, type ResolvedCompany } from './types.js';

export interface CompanyFactsPayload {
    cik?: number | string;
    entityName?: string;
    facts?: Record<
        string,
        Record<
            string,
            {
                label?: string;
                description?: string;
                units?: Record<
                    string,
                    Array<{
                        end?: string;
                        start?: string;
                        val?: number | string | boolean | null;
                        accn?: string;
                        fy?: number;
                        fp?: string;
                        form?: string;
                        filed?: string;
                        frame?: string;
                    }>
                >;
            }
        >
    >;
}

export function parseFacts(
    company: ResolvedCompany,
    payload: CompanyFactsPayload,
    opts: {
        metrics?: string[];
        maxFactsPerMetric?: number;
        nowIso: string;
    },
): FactRow[] {
    const facts = payload.facts || {};
    const wanted = new Set(
        (opts.metrics && opts.metrics.length > 0 ? opts.metrics : DEFAULT_METRICS).map((m) =>
            m.toLowerCase(),
        ),
    );
    const maxPer = opts.maxFactsPerMetric ?? 8;
    const rows: FactRow[] = [];
    const cik10 = company.cik;
    const source = companyFactsUrl(cik10);

    for (const [taxonomy, concepts] of Object.entries(facts)) {
        for (const [concept, meta] of Object.entries(concepts)) {
            if (!wanted.has(concept.toLowerCase())) continue;
            const units = meta.units || {};
            for (const [unit, values] of Object.entries(units)) {
                // Most recent period first (end date desc), then latest filing (restatements win), then the
                // shorter period (quarter before year-to-date). A value re-reported in later filings is kept once,
                // from the latest filing, so prior-year comparatives in a new 10-Q don't crowd out current values.
                const sorted = [...values].sort(
                    (a, b) =>
                        (b.end || '').localeCompare(a.end || '') ||
                        (b.filed || '').localeCompare(a.filed || '') ||
                        (b.start || '').localeCompare(a.start || ''),
                );
                const seen = new Set<string>();
                const slice = sorted
                    .filter((v) => {
                        const k = `${v.start || ''}|${v.end || ''}`;
                        if (seen.has(k)) return false;
                        seen.add(k);
                        return true;
                    })
                    .slice(0, maxPer);
                for (const v of slice) {
                    rows.push({
                        schema_version: SCHEMA_VERSION,
                        type: 'fact',
                        source_url: source,
                        scraped_at: opts.nowIso,
                        cik: cik10,
                        ticker: company.ticker,
                        name: company.name,
                        taxonomy,
                        concept,
                        label: meta.label,
                        unit,
                        value: v.val ?? null,
                        end: v.end,
                        start: v.start,
                        filed: v.filed,
                        form: v.form,
                        frame: v.frame,
                        fy: v.fy,
                        fp: v.fp,
                        accession_number: v.accn,
                    });
                }
            }
        }
    }

    return rows;
}
