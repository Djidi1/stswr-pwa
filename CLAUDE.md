# STSWR School Lookup PWA

## What this is

A PWA that looks up school eligibility for Waterloo Region addresses via bpweb.stswr.ca and enriches results with Fraser Institute ratings from compareschoolrankings.org.

## Architecture

```
Frontend (static, GitHub Pages)        Backend (Cloudflare Worker)
─────────────────────────────────      ──────────────────────────────────
index.html  — app shell                cf-proxy/src/index.js
js/app.js   — UI controller              POST /lookup — session-aware form
js/lookup.js — autocomplete + lookup      GET  /ratings — encrypted API decrypt
js/ratings.js — rating match + cache      GET  /<url> — generic proxy passthrough
sw.js       — service worker (cache-first)
css/style.css
```

## Key constraints

- No framework, no bundler — plain JS served as static files
- bpweb.stswr.ca requires cookies across GET→POST redirects — the Worker handles this server-side via `fetchFollowRedirects` with a cookie jar
- compareschoolrankings.org encrypts its API response with AES-256-CBC; the Worker derives the time-based key (SHA1) and decrypts server-side
- Ratings cached in localStorage, matched to lookup results by fuzzy school name + city preference
- SW uses cache-first for local assets, network-first for proxy calls

## Deploying

- **Frontend:** Push to `main` → GitHub Pages auto-deploys
- **Worker:** `cd cf-proxy && CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy`

## File responsibilities

| File | Role |
|------|------|
| `js/lookup.js` | Street autocomplete resolution, district lookup via `/lookup` endpoint |
| `js/ratings.js` | Fetch ratings via `/ratings`, fuzzy name matching, localStorage cache |
| `js/app.js` | DOM wiring, form parsing, state persistence, auto-fetch ratings, card rendering with color-coded rating pills |
| `cf-proxy/src/index.js` | All server-side logic: CORS proxy, session-aware lookup, ratings decrypt |
| `sw.js` | Offline support, cache versioning |

## Conventions

- Bump `CACHE_NAME` version in `sw.js` on every deploy that changes static assets
- Municipality list is hardcoded to Waterloo Region cities (in both `index.html` select and `ratings.js` filter)
- `PROXY_PREFIX` in `lookup.js` is the single source of truth for the Worker URL
- CSS uses custom properties (`:root` vars: `--primary`, `--radius`, `--shadow-*`, etc.) as the design system
- Ratings auto-fetch on first load if not cached; no manual import
