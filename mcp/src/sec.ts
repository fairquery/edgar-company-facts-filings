/**
 * Direct SEC EDGAR client for the free tools. Sends a brand User-Agent (SEC fair-access policy)
 * and throttles to <=5 requests/second. No API key needed.
 */
export const SEC_USER_AGENT = 'Fairquery fairquery@proton.me';
export const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

let last: number[] = [];
let chain: Promise<void> = Promise.resolve();
async function throttle(): Promise<void> {
    chain = chain.then(async () => {
        const now = Date.now();
        last = last.filter((t) => now - t < 1000);
        if (last.length >= 5) await new Promise((r) => setTimeout(r, 1005 - (now - last[0])));
        last.push(Date.now());
    });
    await chain;
}

export class SecHttpError extends Error {
    constructor(
        message: string,
        public status: number,
    ) {
        super(message);
    }
}

async function secFetch(url: string, accept: string, attempt = 0): Promise<Response> {
    await throttle();
    const res = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT, Accept: accept } });
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1) * 2));
        return secFetch(url, accept, attempt + 1);
    }
    if (!res.ok) throw new SecHttpError(`SEC HTTP ${res.status} for ${url}`, res.status);
    return res;
}

export async function secJson<T>(url: string): Promise<T> {
    return (await (await secFetch(url, 'application/json')).json()) as T;
}
export async function secText(url: string): Promise<{ text: string; contentType: string }> {
    const res = await secFetch(url, 'text/html,text/plain,*/*');
    return { text: await res.text(), contentType: res.headers.get('content-type') ?? '' };
}

export const padCik = (c: string | number): string => String(c).replace(/\D/g, '').padStart(10, '0');

export type TickerEntry = { cik_str: number; ticker: string; title: string };
let tickerCache: { at: number; rows: TickerEntry[] } | undefined;
export async function loadTickers(): Promise<TickerEntry[]> {
    if (tickerCache && Date.now() - tickerCache.at < 6 * 3600_000) return tickerCache.rows;
    const rows = Object.values(await secJson<Record<string, TickerEntry>>(SEC_TICKERS_URL));
    tickerCache = { at: Date.now(), rows };
    return rows;
}

/** Resolves a ticker / CIK / name fragment to a 10-digit CIK (best match) or undefined. */
export async function resolveCik(query: string): Promise<{ cik: string; ticker?: string; name?: string } | undefined> {
    const q = query.trim();
    const rows = await loadTickers();
    if (/^\d{1,10}$/.test(q)) {
        const hit = rows.find((r) => r.cik_str === Number(q));
        return { cik: padCik(q), ticker: hit?.ticker, name: hit?.title };
    }
    const up = q.toUpperCase();
    const hit = rows.find((r) => r.ticker.toUpperCase() === up) ?? rows.find((r) => r.title.toUpperCase().includes(up));
    return hit ? { cik: padCik(hit.cik_str), ticker: hit.ticker, name: hit.title } : undefined;
}

/** Very small HTML -> text converter for filing documents. */
export function htmlToText(html: string): string {
    return html
        .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#8217;|&rsquo;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/[ \t\r\f\v]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
