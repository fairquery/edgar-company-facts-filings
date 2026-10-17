# Development

This file covers local development of the **EDGAR Company Facts & Filings for Agents** Apify Actor. The Apify Store README is [`.actor/README.md`](./.actor/README.md) (`readme` in `.actor/actor.json`). The GitHub [README.md](./README.md) adds the local MCP server notes.

## Run locally

```bash
npm install
# put input in storage/key_value_stores/default/INPUT.json, for example:
# {"companies": ["AAPL"], "mode": "facts", "metrics": ["Assets"]}
npx apify run
npm test
```

## Local stdio MCP server

```bash
cd mcp && npm install && npm run build
node scripts/smoke-test.mjs                          # initialize + tools/list, no token
APIFY_TOKEN=... node scripts/smoke-test.mjs --call   # real (billed) tool call
```

Optional local pay-per-event dry run: `ACTOR_TEST_PAY_PER_EVENT=1 npx apify run`.

## Notes

- Sample values in the input schema are `prefill`/`example` only, never `default`. An API call without input therefore fails fast with `INPUT_EMPTY` and is not billed for sample data. Keep it that way.
- The Actor is deployed to Apify as source files (`apify push`), not from this Git repo. Check that you have the latest deployed source before you push.
- Contributions and issues: https://github.com/fairquery/edgar-company-facts-filings/issues
