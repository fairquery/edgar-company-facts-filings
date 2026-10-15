import { SecClient, TICKERS_URL, padCik, submissionsUrl } from './sec-client.js';
import type { ResolvedCompany, TickerEntry } from './types.js';

type TickerMap = Record<string, TickerEntry>;

let cachedTickers: TickerEntry[] | null = null;

export async function loadTickers(client: SecClient): Promise<TickerEntry[]> {
    if (cachedTickers) return cachedTickers;
    const raw = await client.fetchJson<TickerMap>(TICKERS_URL);
    cachedTickers = Object.values(raw);
    return cachedTickers;
}

/** Clear cache (tests). */
export function clearTickerCache(): void {
    cachedTickers = null;
}

function looksLikeCik(q: string): boolean {
    return /^\d{1,10}$/.test(q.trim());
}

function looksLikeTicker(q: string): boolean {
    return /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(q.trim());
}

/**
 * Resolve a user query (ticker, CIK, or name fragment) to a company.
 * Prefers exact ticker, then exact CIK, then case-insensitive name contains.
 */
export async function resolveCompany(
    client: SecClient,
    query: string,
): Promise<ResolvedCompany | null> {
    const q = query.trim();
    if (!q) return null;

    const tickers = await loadTickers(client);

    if (looksLikeCik(q)) {
        const cik10 = padCik(q);
        const hit = tickers.find((t) => padCik(t.cik_str) === cik10);
        if (hit) {
            return {
                query: q,
                cik: cik10,
                ticker: hit.ticker,
                name: hit.title,
                sourceUrl: TICKERS_URL,
            };
        }
        // CIK may still be valid even if missing from tickers map (funds etc.)
        return {
            query: q,
            cik: cik10,
            ticker: null,
            name: `CIK ${cik10}`,
            sourceUrl: submissionsUrl(cik10),
        };
    }

    if (looksLikeTicker(q)) {
        const upper = q.toUpperCase();
        const hit = tickers.find((t) => t.ticker.toUpperCase() === upper);
        if (hit) {
            return {
                query: q,
                cik: padCik(hit.cik_str),
                ticker: hit.ticker,
                name: hit.title,
                sourceUrl: TICKERS_URL,
            };
        }
    }

    // Name search: prefer starts-with, then contains
    const lower = q.toLowerCase();
    const starts = tickers.filter((t) => t.title.toLowerCase().startsWith(lower));
    const contains =
        starts.length > 0
            ? starts
            : tickers.filter((t) => t.title.toLowerCase().includes(lower));
    if (contains.length === 0) return null;

    // Prefer exact title match, else shortest title (usually the operating company)
    contains.sort((a, b) => {
        const ae = a.title.toLowerCase() === lower ? 0 : 1;
        const be = b.title.toLowerCase() === lower ? 0 : 1;
        if (ae !== be) return ae - be;
        return a.title.length - b.title.length;
    });
    const hit = contains[0];
    return {
        query: q,
        cik: padCik(hit.cik_str),
        ticker: hit.ticker,
        name: hit.title,
        sourceUrl: TICKERS_URL,
    };
}
