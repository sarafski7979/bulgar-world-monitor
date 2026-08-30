# Railway relay setup — BULGAR — WORLD MONITOR

The relay is **optional**. Skip this document entirely if you are happy without
live AIS vessel tracking and international flight-delay data — the Vercel
deployment builds, serves, and renders the map without it.

Read [`REALTIME_ARCHITECTURE.md`](REALTIME_ARCHITECTURE.md) first for *why* a
separate process exists.

---

## 1. Is a relay still required?

Yes, for these features — and only these:

| Feature | Needs the relay because |
|---|---|
| **AIS vessel tracking** | AISStream pushes positions over a WebSocket that must stay open, and the relay holds an in-memory vessel table it snapshots to browsers every ~5 s. |
| **AviationStack international flight delays** | The relay runs the seed loop and proxies the API. |
| **ICAO NOTAM closures** | Proxied through the relay. |
| **Telegram / X OSINT feeds** | Telegram MTProto is a stateful long-lived session. |
| **Yahoo chart, crypto quotes, OREF alerts, YouTube-live, Google-Flights proxies** | Relay-side caching and rate-limit management. |

**It cannot be folded into Vercel.** Vercel functions cannot hold a long-lived
WebSocket, and they cannot keep the in-memory state the relay depends on. Upstream
built it as a separate always-on process on purpose. Do not restructure it.

---

## 2. What upstream ships for Railway

The repository root already contains a Railway build config — you do not write one.

`nixpacks.toml`:

```toml
[phases.install]
cmds = ["npm ci"]

[phases.build]
cmds = ["npm install", "npm install --prefix scripts"]

[start]
cmd = "node scripts/ais-relay.cjs"

[variables]
NODE_OPTIONS = "--dns-result-order=ipv4first"
```

Note the second install: `scripts/package.json` has its own dependencies (e.g.
`fast-xml-parser`) that the relay needs at runtime.

The relay listens on `process.env.PORT`, falling back to `3004`. Railway sets
`PORT` automatically — do not override it.

---

## 3. Deploy

1. Railway → **New Project → Deploy from GitHub repo** → select your fork.
2. **Root directory: leave empty.** `nixpacks.toml` builds from the repo root
   (the comment at the top of the file explains why — nixpacks only reads config
   from the build root).
3. Set the environment variables in §4.
4. Deploy, then **Settings → Networking → Generate Domain** to get a public
   `https://` URL.
5. Verify: `curl https://<your-relay>.up.railway.app/health` — `/` and `/health`
   are the only public routes.

---

## 4. Relay environment variables

### Required

| Variable | Notes |
|---|---|
| `RELAY_SHARED_SECRET` | **The relay refuses to start without it.** Generate with `openssl rand -hex 32`. Must be byte-identical to the value set on Vercel. |

### Recommended

| Variable | Enables |
|---|---|
| `RELAY_AUTH_HEADER` | Header carrying the secret. Default `x-relay-key`. If you set it here, set the identical value on Vercel. |
| `AISSTREAM_API_KEY` | Live vessel positions. Free key at <https://aisstream.io/>. Without it the relay runs but the AIS layer stays disabled. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Shared cache between the relay and Vercel — the same database both sides use. Strongly recommended. |

### Optional

| Variable | Purpose |
|---|---|
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | Higher OpenSky rate limits for cloud IPs. Register at <https://opensky-network.org/>. |
| `AVIATIONSTACK_API` | International airport delay data. |
| `ICAO_API_KEY` | NOTAM airport-closure detection. |
| `AIS_MAX_VESSELS`, `AIS_MAX_VESSEL_HISTORY`, `AIS_SNAPSHOT_INTERVAL_MS` | Memory/bandwidth tuning. Snapshot interval defaults to 5 000 ms with a 2 000 ms floor. |
| `AIS_UPSTREAM_QUEUE_HIGH_WATER` / `_LOW_WATER` / `_HARD_CAP`, `AIS_UPSTREAM_DRAIN_BATCH`, `AIS_UPSTREAM_DRAIN_BUDGET_MS` | Backpressure on the AISStream firehose. |
| `RELAY_RATE_LIMIT_MAX`, `RELAY_RATE_LIMIT_WINDOW_MS`, `RELAY_RSS_RATE_LIMIT_MAX`, `RELAY_OPENSKY_RATE_LIMIT_MAX`, `RELAY_OREF_RATE_LIMIT_MAX` | Per-route rate limits. |
| `RELAY_MEMORY_CLEANUP_GB` | Heap threshold that triggers the relay's own cleanup pass. |
| `ALLOW_VERCEL_PREVIEW_ORIGINS` | Also allow `*.vercel.app` preview origins to reach the relay. Convenient for preview deploys; leave unset in a production-only setup. |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`, `TELEGRAM_CHANNEL_SET` | Telegram MTProto OSINT poller. |
| `PROXY_URL` | Egress proxy for upstream fetches. |

Full documentation for every one of these is in `.env.example`.

### Never set in production

`ALLOW_UNAUTHENTICATED_RELAY` and `I_UNDERSTAND_THIS_DISABLES_AUTH` disable relay
authentication. They exist for local development. Setting either on a public
relay exposes every proxy route — including credential-backed ones — to anyone
who finds the URL.

---

## 5. Wire Vercel to the relay

In the Vercel project (Settings → Environment Variables, Production + Preview):

| Variable | Value |
|---|---|
| `WS_RELAY_URL` | `https://<your-relay>.up.railway.app` — the **https** URL, not `wss://`. This is the server-side variable read by `api/_relay.js`. |
| `RELAY_SHARED_SECRET` | Identical to the Railway value. |
| `RELAY_AUTH_HEADER` | Identical to the Railway value, if you changed it from the default. |

Redeploy Vercel afterwards.

`VITE_WS_RELAY_URL` also exists, takes a `wss://` URL, and is a **client-side
local/dev fallback only**. You do not need it for a Vercel deployment, and
because it is `VITE_`-prefixed it is compiled into the public bundle — never put
a secret near it.

---

## 6. Verifying the link

| Check | Expected |
|---|---|
| `curl https://<relay>/health` | 200 |
| `curl https://<relay>/metrics` | 401/403 — proves auth is on |
| `curl -H "x-relay-key: $RELAY_SHARED_SECRET" https://<relay>/metrics` | 200 |
| A relay-backed API route on your Vercel domain | Not `503 WS_RELAY_URL is not configured` |
| Maritime/AIS layer in the dashboard | Vessels appear within a minute or two |

If a Vercel route returns `503 {"error":"WS_RELAY_URL is not configured"}`, the
Vercel side is not wired — that error comes from `api/_relay.js` before any
network call. If it returns 401/403, the two secrets do not match.

---

## 7. Cost and operational shape

The relay is a single always-on Node process holding an in-memory vessel table.
It is small but it must not sleep — a scale-to-zero platform will drop the
AISStream socket and the vessel table with it. On Railway, keep it on a plan that
does not idle the service.

If you do not want a permanently-running process, do not deploy the relay: set
`VITE_ENABLE_AIS=false` on Vercel so the maritime layer does not advertise itself
with nothing behind it, and accept the documented fallbacks in
[`REALTIME_ARCHITECTURE.md §4`](REALTIME_ARCHITECTURE.md).
