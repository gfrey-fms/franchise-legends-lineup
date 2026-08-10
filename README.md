# Franchise Legends — Lineup Planner

CS 1.6–themed multi-year dynasty roster & contract planner with live Fantrax data.

**Repo:** https://github.com/gfrey-fms/franchise-legends-lineup

## Features

- Login gate (shared password)
- Paste Fantrax league ID → pick your team
- MLB diamond lineup with drag-and-drop by eligibility
- Multi-year projections (current + 3 offseason years)
- Contract tools: extend 1/R2, franchise tag (F), freeze, R1→R2
- Constitution-aligned rules ($260 keeper / $360 in-season, inflation, MiLB R = $0)

## Quick start

1. Open `index.html` in a browser (or deploy below).
2. Password: `legends` (change `APP_PASSWORD` in the JS before sharing).
3. Paste your Fantrax league ID (e.g. `0qqrp8mwmgppoixe`).
4. Pick your team → Open Dashboard.

## Deploy (free)

### Cloudflare Pages (recommended)
1. [Cloudflare Pages](https://pages.cloudflare.com/) → Create project
2. Connect this GitHub repo
3. Build command: *(leave empty)* · Output directory: `/`
4. Deploy — free SSL + unlimited bandwidth

### GitHub Pages
Settings → Pages → Source: Deploy from branch `main` → Save

## Stack

Static HTML/CSS/JS + [cs16.css](https://cs16.samke.me/). No build step, no backend. Fantrax public API (CORS enabled).

## Note on app files

If `app.css` / `app.js` are missing from this repo, use the single-file build `lineup_tracker.html` from the project artifacts (rename to `index.html` and upload). The single-file version is self-contained.
