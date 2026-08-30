# Realtime and data architecture — BULGAR — WORLD MONITOR

What is actually live, what is polled, and what happens when a credential is
missing. This documents upstream World Monitor's design as deployed by Bulgar —
none of it was changed by the fork.

---

## 1. The three transports

The dashboard gets data over exactly three paths. Which one a layer uses is an
upstream design decision, and it is the reason a relay exists at all.

| # | Transport | Runs on | Used for |
|---|---|---|---|
| **A** | Browser → Vercel Function → upstream API | Vercel Edge / Node functions (`api/`) | Most layers. Request/response, cached in Upstash Redis where configured. |
| **B** | Browser → **WebSocket** → relay | A separate always-on Node process (`scripts/ais-relay.cjs`), designed for Railway | Continuously-streaming sources that need a connection held open — chiefly AIS vessel traffic. |
| **C** | Browser → Vercel Function → relay HTTP endpoint | Vercel function proxying to the relay | Sources the relay polls and caches on the browser's behalf: AviationStack, NOTAM, Yahoo charts, crypto quotes, OREF alerts, RSS, Telegram/X intel. |

### Why the relay is not a Vercel function

**Vercel functions cannot hold a long-lived WebSocket connection.** AISStream
pushes vessel positions continuously over a socket that must stay open, and the
relay maintains an in-memory vessel table (capped by `AIS_MAX_VESSELS`) that it
snapshots to connected browsers every `AIS_SNAPSHOT_INTERVAL_MS` (default
**5 000 ms**, floor 2 000 ms). A function that cold-starts and dies per request
cannot do either.

**Do not try to move the relay into Vercel.** It is stateful by design. Deploy it
separately — see [`RAILWAY_RELAY_SETUP.md`](RAILWAY_RELAY_SETUP.md).

The relay is optional. Without it the app runs; the layers that depend on it
disable themselves (see §4).

---

## 2. Relay endpoints

`scripts/ais-relay.cjs` is ~13 200 lines and serves both a WebSocket upgrade and
a plain HTTP surface on one port.

| Path | Purpose | Auth |
|---|---|---|
| `/` , `/health` | Liveness | public |
| `/metrics` | Relay metrics | secret |
| *(WebSocket upgrade)* | AIS vessel stream | secret |
| `/aviationstack` | International airport delays | secret |
| `/notam` | ICAO NOTAM airport closures | secret |
| `/yahoo-chart` | Market chart proxy | secret |
| `/crypto-quotes` | Crypto quotes | secret |
| `/oref/alerts`, `/oref/history` | OREF alerts | secret |
| `/telegram`, `/telegram/*` | Telegram MTProto OSINT poller | secret |
| `/x`, `/x/*` | X/Twitter intel feed | secret |
| `/youtube-live`, `/google-flights/*` | Media / flight search proxies | secret |
| `/opensky-reset`, `/opensky-diag` | OpenSky cooldown diagnostics | secret |
| RSS routes, `/widget-agent*` | RSS proxy, widget agent | public / key |

**Authentication.** Every non-public route requires `RELAY_SHARED_SECRET`, sent
in the header named by `RELAY_AUTH_HEADER` (default `x-relay-key`). **The relay
refuses to start without `RELAY_SHARED_SECRET`.** There is an
`ALLOW_UNAUTHENTICATED_RELAY` / `I_UNDERSTAND_THIS_DISABLES_AUTH` escape hatch in
the source — it is named that way for a reason. Never set it in production.

On the Vercel side, `api/_relay.js` reads `WS_RELAY_URL`; when it is unset the
relay-backed routes answer **`503 {"error":"WS_RELAY_URL is not configured"}`**
rather than failing silently. `api/telegram-feed.js` and `api/x-feed.js` do the
same.

---

## 3. Polling cadence

Client-side refresh is driven by `REFRESH_INTERVALS` in
`src/config/variants/base.ts`, scheduled through `src/app/refresh-scheduler.ts`.
The scheduler leases each lane, pauses hidden tabs, and gates many lanes on
whether the panel is near the viewport — so these are ceilings, not guarantees.

| Layer / lane | Interval |
|---|---|
| Telegram intel | 1 min |
| Service status | 3 min |
| Strategic risk, correlation engine, oil inventories, hyperliquid flow, health freshness | 5 min |
| Weather, cyber threats, Canada roads/alerts, pizzint, WSB tickers, Gulf economies | 10 min |
| Temporal baseline | 10 min |
| Markets, crypto | 12 min |
| Predictions, stock analysis, stablecoins, ETF flows, macro signals, strategic posture, China corridors, China activity nowcast, cross-source signals, intelligence, X intel | 15 min |
| AIS *(client lane; the live stream itself is push)* | 15 min |
| News feeds | 20 min |
| Forecasts, FIRMS fires, undersea cables, fear & greed, climate news | 30 min |
| Daily market brief, trade policy, supply chain, Hormuz tracker, fuel shortages, energy disruptions | 1 h |
| Cable health, flights, market implications | 2–3 h |
| Stock backtest | 4 h |
| FRED, oil, spending, BIS, grocery basket, fuel prices, FX, energy crisis | 6 h |
| FAO food price index, defense patents, pipeline status, storage facility map | 24 h |

Server-side caching (Upstash Redis, §5) means one visitor's refresh usually
serves everyone else's.

---

## 4. Source → credential → fallback

This table is generated from `src/services/runtime-config.ts`, which is the code
that decides whether a feature renders live or shows its disabled state. The
**"Without the credential"** column is quoted from that file.

| Feature | Credential | Without the credential |
|---|---|---|
| AIS vessel tracking | `WS_RELAY_URL` + `AISSTREAM_API_KEY` | AIS layer is disabled. |
| Military flight tracking | *(none — Redis-backed edge handler)* | Military flights panel is disabled. |
| OpenSky military flights (legacy) | `VITE_OPENSKY_RELAY_URL`, `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | Military flights fall back to limited/no data. |
| Wingbits aircraft enrichment | `WINGBITS_API_KEY` | Flight map still renders with heuristic-only classification. |
| AviationStack flight delays | `WS_RELAY_URL` | Non-US airports use simulated delay data. |
| ICAO NOTAM closures (MENA) | `ICAO_API_KEY` | Closures detected only via AviationStack flight cancellation data. |
| ACLED conflicts & protests | `ACLED_ACCESS_TOKEN` | Conflict/protest overlays are hidden. |
| UCDP conflict events | `UCDP_ACCESS_TOKEN` | UCDP conflict layer is disabled. |
| Cloudflare outage radar | `CLOUDFLARE_API_TOKEN` | Outage layer is disabled and map continues with other feeds. |
| NASA FIRMS fire data | `NASA_FIRMS_API_KEY` | FIRMS fire layer uses public VIIRS feed. |
| FRED economic indicators | `FRED_API_KEY` | Economic panel remains available with non-FRED metrics. |
| Supply chain intelligence | `FRED_API_KEY` | Chokepoints and minerals always available; shipping requires FRED key. |
| EIA oil analytics | `EIA_API_KEY` | Oil analytics cards show disabled state. |
| Finnhub market data | `FINNHUB_API_KEY` | Stock ticker uses limited free data. |
| WTO trade policy data | `WTO_API_KEY` | Trade policy panel shows disabled state. |
| abuse.ch cyber IOC feeds | `URLHAUS_AUTH_KEY` | URLhaus/ThreatFox IOC ingestion is disabled. |
| AlienVault OTX threat intel | `OTX_API_KEY` | OTX IOC enrichment is disabled. |
| AbuseIPDB threat intel | `ABUSEIPDB_API_KEY` | AbuseIPDB enrichment is disabled. |
| Exa stock-news search | `EXA_API_KEYS` | Falls back to Brave, then SerpAPI, then Google News RSS. |
| Brave stock-news search | `BRAVE_API_KEYS` | Falls back to SerpAPI, then Google News RSS. |
| SerpAPI stock-news search | `SERPAPI_API_KEYS` | Falls back to Google News RSS. |
| Ollama local summarization | `OLLAMA_API_URL`, `OLLAMA_MODEL` | Falls back to Groq, then OpenRouter, then local browser model. |
| Groq summarization | `GROQ_API_KEY` | Falls back to OpenRouter, then local browser model. |
| OpenRouter summarization | `OPENROUTER_API_KEY` | Falls back to local browser model only. |
| News per-feed fallback | *(none)* | Stale headlines remain available; limited per-feed fallback is disabled. |

### Layers that need no credential at all

These work on a bare deployment with zero environment variables, because they
read public sources through Vercel functions:

earthquakes · wildfires (public VIIRS) · weather · news / RSS aggregation ·
infrastructure · undersea cables · shipping chokepoints · critical minerals ·
country risk and the Country Instability Index · satellites / orbital ·
prediction markets · free-tier market and commodity data · military flights
(Redis-backed edge handler).

### No mock data substitution

Nothing in this fork replaces a live feed with fabricated data. Where upstream
does synthesize, it says so and it is scoped: **AviationStack** is the one case
in the table above — without `WS_RELAY_URL`, non-US airport delays are
*simulated*, and that is upstream's own documented fallback, surfaced in the UI
rather than passed off as live.

---

## 5. Caching

- **Upstash Redis over REST** (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`)
  is referenced across roughly 99 files in `api/` and `server/`. It deduplicates
  AI calls, caches risk scores, and holds seeded layer payloads so one cold fetch
  serves every visitor.
- Without it the app still works, but every would-be cache hit becomes a live
  upstream fetch. On a public deployment this is what makes third-party rate
  limits bite first. It is the highest-value optional variable.
- HTTP caching is configured per-route in `vercel.json` (90 header rules).
- The relay keeps its own in-memory state (vessel table, OpenSky cooldowns) and
  can back up seed bundles — see `scripts/seed-bundle-relay-backup.mjs`.

---

## 6. Data freshness in the UI

The header status indicator is **state-driven, not decorative**. `src/App.ts`
toggles `.status-indicator--cached` and `.status-indicator--unavailable` on the
element, so "LIVE" is shown only when the data path is actually live; otherwise
it renders the cached or unavailable state. The Bulgar branding change did not
touch this logic, and deliberately did not add a second, cosmetic "LIVE" badge.

The header also carries a real UTC clock (`#headerClock`), hidden below 768 px by
upstream's own responsive rules.

---

## 7. Security notes for this deployment

- **Relay auth is mandatory.** `RELAY_SHARED_SECRET` must be set; the relay will
  not start without it. Do not enable `ALLOW_UNAUTHENTICATED_RELAY`.
- **Relay credentials belong on the relay host, not on Vercel.**
  `AISSTREAM_API_KEY`, `OPENSKY_CLIENT_*` and the Telegram credentials are read
  by `scripts/ais-relay.cjs`. Vercel only needs `WS_RELAY_URL`,
  `RELAY_SHARED_SECRET` and `RELAY_AUTH_HEADER`.
- **No secret may carry a `VITE_` prefix.** Those are compiled into the public
  bundle. `npm run security:vite-env-secrets -- --strict-local` runs first in the
  production build and fails it on a violation.
- **The API CORS allowlist is a security allowlist**, hard-coded in
  `api/_cors.js` and `server/cors.ts` to `*.worldmonitor.app`, upstream's Vercel
  preview scope, and the Tauri desktop origins. It was left unchanged. Same-origin
  dashboard traffic never consults it. If you extend it, add a specific origin —
  never a bare `*.vercel.app`.
- **RSS/proxy routes are domain-allowlisted** (`api/_rss-allowed-domains.js`,
  `api/_rss-allowed-domain-match.js`) rather than acting as an open fetch proxy.
  Keep it that way.
