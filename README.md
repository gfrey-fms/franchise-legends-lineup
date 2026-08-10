# Franchise Legends — Lineup Planner

CS 1.6–themed multi-year dynasty roster & contract planner with live Fantrax data.

## Features

- Login gate (shared password)
- Paste Fantrax league ID → pick your team
- MLB diamond lineup with drag-and-drop by eligibility
- Multi-year projections (current + 3 offseason years)
- Contract tools: extend 1/R2, franchise tag (F), freeze, R1→R2
- Constitution-aligned rules ($260 keeper / $360 in-season, inflation, MiLB R = $0)

## Use locally

Open `index.html` in a browser.

Default password: `legends` (change `APP_PASSWORD` in the script before sharing).

## Deploy (free)

**Cloudflare Pages** recommended — unlimited bandwidth, free SSL:

1. Cloudflare → Pages → Create project
2. Upload this repo or connect GitHub
3. Deploy

GitHub Pages also works (Settings → Pages → Deploy from branch).

## Fantrax

Uses public Fantrax endpoints (`getTeamRosters`, `getLeagueInfo`, `getPlayerIds`). No API key required. League ID is entered at runtime.

## Stack

Single static HTML + [cs16.css](https://cs16.samke.me/) — no build step, no backend.
