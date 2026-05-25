# STSWR School Lookup

A mobile-first PWA for looking up school eligibility by address in the Waterloo Region (Ontario, Canada). Returns assigned elementary and secondary schools from both WRDSB and WCDSB, enriched with Fraser Institute ratings.

## Features

- Single address input with municipality dropdown (Waterloo Region cities)
- Looks up both school boards (WRDSB + WCDSB) simultaneously
- Shows elementary and secondary school assignments
- Fraser Institute ratings auto-fetched on first load, cached locally
- Color-coded rating pills (green/amber/red) with links to full reports
- Installable as PWA with offline support
- Persists last search and results

## How it works

```
User enters address
        │
        ▼
  js/lookup.js resolves street via autocomplete API
        │
        ▼
  CF Worker (/lookup) performs session-aware form submission
  (GET page → extract VIEWSTATE → POST form → follow redirects with cookies)
        │
        ▼
  Results parsed from HTML (SchoolPositions JSON or DOM fallback)
        │
        ▼
  js/ratings.js matches schools against cached ratings (fuzzy name + city)
        │
        ▼
  School cards with color-coded rating pills (clickable)
```

## Stack

- **Frontend:** Vanilla JS, no framework, no build step
- **Backend:** Cloudflare Worker (CORS proxy + session handler + ratings decryptor)
- **Hosting:** GitHub Pages (frontend), Cloudflare Workers free tier (proxy)
- **Data sources:** bpweb.stswr.ca (eligibility), compareschoolrankings.org (ratings)

## Development

Serve static files locally:

```bash
npx serve .
```

Deploy the Worker:

```bash
cd cf-proxy
CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy
```

Frontend deploys automatically on push to `main` via GitHub Pages.

## Project structure

```
├── index.html              App shell
├── css/style.css           Styles
├── js/
│   ├── app.js              UI controller, form handling, state persistence
│   ├── lookup.js           Street resolution + district lookup logic
│   └── ratings.js          Ratings fetch, fuzzy matching, localStorage cache
├── sw.js                   Service worker (cache-first static, network-first API)
├── manifest.json           PWA manifest
├── icons/                  App icons (192, 512, maskable variants)
└── cf-proxy/
    ├── src/index.js        Cloudflare Worker source
    └── wrangler.toml       Worker config
```
