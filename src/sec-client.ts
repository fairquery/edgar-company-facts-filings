import { log } from 'apify';
import { MAX_RPS, USER_AGENT } from './types.js';

/**
 * Minimal HTTP client for SEC EDGAR JSON APIs.
 * Enforces ≤5 req/s and a descriptive User-Agent (SEC fair-access policy).
 */
export class SecClient {
    private queue: Promise<void> = Promise.resolve();
    private lastTimes: number[] = [];
    private _requestCount = 0;

    get requestCount(): number {
        return this._requestCount;
    }

    private async throttle(): Promise<void> {
        // Serialize + sliding-window of MAX_RPS
        this.queue = this.queue.then(async () => {
            const now = Date.now();
            this.lastTimes = this.lastTimes.filter((t) => now - t < 1000);
            if (this.lastTimes.length >= MAX_RPS) {
                const wait = 1000 - (now - this.lastTimes[0]) + 5;
                await new Promise((r) => setTimeout(r, wait));
            }
            this.lastTimes.push(Date.now());
        });
        await this.queue;
    }

    async fetchJson<T>(url: string): Promise<T> {
        await this.throttle();
        this._requestCount += 1;
        const res = await fetch(url, {
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'application/json',
            },
        });
        if (res.status === 429) {
            const retryAfter = Number(res.headers.get('retry-after') || '2');
            log.warning(`SEC 429 for ${url}; backing off ${retryAfter}s`);
            await new Promise((r) => setTimeout(r, retryAfter * 1000));
            return this.fetchJson<T>(url);
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            const err = new Error(`SEC HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
            (err as Error & { status?: number }).status = res.status;
            throw err;
        }
        return (await res.json()) as T;
    }

    async fetchText(url: string): Promise<string> {
        await this.throttle();
        this._requestCount += 1;
        const res = await fetch(url, {
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
            },
        });
        if (res.status === 429) {
            const retryAfter = Number(res.headers.get('retry-after') || '2');
            await new Promise((r) => setTimeout(r, retryAfter * 1000));
            return this.fetchText(url);
        }
        if (!res.ok) {
            const err = new Error(`SEC HTTP ${res.status} for ${url}`);
            (err as Error & { status?: number }).status = res.status;
            throw err;
        }
        return res.text();
    }
}

export function padCik(cik: string | number): string {
    return String(cik).replace(/\D/g, '').padStart(10, '0');
}

export function submissionsUrl(cik10: string): string {
    return `https://data.sec.gov/submissions/CIK${cik10}.json`;
}

export function companyFactsUrl(cik10: string): string {
    return `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;
}

export const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
