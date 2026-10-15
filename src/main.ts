import { Actor, log } from 'apify';
import { parseFacts, type CompanyFactsPayload } from './facts.js';
import { htmlToExcerpt, parseFilings, type SubmissionsPayload } from './filings.js';
import { resolveCompany } from './resolve.js';
import { SecClient, companyFactsUrl, submissionsUrl } from './sec-client.js';
import {
    CHARGE_EVENTS,
    SCHEMA_VERSION,
    type ActorInput,
    type CompanyRow,
    type ErrorRow,
    type Mode,
    type OutputRow,
    type RunSummary,
    type TextExcerptRow,
} from './types.js';

await Actor.init();

const aborting = { value: false };
Actor.on('aborting', () => {
    aborting.value = true;
    log.warning('Aborting — will finish current company then stop.');
});

const startedAt = new Date().toISOString();
const rawInput = (await Actor.getInput<ActorInput | Record<string, unknown>>()) ?? {};

/** Coerce tickers/CIKs/names from array, CSV string, or single string. */
function coerceStringList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((v) => String(v).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(/[,\n]/)
            .map((v) => v.trim())
            .filter(Boolean);
    }
    return [];
}

const companies = coerceStringList((rawInput as ActorInput).companies);
const formTypes = coerceStringList((rawInput as ActorInput).formTypes);
const metrics = coerceStringList((rawInput as ActorInput).metrics);

const input: Required<
    Pick<
        ActorInput,
        | 'companies'
        | 'mode'
        | 'formTypes'
        | 'maxFilingsPerCompany'
        | 'metrics'
        | 'includeTextExcerpt'
        | 'excerptMaxChars'
        | 'maxFactsPerMetric'
    >
> &
    ActorInput = {
    companies,
    mode: (((rawInput as ActorInput).mode as Mode) || 'both') as Mode,
    formTypes,
    since: (rawInput as ActorInput).since,
    maxFilingsPerCompany: Number((rawInput as ActorInput).maxFilingsPerCompany ?? 5) || 5,
    metrics,
    includeTextExcerpt: Boolean((rawInput as ActorInput).includeTextExcerpt),
    excerptMaxChars: Number((rawInput as ActorInput).excerptMaxChars ?? 2000) || 2000,
    maxFactsPerMetric: Number((rawInput as ActorInput).maxFactsPerMetric ?? 4) || 4,
};

if (!input.companies.length) {
    await pushError({
        code: 'INPUT_EMPTY',
        message: 'Input.companies must be a non-empty array of tickers, CIKs, or company names.',
        retryable: false,
    });
    await writeSummary(input, startedAt, {
        companies_resolved: 0,
        filings_emitted: 0,
        facts_emitted: 0,
        text_excerpts_emitted: 0,
        errors: 1,
        sec_requests: 0,
    });
    // Fail the run so Store QA / Try-it never counts an empty-input "success" with only an error row.
    await Actor.exit({ statusMessage: 'INPUT_EMPTY: companies is required', exitCode: 1 });
}

const client = new SecClient();
const counters = {
    companies_resolved: 0,
    filings_emitted: 0,
    facts_emitted: 0,
    text_excerpts_emitted: 0,
    errors: 0,
};

log.info('EDGAR Actor starting', {
    companies: input.companies.length,
    mode: input.mode,
    formTypes: input.formTypes,
    since: input.since,
});

for (const query of input.companies) {
    if (aborting.value) break;
    const nowIso = new Date().toISOString();

    let resolved;
    try {
        resolved = await resolveCompany(client, query);
    } catch (e) {
        counters.errors += 1;
        await pushError({
            code: 'RESOLVE_FAILED',
            message: errMsg(e),
            retryable: isRetryable(e),
            query,
        });
        continue;
    }

    if (!resolved) {
        counters.errors += 1;
        await pushError({
            code: 'COMPANY_NOT_FOUND',
            message: `Could not resolve company query: ${query}`,
            retryable: false,
            query,
        });
        continue;
    }

    // Enrich from submissions (always fetch once — used for company row + filings)
    let submissions: SubmissionsPayload | null = null;
    try {
        submissions = await client.fetchJson<SubmissionsPayload>(submissionsUrl(resolved.cik));
        if (submissions.name) resolved.name = submissions.name;
        if (submissions.tickers?.[0] && !resolved.ticker) {
            resolved.ticker = submissions.tickers[0];
        }
    } catch (e) {
        counters.errors += 1;
        await pushError({
            code: 'SUBMISSIONS_FETCH_FAILED',
            message: errMsg(e),
            retryable: isRetryable(e),
            query,
            cik: resolved.cik,
        });
        // Still try facts if mode needs them and we have a CIK
        if (input.mode === 'filings') continue;
    }

    const companyRow: CompanyRow = {
        schema_version: SCHEMA_VERSION,
        type: 'company',
        source_url: submissionsUrl(resolved.cik),
        scraped_at: nowIso,
        query: resolved.query,
        cik: resolved.cik,
        ticker: resolved.ticker,
        name: resolved.name,
        entity_type: submissions?.entityType,
        sic: submissions?.sic,
        sic_description: submissions?.sicDescription,
        exchanges: submissions?.exchanges,
        ein: submissions?.ein,
        fiscal_year_end: submissions?.fiscalYearEnd,
    };
    await emit(companyRow, CHARGE_EVENTS.companyResolved);
    counters.companies_resolved += 1;

    if ((input.mode === 'filings' || input.mode === 'both') && submissions) {
        const filings = parseFilings(resolved, submissions, {
            formTypes: input.formTypes,
            since: input.since,
            maxFilingsPerCompany: input.maxFilingsPerCompany,
            nowIso,
        });
        for (const filing of filings) {
            if (aborting.value) break;
            await emit(filing, CHARGE_EVENTS.filing);
            counters.filings_emitted += 1;

            if (input.includeTextExcerpt && filing.document_url) {
                try {
                    const html = await client.fetchText(filing.document_url);
                    const excerpt = htmlToExcerpt(html, input.excerptMaxChars);
                    const excerptRow: TextExcerptRow = {
                        schema_version: SCHEMA_VERSION,
                        type: 'text_excerpt',
                        source_url: filing.document_url,
                        scraped_at: new Date().toISOString(),
                        cik: filing.cik,
                        ticker: filing.ticker,
                        name: filing.name,
                        form: filing.form,
                        filing_date: filing.filing_date,
                        accession_number: filing.accession_number,
                        document_url: filing.document_url,
                        excerpt,
                        excerpt_chars: excerpt.length,
                    };
                    await emit(excerptRow, CHARGE_EVENTS.textExcerpt);
                    counters.text_excerpts_emitted += 1;
                } catch (e) {
                    counters.errors += 1;
                    await pushError({
                        code: 'EXCERPT_FETCH_FAILED',
                        message: errMsg(e),
                        retryable: isRetryable(e),
                        cik: filing.cik,
                        context: { document_url: filing.document_url, form: filing.form },
                    });
                }
            }
        }
    }

    if (input.mode === 'facts' || input.mode === 'both') {
        try {
            const payload = await client.fetchJson<CompanyFactsPayload>(
                companyFactsUrl(resolved.cik),
            );
            const facts = parseFacts(resolved, payload, {
                metrics: input.metrics,
                maxFactsPerMetric: input.maxFactsPerMetric,
                nowIso: new Date().toISOString(),
            });
            for (const fact of facts) {
                if (aborting.value) break;
                await emit(fact, CHARGE_EVENTS.financialFact);
                counters.facts_emitted += 1;
            }
        } catch (e) {
            counters.errors += 1;
            await pushError({
                code: 'FACTS_FETCH_FAILED',
                message: errMsg(e),
                retryable: isRetryable(e),
                query,
                cik: resolved.cik,
            });
        }
    }
}

await writeSummary(input, startedAt, {
    ...counters,
    sec_requests: client.requestCount,
});

log.info('EDGAR Actor finished', counters);
await Actor.exit();

async function emit(row: OutputRow, eventName: string): Promise<void> {
    await Actor.pushData(row);
    // Only charge when the run is on pay-per-event pricing (Store monetization approved).
    try {
        const pricing = Actor.getChargingManager().getPricingInfo();
        if (!pricing.isPayPerEvent) return;
        const result = await Actor.charge({ eventName });
        if (result.eventChargeLimitReached) {
            log.warning(`Charge limit reached for ${eventName}`);
            aborting.value = true;
        }
    } catch (e) {
        log.debug(`Actor.charge skipped/failed for ${eventName}: ${errMsg(e)}`);
    }
}

async function pushError(
    partial: Omit<ErrorRow, 'schema_version' | 'type' | 'source_url' | 'scraped_at'>,
): Promise<void> {
    const row: ErrorRow = {
        schema_version: SCHEMA_VERSION,
        type: 'error',
        source_url: 'https://data.sec.gov/',
        scraped_at: new Date().toISOString(),
        ...partial,
    };
    await Actor.pushData(row);
}

async function writeSummary(
    inp: ActorInput,
    started: string,
    c: {
        companies_resolved: number;
        filings_emitted: number;
        facts_emitted: number;
        text_excerpts_emitted: number;
        errors: number;
        sec_requests: number;
    },
): Promise<void> {
    const summary: RunSummary = {
        schema_version: SCHEMA_VERSION,
        started_at: started,
        finished_at: new Date().toISOString(),
        mode: (inp.mode || 'both') as Mode,
        companies_requested: (inp.companies || []).length,
        ...c,
        input: inp,
    };
    await Actor.setValue('RUN_SUMMARY', summary);
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function isRetryable(e: unknown): boolean {
    const status = (e as { status?: number })?.status;
    if (status === 429 || status === 503 || status === 502) return true;
    const msg = errMsg(e).toLowerCase();
    return msg.includes('fetch failed') || msg.includes('network') || msg.includes('timeout');
}
