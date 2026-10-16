/** Live test of every free tool against sec.gov. Never prints APIFY_TOKEN. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const serverJs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const env = { ...process.env }; delete env.APIFY_TOKEN;
const client = new Client({ name: 'fairquery-live', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverJs], env }));
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
let fails = 0;
async function t(name, args, check) {
  const r = await client.callTool({ name, arguments: args });
  const s = r.structuredContent ?? JSON.parse(r.content[0].text);
  let ok = !r.isError; let msg = '';
  try { msg = check(s); } catch (e) { ok = false; msg = e.message; }
  if (!ok) { fails++; msg += ' ' + JSON.stringify(s).slice(0, 300); }
  console.log(ok ? 'PASS' : 'FAIL', name, msg);
  return s;
}
await t('edgar_resolve_company', { queries: ['NVDA', 'apple', '789019'] }, (s) => s.items.map((i) => `${i.ticker}:${i.cik}`).slice(0, 4).join(' '));
const fl = await t('edgar_list_filings', { company: 'AAPL', formTypes: ['10-K'], since: '2020-01-01', limit: 2, offset: 1 }, (s) => { if (s.count !== 2) throw new Error('count'); return `total=${s.total} next=${s.nextOffset} ${s.items.map((i) => i.form + '@' + i.filing_date).join(',')}`; });
await t('edgar_get_filing_document', { documentUrl: fl.items[0].document_url, offset: 0, maxChars: 3000 }, (s) => { if (!s.text.length) throw new Error('empty'); return `total_chars=${s.total_chars} hasMore=${s.hasMore} snippet=${JSON.stringify(s.text.slice(0, 80))}`; });
await t('edgar_get_filing_document', { company: 'AAPL', accessionNumber: fl.items[0].accession_number, offset: 50000, maxChars: 1000 }, (s) => `via accession offset=${s.offset} returned=${s.returned_chars}`);
await t('edgar_get_company_facts', { company: 'MSFT', search: 'revenue', limit: 5 }, (s) => `list total=${s.total} first=${s.items[0]?.concept}`);
await t('edgar_get_company_facts', { company: 'MSFT', concepts: ['Assets', 'NetIncomeLoss'], forms: ['10-K'], fiscalPeriod: 'FY', limit: 4 }, (s) => `values total=${s.total} ${s.items.map((i) => `${i.concept}=${i.value}@${i.end}`).join(' ')}`);
await t('edgar_get_concept_across_companies', { concept: 'Assets', period: 'CY2023Q4I', limit: 3 }, (s) => `total=${s.total} ${s.items.map((i) => `${i.rank}.${i.entity_name}`).join('; ')}`);
await t('edgar_get_concept_across_companies', { concept: 'Revenues', period: 'CY2023', companies: ['AMZN', 'GOOGL'], sort: 'name', limit: 5, offset: 0 }, (s) => `filtered total=${s.total}`);
const bad = await client.callTool({ name: 'edgar_list_filings', arguments: { company: 'zzzznotacompanyxx' } });
console.log(bad.isError && bad.content[0].text.includes('COMPANY_NOT_FOUND') ? 'PASS' : (fails++, 'FAIL'), 'error path COMPANY_NOT_FOUND');
await client.close();
if (fails) { console.log('FAILURES', fails); process.exit(1); }
console.log('ALL PASS');
