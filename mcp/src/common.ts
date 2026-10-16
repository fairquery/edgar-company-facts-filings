/**
 * Shared helpers: Apify Actor proxy + MCP result shaping.
 * APIFY_TOKEN is read from the environment only when a paid tool is called; it is never logged.
 */
import { z } from 'zod';

const APIFY_BASE = 'https://api.apify.com/v2';

export const READ_ONLY_OPEN_WORLD = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
} as const;

/** Output schema shared by every tool: dataset rows plus a count. */
export const rowsOutputSchema = {
    count: z.number().int().describe('Number of rows returned'),
    items: z
        .array(z.record(z.string(), z.unknown()))
        .describe('Result rows; each has a "type" field (data rows or machine-readable "error" rows)'),
};

export type ToolResult = {
    content: { type: 'text'; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
};

export function rowsResult(items: unknown): ToolResult {
    const rows = Array.isArray(items) ? (items as Record<string, unknown>[]) : [items as Record<string, unknown>];
    const structured = { count: rows.length, items: rows };
    return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
}

export function errorResult(code: string, message: string, retryable = false): ToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: code, message, retryable }, null, 2) }],
        isError: true,
    };
}

export function getToken(): string | undefined {
    return process.env.APIFY_TOKEN?.trim() || undefined;
}

export const MISSING_TOKEN_MESSAGE =
    'Set the APIFY_TOKEN environment variable to your Apify API token (https://console.apify.com/settings/integrations). initialize and tools/list work without a token.';

/** Runs the Actor synchronously and returns its dataset items. */
export async function runActor(actorId: string, input: Record<string, unknown>, token: string): Promise<unknown> {
    const url = `${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(input),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
        body = JSON.parse(text);
    } catch {
        /* keep raw text */
    }
    if (!res.ok) {
        const detail = typeof body === 'string' ? body : JSON.stringify(body);
        throw new Error(`Apify Actor run failed (HTTP ${res.status}): ${detail.slice(0, 2000)}`);
    }
    return body;
}

/** Wraps an Actor call with token check and error shaping. */
export async function proxyActor(actorId: string, input: Record<string, unknown>): Promise<ToolResult> {
    const token = getToken();
    if (!token) return errorResult('APIFY_TOKEN_MISSING', MISSING_TOKEN_MESSAGE);
    try {
        return rowsResult(await runActor(actorId, input, token));
    } catch (e) {
        return errorResult('APIFY_ACTOR_RUN_FAILED', e instanceof Error ? e.message : String(e), true);
    }
}

export function compact(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (v !== undefined) out[k] = v;
    return out;
}
