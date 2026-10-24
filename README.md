# mesudarim-prices

Downloads Israeli supermarket price files for [Mesudarim](https://mesudarim-app.vercel.app) — only what its users need.

Since 2015 every supermarket chain in Israel must publish the prices of every branch, every day (the food sector competition law and its price transparency regulations). Downloading all of it is over a gigabyte a day. This downloader fetches only the branches Mesudarim's groups chose, keeps only the products someone tracks, and writes a few thousand rows per branch to Mesudarim's server, so it runs on GitHub Actions' free minutes and the free database tier.

- `src/chains.ts`: the 10 chains and where each publishes.
- `src/engines/`: one small client per publishing system (Cerberus FTP, Shufersal, laibcatalog, Bina, PublishPrice, Hazi Hinam).
- `src/xml.ts`: decoding (gzip, zip, BOM, UTF-16) and the item and branch readers.
- `src/run.ts`: `prices` (daily) and `catalog` (weekly).

```bash
npm ci
npm test
node --experimental-strip-types src/cli.ts probe          # checks every chain, needs no server
node --experimental-strip-types src/cli.ts probe shufersal
```

`prices` and `catalog` need `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `PRICES_TOKEN` (repository secrets).

The approach is based on [OpenIsraeliSupermarkets/israeli-supermarket-scarpers](https://github.com/OpenIsraeliSupermarkets/israeli-supermarket-scarpers), rewritten to fetch a single branch's newest file per chain without a browser or process pools.
