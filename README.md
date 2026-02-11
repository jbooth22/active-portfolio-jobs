# Active Capital — Portfolio Jobs (restart)

This repo powers a simple static page that lists open roles across Active Capital's portfolio companies.

## What this version fixes

- **Always shows every company** from `data/companies.csv` (even if it has 0 jobs today).
- **Stops junk jobs** (privacy policy, login, "powered by" links, etc.).
- **Stops junk links** by only accepting links that match the expected job-board patterns (Ashby, Workday, Greenhouse, etc.) and same-origin links for conservative `custom_html`.
- **Adds visibility** into why something is missing via `site/coverage.json`.

## Files that matter

- `data/companies.csv` — the source of truth for portfolio companies and their careers URLs
- `src/scrape.mjs` — scrapes each careers page and writes:
  - `data/raw_jobs.json` (raw results)
  - `site/coverage.json` (per-company status + errors)
- `src/build_site.mjs` — normalizes/cleans jobs and writes:
  - `site/jobs.json` (clean jobs)
  - `site/companies.json` (all companies + job counts)
  - `site/rejected_jobs.json` (debug: what got filtered)
  - `site/last_updated.json`
- `site/index.html` — the static website

## Run locally (optional)

```bash
bun install
bun run update
```

## Daily refresh (GitHub Actions)

`.github/workflows/daily_refresh.yml` runs `bun run update` daily and pushes changes back to `main`.

## Cloudflare Pages settings

- **Build command:** *(leave blank)*
- **Output directory:** `site`

Cloudflare Pages will deploy the static assets under `site/`.
