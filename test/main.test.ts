import { describe, expect, it } from 'vitest';
import { htmlToExcerpt, parseFilings } from '../src/filings.js';
import { parseFacts } from '../src/facts.js';
import { padCik } from '../src/sec-client.js';
import { SCHEMA_VERSION, type ResolvedCompany } from '../src/types.js';

const company: ResolvedCompany = {
    query: 'AAPL',
    cik: '0000320193',
    ticker: 'AAPL',
    name: 'Apple Inc.',
    sourceUrl: 'https://www.sec.gov/files/company_tickers.json',
};

describe('padCik', () => {
    it('pads numeric CIKs to 10 digits', () => {
        expect(padCik(320193)).toBe('0000320193');
        expect(padCik('320193')).toBe('0000320193');
        expect(padCik('0000320193')).toBe('0000320193');
    });
});

describe('parseFilings', () => {
    it('filters by form and since and respects max', () => {
        const rows = parseFilings(
            company,
            {
                filings: {
                    recent: {
                        accessionNumber: ['0000320193-24-000001', '0000320193-23-000001', '0000320193-22-000001'],
                        form: ['10-K', '8-K', '10-Q'],
                        filingDate: ['2024-11-01', '2023-06-01', '2022-01-15'],
                        reportDate: ['2024-09-28', '2023-06-01', '2021-12-25'],
                        primaryDocument: ['aapl-20240928.htm', 'a8k.htm', 'aapl-10q.htm'],
                        primaryDocDescription: ['10-K', '8-K', '10-Q'],
                        isXBRL: [1, 0, 1],
                        isInlineXBRL: [1, 0, 1],
                        size: [100, 200, 300],
                    },
                },
            },
            {
                formTypes: ['10-K', '10-Q'],
                since: '2023-01-01',
                maxFilingsPerCompany: 10,
                nowIso: '2026-10-15T00:00:00.000Z',
            },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].type).toBe('filing');
        expect(rows[0].form).toBe('10-K');
        expect(rows[0].schema_version).toBe(SCHEMA_VERSION);
        expect(rows[0].document_url).toContain('0000320193');
        expect(rows[0].source_url).toContain('CIK0000320193');
    });
});

describe('parseFacts', () => {
    it('keeps only requested metrics and caps per unit', () => {
        const rows = parseFacts(
            company,
            {
                facts: {
                    'us-gaap': {
                        Assets: {
                            label: 'Assets',
                            units: {
                                USD: [
                                    { val: 100, end: '2024-09-28', filed: '2024-11-01', form: '10-K', fy: 2024, fp: 'FY', accn: 'a' },
                                    { val: 90, end: '2023-09-30', filed: '2023-11-03', form: '10-K', fy: 2023, fp: 'FY', accn: 'b' },
                                    { val: 80, end: '2022-09-24', filed: '2022-10-28', form: '10-K', fy: 2022, fp: 'FY', accn: 'c' },
                                ],
                            },
                        },
                        Liabilities: {
                            label: 'Liabilities',
                            units: {
                                USD: [{ val: 1, end: '2024-09-28', filed: '2024-11-01', form: '10-K' }],
                            },
                        },
                    },
                },
            },
            { metrics: ['Assets'], maxFactsPerMetric: 2, nowIso: '2026-10-15T00:00:00.000Z' },
        );
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.concept === 'Assets')).toBe(true);
        expect(rows[0].value).toBe(100);
        expect(rows[0].type).toBe('fact');
    });
});

describe('htmlToExcerpt', () => {
    it('strips tags and truncates', () => {
        const out = htmlToExcerpt('<html><script>x()</script><body>Hello&nbsp;<b>world</b></body></html>', 8);
        expect(out.startsWith('Hello')).toBe(true);
        expect(out.includes('<')).toBe(false);
        expect(out.length).toBeLessThanOrEqual(9); // 8 + ellipsis
    });
});

describe('input schema', () => {
    it('keeps sample companies as prefill/example only, never as a billable default', async () => {
        const { readFileSync } = await import('node:fs');
        const schema = JSON.parse(readFileSync(new URL('../.actor/input_schema.json', import.meta.url), 'utf8'));
        const field = schema.properties.companies;
        expect(field.default).toBeUndefined();
        expect(Array.isArray(field.prefill) && field.prefill.length > 0).toBe(true);
        expect(field.example).toEqual(field.prefill);
    });
});
