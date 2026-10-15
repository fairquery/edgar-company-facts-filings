#!/usr/bin/env node
/**
 * Fairquery EDGAR stdio MCP server.
 * Exposes SEC EDGAR filings / XBRL facts via the public Apify Actor
 * fairquery/edgar-company-facts-filings. APIFY_TOKEN is only required for tool calls.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ACTOR_ID = 'fairquery~edgar-company-facts-filings';
const APIFY_BASE = 'https://api.apify.com/v2';

const companiesSchema = z
    .array(z.string().min(1))
    .min(1)
    .describe('Tickers (AAPL), CIKs (320193), or company name fragments (Apple)');

const modeSchema = z
    .enum(['filings', 'facts', 'both'])
    .default('both')
    .describe('Which row types to return (company rows always included when resolved)');

type ActorInput = {
    companies: string[];
    mode?: 'filings' | 'facts' | 'both';
    formTypes?: string[];
    since?: string;
    maxFilingsPerCompany?: number;
    metrics?: string[];
    maxFactsPerMetric?: number;
    includeTextExcerpt?: boolean;
    excerptMaxChars?: number;
};

function missingTokenError() {
    return {
        content: [
            {
                type: 'text' as const,
                text: JSON.stringify(
                    {
                        error: 'APIFY_TOKEN_MISSING',
                        message:
                            'Set the APIFY_TOKEN environment variable to your Apify API token before calling this tool. Initialize and tools/list work without a token.',
                    },
                    null,
                    2,
                ),
            },
        ],
        isError: true,
    };
}

async function runActor(input: ActorInput, token: string): Promise<unknown> {
    const url = `${APIFY_BASE}/acts/${ACTOR_ID}/run-sync-get-dataset-items?waitForFinish=120`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
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
        const err = new Error(
            `Apify Actor run failed (HTTP ${res.status}): ${typeof body === 'string' ? body.slice(0, 2000) : JSON.stringify(body).slice(0, 2000)}`,
        );
        (err as Error & { status?: number }).status = res.status;
        throw err;
    }
    return body;
}

function createServer(): McpServer {
    const server = new McpServer({
        name: 'fairquery-edgar',
        version: '1.0.0',
    });

    server.registerTool(
        'edgar_company_filings_and_facts',
        {
            title: 'EDGAR company filings & facts',
            description:
                'Resolve US company tickers/CIKs/names via SEC EDGAR and return structured filings and/or XBRL company facts. Runs Fairquery Apify Actor fairquery/edgar-company-facts-filings. Requires APIFY_TOKEN. Not investment advice.',
            inputSchema: {
                companies: companiesSchema,
                mode: modeSchema,
                formTypes: z
                    .array(z.string())
                    .optional()
                    .describe('Form filter e.g. 10-K, 10-Q, 8-K; omit or empty for all'),
                since: z
                    .string()
                    .regex(/^\d{4}-\d{2}-\d{2}$/)
                    .optional()
                    .describe('Keep filings with filingDate >= this YYYY-MM-DD'),
                maxFilingsPerCompany: z
                    .number()
                    .int()
                    .min(1)
                    .max(100)
                    .optional()
                    .describe('Cap filing rows per company (default 10)'),
                metrics: z
                    .array(z.string())
                    .optional()
                    .describe('XBRL concept names e.g. Assets, NetIncomeLoss; omit for curated defaults'),
                maxFactsPerMetric: z
                    .number()
                    .int()
                    .min(1)
                    .max(50)
                    .optional()
                    .describe('Most-recent values per concept/unit (default 8)'),
                includeTextExcerpt: z
                    .boolean()
                    .optional()
                    .describe('Fetch primary document text excerpts (extra cost)'),
                excerptMaxChars: z
                    .number()
                    .int()
                    .min(100)
                    .max(50000)
                    .optional()
                    .describe('Excerpt length cap (default 2000)'),
            },
        },
        async (args) => {
            const token = process.env.APIFY_TOKEN?.trim();
            if (!token) {
                return missingTokenError();
            }

            const input: ActorInput = {
                companies: args.companies,
                mode: args.mode ?? 'both',
            };
            if (args.formTypes) input.formTypes = args.formTypes;
            if (args.since) input.since = args.since;
            if (args.maxFilingsPerCompany !== undefined) {
                input.maxFilingsPerCompany = args.maxFilingsPerCompany;
            }
            if (args.metrics) input.metrics = args.metrics;
            if (args.maxFactsPerMetric !== undefined) {
                input.maxFactsPerMetric = args.maxFactsPerMetric;
            }
            if (args.includeTextExcerpt !== undefined) {
                input.includeTextExcerpt = args.includeTextExcerpt;
            }
            if (args.excerptMaxChars !== undefined) {
                input.excerptMaxChars = args.excerptMaxChars;
            }

            try {
                const items = await runActor(input, token);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(items, null, 2),
                        },
                    ],
                };
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                {
                                    error: 'APIFY_ACTOR_RUN_FAILED',
                                    message,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                    isError: true,
                };
            }
        },
    );

    return server;
}

async function main(): Promise<void> {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    // Never write secrets; stderr only for fatal startup errors
    console.error('fairquery-edgar MCP server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
});
