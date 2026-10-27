# mesudarim-prices

Downloads Israeli supermarket price files for [Mesudarim](https://mesudarim-app.vercel.app): every branch of every chain, every day.

Since 2015 every supermarket chain in Israel must publish the prices of every branch, every day (the food sector competition law and its price transparency regulations). This downloader reads them on GitHub Actions and writes one compact price map per branch (`{"<barcode>": agorot}`) to Mesudarim's server through its ingest RPCs. The contract with the server is `docs/PRICES-CONTRACT.md` in the app's repository.

- `src/chains.ts`: the 10 chains, where each publishes, and which ones answer only Israeli addresses.
- `src/engines/`: one small client per publishing system (Cerberus FTPS, Shufersal, laibcatalog, Bina, PublishPrice, Hazi Hinam). Each lists every branch's files of a kind and downloads them.
- `src/plan.ts`: what a run sends for each branch, from what is published and what the server has (pure, tested).
- `src/run.ts`: one run. `src/cli.ts`: the commands and the exit code; `src/args.ts`: the flags, checked before anything runs.
- `src/relay.ts`, `relay/`: the Israeli relay (below).
- `src/xml.ts`: decoding (gzip, zip, BOM, UTF-16) and the item and branch readers. `src/localities.ts`: branch cities.

```bash
npm ci
npm test
node --experimental-strip-types src/cli.ts probe --direct            # every chain end to end, no server (--direct: run in Israel)
node --experimental-strip-types src/cli.ts prices --full --dry --direct --out /tmp/dry.json   # a whole run without calling the server
node --experimental-strip-types src/cli.ts prices --full --dry --direct --chains shufersal,rami_levy --products /tmp/products.json   # also the product rows, to check the names
```

## A run

1. Every chain's Stores file. The daily run (`--full`) sends it to `ingest_branches` (cities resolved here; the server maps spellings to one city). If the government locality list does not load, the branches are still sent: a city given as a code goes as `''`, so the server keeps the city it has. Update runs only count the branches (to notice a listing cut short).
2. `price_map_stamps` -> every branch the server knows, with what it has.
3. Per chain, the newest PriceFull of every branch -> `ingest_price_map(p_full = true)` when it is newer than the server's map; then the newer Price (change) files of each branch, merged oldest first -> one `ingest_price_map(p_full = false)`. Every chain's Price files are merged as changes, Victory's too (its hourly files were complete lists on the day it was measured; merging a complete list gives the same map). When the server answers 0 to a full file (it held the file back as cut short, or it was not newer), that branch's change files wait for the next run.
4. `report_chain_status` for each chain when it is done: `ok`, `down` or `needs_relay`. A chain is `down` when a listing fails, more than 10% of its files fail, it fails 5 to 16 times in a row, by how many files it downloads at once (then the rest of it is skipped), it is cut off by the time limit, more than 20% of its listed branches are unknown to the server, or no branch of it was priced. Victory lists only today's files: before 09:00 Israel time an empty listing is `not_published`, and no status is sent for it (its status and yesterday's prices stay as they are). This is the one exception to "a status for every chain on every run". Each chain's report names the branches of its Stores file that have no PriceFull (`withoutPriceFull`; on 2026-10-27 Shufersal's new 550 'דן דיל קריית גת' and 751 'גוד מרקט בני ברק'), and, in a real run, the listed branches the server does not know (`unknown`). The server keeps a new branch selectable for its grace period although it has no prices; whether to hide it until its first map is the server's choice.
5. The daily run also reads every branch it did not send and sends `ingest_products`: one row per product with `chains` (how many of the chains that were `ok` in this run sell it) and `chain_ids` (which). A batch that fails does not stop the batches after it. The server overwrites a product's name with the one sent, so the name is chosen from every chain that sells the product (`src/products.ts`), never by which chain finished first: most chains cut ItemName at 20 characters (Shufersal at 24), and on 2026-10-27 the first chains to finish (Osher Ad, King Store, Super Yuda) gave 26,000 products cut names, four different Feldman ice-pop packs all 'מאגדת שלגוני פלדמן 9'. The rule: a name with Hebrew letters, then the longest, where a name as long as its chain's cut width (found from that chain's own names in the run) counts as 4 characters shorter; ties go by chain order. Each chain offers its ItemName and its ManufacturerItemDescription (Yohananof's ItemName is sometimes only the brand). Quantity, unit and weighted come from the first chain in `src/chains.ts` that sells the product, the manufacturer from the first one that knows it (`''` when every chain says 'לא ידוע', 'כללי', 'שונות' or '---', since the apps show any manufacturer that is not empty).

The process exits 1 when any chain is `down` or the run has a problem: a server call failed, `price_map_stamps` answered without chain and store (or with no branches), a chain listed fewer than 80% of the branches in its Stores file, or the products did not all go in. `needs_relay` alone does not fail a run. A run stops starting downloads after 105 minutes (`--minutes`); work already started gets 5 more minutes, then the chain is reported down. The job's timeout is 120. A mistyped chain or flag exits 2 before anything runs.

`prices` needs `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `PRICES_TOKEN` (repository secrets), except with `--dry`.

### What the server must answer

- `price_map_stamps(p_token)`: every branch, also those without a map, with its chain and store: `{"<branch_id>": {"chain": "shufersal", "store": "444", "file": "20261027030000" | null, "delta": "..." | null}}`. The downloader addresses branches by chain and store. Entries without them fail the run, and branches the server does not know are skipped.
- `ingest_price_map(p_token, p_branch_id, p_file_stamp, p_prices, p_full)` returns the map's item count, 0 when it wrote nothing. `report_chain_status(p_token, p_chain, p_status, p_error, p_branches_priced)`, `ingest_branches`, `ingest_products` and `ingest_report` as in the contract. `ingest_report` receives `{"phase": "started"}` at the start of a run and the full report with `"phase": "finished"` at its end.
- `ingest_products` gets `chain_ids` with each row, but the server's 0072 reads only `chains`: it lowers counts only when every chain was `ok` in the last 3 hours, and otherwise only raises them. Keeping each chain's presence per product from `chain_ids` would be the server's change to make.

**Deploy order.** Do not merge `all-branches` into `main` before the database's 0072 with the `price_map_stamps` above is live: merging changes the workflow file, which starts a full run at once.

## Schedule (`.github/workflows/prices.yml`)

- 03:30 UTC (05:30 in Israel in winter, 06:30 in summer): the full run. Not earlier: Victory publishes only from ~05:00 Israel time. Every 3 hours from 05:30 to 20:30 UTC: update runs (newer files only). A dry full run of all 10 chains from Israel at 19:13 (2026-10-27, no server stamps, so every branch's full list and all of the day's change files) took 10.7 minutes: 1,488 maps (largest 469 KB, 157 MB in all), 104,789 products in 105 batches (largest 270 KB), 613 MB of memory at most. Victory was the longest (628 s, 985 files, 467 MB): its hourly Price files are complete lists of ~10,000 items and are all merged. A real run downloads only the files newer than the server's stamps, about 3 per Victory branch in an update run.
- A push to `main` that changes the workflow file runs the downloader once (full).
- On the 1st of every month a keepalive re-enables the workflow, since GitHub disables the schedule of a public repository after 60 days without activity. That the enable call resets that timer is what other keepalive actions rely on, not something GitHub documents; the database's `prices_stale` alert (no successful run for 30 hours) is the backstop.
- Tests and the type check run on every push to `main`.

### GitHub starts scheduled runs late (a known limit)

GitHub makes no promise about when a scheduled run starts, and under load it delays or drops them. Measured from `gh run list` (old schedule 04:30, 07:30 and 13:30 UTC, plus Sunday 02:00): from 2026-10-24 to 10-27 every scheduled run started 3.3 to 7 hours late (10-26: 04:30 at 10:22, 07:30 at 14:27, 13:30 at 19:28), and some never started (10-27 13:30; the new 20:30 update had not started by 22:14). So:

- The 03:30 full run will often start mid-morning. It is still the full run when it is late: the run step compares `github.event.schedule` (the cron text), not the clock.
- The update runs come less often than every 3 hours, so the apps will often show prices older than 6 hours ("מתבסס על המחירים האחרונים…"). The database's `prices_stale` alert (30 hours) catches only a day without any run.
- Runs never overlap: a run that starts while another is running waits for it (the `prices` concurrency group), and GitHub keeps only the newest waiting run.

Nothing in this repository can make GitHub's scheduler punctual. Starting the runs on time needs a trigger from outside that calls `workflow_dispatch` (`job: full` for the morning run), for example the database's `pg_cron` with `pg_net`, or another scheduler. That needs a GitHub token that may run this workflow, kept as a secret wherever the trigger runs. That choice is the owner's.

### How fresh the prices are

- A branch's stamp moves only when a newer file is written. Where a chain publishes no change file newer than the morning PriceFull, the update runs find nothing to send, and the branch keeps its PriceFull stamp all day although it was checked (in the dry run at 11:37: 331 of Shufersal's 424 branches, all of Osher Ad's 24). Telling the apps "checked and still current" needs a contract addition (for example a checked time per branch).
- Shufersal lists only the newest Price file of each branch, and most of them are older than its 03:00 PriceFull. A change file that a newer one replaces between two update runs is never seen. In practice Shufersal is refreshed once a day.
- Shufersal's download links expire about 30 minutes after the listing. A link that has expired, or that Azure refuses, is fetched again from a fresh listing.

## The Israeli relay

Carrefour, Victory (laibcatalog) and Hazi Hinam's listing pages answer only Israeli addresses (measured from the US, Germany and the Netherlands: TCP dropped or a Cloudflare challenge; from AWS il-central-1: answered). They go through a Lambda in il-central-1 (`relay/template.yaml`) behind a Function URL with `AWS_IAM` auth, allow-listing only those three hosts. The workflow assumes a role through GitHub OIDC (`aws-actions/configure-aws-credentials`, no stored keys) that only this repository's `main` branch can assume, and signs each request with SigV4 (`aws4fetch`). Hazi Hinam's files are on Azure Blob and are fetched directly.

Errors of the relay itself (AWS refusing or throttling the call, the relay refusing a URL) carry no `x-relay-status` header and are reported as `relay: <status> ...`, so they are not mistaken for the chain's own answer. If `RELAY_URL` is set but the AWS step failed (or `RELAY_ROLE_ARN` is missing), these three chains are reported down with that reason and the other chains run as usual.

Setup: the owner deploys `relay/template.yaml` with CloudFormation in il-central-1 (`relay/README.he.md`), then the stack's outputs become two repository variables (Settings > Secrets and variables > Actions > Variables): `RELAY_URL` = `FunctionUrl`, `RELAY_ROLE_ARN` = `RoleArn`. Until they are set, those three chains are reported as `needs_relay`.

The approach is based on [OpenIsraeliSupermarkets/israeli-supermarket-scarpers](https://github.com/OpenIsraeliSupermarkets/israeli-supermarket-scarpers), rewritten without a browser or process pools.
