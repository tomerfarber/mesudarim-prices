# mesudarim-prices

Downloads Israeli supermarket price files for [Mesudarim](https://mesudarim-app.vercel.app): every branch of every chain, every day.

Since 2015 every supermarket chain in Israel must publish the prices of every branch, every day (the food sector competition law and its price transparency regulations). This downloader reads them on GitHub Actions and writes one compact price map per branch (`{"<barcode>": agorot}`) to Mesudarim's server through its ingest RPCs. The contract with the server is `docs/PRICES-CONTRACT.md` in the app's repository.

- `src/chains.ts`: the 10 chains, where each publishes, and which ones answer only Israeli addresses.
- `src/engines/`: one small client per publishing system (Cerberus FTPS, Shufersal, laibcatalog, Bina, PublishPrice, Hazi Hinam). Each lists every branch's files of a kind and downloads them.
- `src/plan.ts`: what a run sends for each branch, from what is published and what the server has (pure, tested).
- `src/run.ts`: one run. `src/cli.ts`: flags and the exit code.
- `src/relay.ts`, `relay/`: the Israeli relay (below).
- `src/xml.ts`: decoding (gzip, zip, BOM, UTF-16) and the item and branch readers. `src/localities.ts`: branch cities.

```bash
npm ci
npm test
node --experimental-strip-types src/cli.ts probe --direct            # every chain end to end, no server (--direct: run in Israel)
node --experimental-strip-types src/cli.ts prices --full --dry --direct --out /tmp/dry.json   # a whole run without calling the server
```

## A run

1. Every chain's Stores file -> `ingest_branches` (cities resolved here; the server maps spellings to one city).
2. `price_map_stamps` -> what the server has per branch.
3. Per chain, the newest PriceFull of every branch -> `ingest_price_map(p_full = true)` when it is newer than the server's map; then the newer Price (change) files of each branch, merged oldest first -> one `ingest_price_map(p_full = false)`. Victory's hourly Price files are complete lists, so the newest one replaces the map.
4. `report_chain_status` for each chain when it is done: `ok`, `down` (a listing failed, or more than 10% of its files), or `needs_relay`. Victory lists only today's files: before 09:00 Israel time an empty listing leaves its status as it was.
5. The daily run (`--full`) also reads every branch it did not send and sends `ingest_products`: one row per product with `chains` and `chain_ids`, the chains that were `ok` in this run and sell it. Statuses are reported first, so the server can keep the earlier presence of a chain that was not `ok` (a failed chain never lowers the counts).

The process exits 1 when any chain is `down` or a server call failed, so GitHub shows a red run and emails the owner. `needs_relay` alone does not fail a run. A run stops starting downloads after 105 minutes (`--minutes`) and reports the unfinished chain as down; the job's timeout is 120.

`prices` needs `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `PRICES_TOKEN` (repository secrets), except with `--dry`.

### What the server must answer

- `price_map_stamps(p_token)`: every branch, also those without a map, with its chain and store: `{"<branch_id>": {"chain": "shufersal", "store": "444", "file": "20261027030000" | null, "delta": "..." | null}}`. The downloader addresses branches by chain and store; a store missing from the answer is reported as unknown and skipped.
- `ingest_price_map(p_token, p_branch_id, p_file_stamp, p_prices, p_full)`, `report_chain_status(p_token, p_chain, p_status, p_error, p_branches_priced)`, `ingest_branches`, `ingest_products` and `ingest_report` as in the contract. `ingest_report` receives `{"phase": "started"}` at the start of a run and the full report with `"phase": "finished"` at its end.

## Schedule (`.github/workflows/prices.yml`)

- 02:30 UTC: the full run. Every 2 hours from 04:30 to 20:30 UTC: update runs (newer files only; Victory appears in the first one after ~05:00 Israel time).
- A push to `main` that changes the workflow file runs the downloader once (full).
- On the 1st of every month a keepalive re-enables the workflow, since GitHub disables the schedule of a public repository after 60 days without activity.
- Tests and the type check run on every push to `main`.

## The Israeli relay

Carrefour, Victory (laibcatalog) and Hazi Hinam's listing pages answer only Israeli addresses (measured from the US, Germany and the Netherlands: TCP dropped or a Cloudflare challenge; from AWS il-central-1: answered). They go through a Lambda in il-central-1 (`relay/template.yaml`) behind a Function URL with `AWS_IAM` auth, allow-listing only those three hosts. The workflow assumes a role through GitHub OIDC (`aws-actions/configure-aws-credentials`, no stored keys) that only this repository's `main` branch can assume, and signs each request with SigV4 (`aws4fetch`). Hazi Hinam's files are on Azure Blob and are fetched directly.

Setup: the owner deploys `relay/template.yaml` with CloudFormation in il-central-1 (`relay/README.he.md`), then the stack's outputs become two repository variables (Settings > Secrets and variables > Actions > Variables): `RELAY_URL` = `FunctionUrl`, `RELAY_ROLE_ARN` = `RoleArn`. Until they are set, those three chains are reported as `needs_relay`.

The approach is based on [OpenIsraeliSupermarkets/israeli-supermarket-scarpers](https://github.com/OpenIsraeliSupermarkets/israeli-supermarket-scarpers), rewritten without a browser or process pools.
