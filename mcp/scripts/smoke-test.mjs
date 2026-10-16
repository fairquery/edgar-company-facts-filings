/**
 * Smoke test: initialize + tools/list without token; optional --call with APIFY_TOKEN.
 * Never prints APIFY_TOKEN.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(__dirname, '..', 'dist', 'index.js');
const doCall = process.argv.includes('--call');

async function withClient(env, fn) {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverJs],
        env,
        stderr: 'pipe',
    });
    const client = new Client({ name: 'fairquery-smoke', version: '1.0.0' });
    await client.connect(transport);
    try {
        return await fn(client);
    } finally {
        await client.close();
    }
}

const baseEnv = { ...process.env };
delete baseEnv.APIFY_TOKEN;

await withClient(baseEnv, async (client) => {
    console.log('OK connect+initialize (no token)');
    const { tools } = await client.listTools();
    console.log('OK tools/list count=', tools.length);
    for (const t of tools) {
        console.log('  tool:', t.name);
    }
    if (!tools.some((t) => t.name === 'edgar_batch_export')) {
        throw new Error('expected tool edgar_batch_export');
    }
    const noToken = await client.callTool({
        name: 'edgar_batch_export',
        arguments: { companies: ['AAPL'], mode: 'facts' },
    });
    const text = JSON.stringify(noToken);
    if (!text.includes('APIFY_TOKEN_MISSING')) {
        throw new Error('expected APIFY_TOKEN_MISSING without token, got: ' + text.slice(0, 300));
    }
    console.log('OK tool without token -> APIFY_TOKEN_MISSING');
});

if (doCall) {
    if (!process.env.APIFY_TOKEN) {
        console.error('FAIL APIFY_TOKEN not set for --call');
        process.exit(1);
    }
    await withClient({ ...process.env }, async (client) => {
        console.log('OK connect+initialize (with token present, value not logged)');
        const result = await client.callTool({
            name: 'edgar_batch_export',
            arguments: {
                companies: ['AAPL'],
                mode: 'facts',
                metrics: ['Assets'],
                maxFactsPerMetric: 2,
            },
        });
        if (result.isError) {
            throw new Error('tool call failed: ' + JSON.stringify(result).slice(0, 500));
        }
        const content = result.content?.[0];
        const raw = content && content.type === 'text' ? content.text : JSON.stringify(result);
        const parsed0 = JSON.parse(raw); const parsed = Array.isArray(parsed0) ? parsed0 : parsed0.items;
        const n = Array.isArray(parsed) ? parsed.length : 1;
        const types = Array.isArray(parsed)
            ? [...new Set(parsed.map((r) => r.type).filter(Boolean))]
            : [];
        console.log('OK tool call rows=', n, 'types=', types.join(',') || 'n/a');
        if (Array.isArray(parsed) && parsed[0]) {
            console.log('OK first_row_keys=', Object.keys(parsed[0]).slice(0, 12).join(','));
        }
    });
}

console.log('OK done');
