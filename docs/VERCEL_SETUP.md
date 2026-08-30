# Vercel setup — BULGAR — WORLD MONITOR

How to import this fork into Vercel and get a working production deployment.

**Vercel is the build machine.** GitHub is the source of truth; Vercel installs
dependencies, runs the production build, hosts the static frontend, and hosts the
API and Edge functions. No local machine needs to run `npm ci` or `npm run build`.

> **Not a Next.js project.** This is a **Vite + TypeScript** single-page app with a
> directory of Vercel Functions (`api/`) and one Edge Middleware (`middleware.ts`)
> around it. If Vercel ever detects "Next.js", the framework preset is wrong — fix
> it before debugging anything else.

---

## 1. Import the repository

1. Push this fork to GitHub (see the push commands in the project report, or
   `git push -u origin feat/bulgar-world-monitor`).
2. Vercel dashboard → **Add New… → Project**.
3. **Import Git Repository** → pick your fork.
4. On the configure screen, set the values in §2, then **Deploy**.

The first build takes a while: the install runs three dependency trees (root,
`blog-site/`, `pro-test/`) and the build runs an Astro blog build, a second Vite
build, a corpus/sitemap generation pass, a full `tsc`, and the main Vite build.

---

## 2. Project settings

### Framework and build

| Setting | Value | Where it comes from |
|---|---|---|
| **Framework Preset** | `Vite` | Vercel auto-detects this. Do not set Next.js. |
| **Build Command** | *leave as detected* | **Overridden by `vercel.json`** → `npm run build:full`. Anything typed in the dashboard is ignored. |
| **Install Command** | *leave empty* (`npm install`) | The root `postinstall` hook installs `blog-site/` (`npm --prefix blog-site ci --prefer-offline`). `build:pro` installs `pro-test/`. Overriding the install command with `npm ci --ignore-scripts` **breaks the blog build**. |
| **Output Directory** | *leave empty* (`dist`) | Vite's default. `vercel.json` sets no `outputDirectory`. |
| **Root Directory** | *leave empty* (repo root) | `vercel.json`, `api/` and `middleware.ts` all live at the root. |

`vercel.json` also sets `"ignoreCommand": "bash scripts/vercel-ignore.sh"` — see
§6, it will cancel some of your deploys **on purpose**.

### Node.js version

The repo's `.nvmrc` pins **Node 24**. Vercel does **not** read `.nvmrc` for the
build runtime — it reads `engines.node` in `package.json` (absent here) and then
the project setting.

**Set it explicitly:** Settings → General → **Node.js Version**.

Pick the highest version your account offers, 22.x or above. If the build fails
with a syntax error inside a dependency or a `node:` builtin import, the Node
version is too old — raise it before investigating anything else.

---

## 3. Environment variables

Settings → **Environment Variables**.

**A deployment with zero variables set builds and works.** The map renders and
every public-source layer works. Start there, confirm it deploys, then add keys.

- Start from [`.env.minimum.example`](../.env.minimum.example) — the curated
  subset, with per-variable notes on what each one enables and what happens
  without it.
- [`.env.example`](../.env.example) is the complete reference (271 variables).

### Scoping

| Variable kind | Environments to tick |
|---|---|
| Server-side secrets (`WS_RELAY_URL`, `RELAY_SHARED_SECRET`, `*_API_KEY`, `UPSTASH_*`) | Production + Preview |
| `VITE_*` build-time flags | Production + Preview |
| Anything you only use locally | Development only |

### Two rules that are enforced by the build

1. **`VITE_`-prefixed variables are public.** They are inlined into the JS bundle
   at build time. `npm run security:vite-env-secrets -- --strict-local` runs as
   the **first step** of `build:full` and fails the build if a `VITE_` name
   matches `api_key` / `access_token` / `secret` / `token` / `password` /
   `private_key` / `credential`. Do not rename around the guard — move the value
   server-side.
2. **`VITE_*` changes need a redeploy**, not a restart. They are compiled in.

---

## 4. What Vercel actually builds

`vercel.json` → `"buildCommand": "npm run build:full"`, which expands to:

```
prebuild:full   npm run product:facts            # generate-product-config + public product facts + inventory facts
build:full      security:vite-env-secrets --strict-local
                build:openapi                    # copy OpenAPI yaml → public/, emit json
                build:agent-skills               # agent skills index
                build:blog:raw                   # cd blog-site && npm run build  (Astro) → public/blog/
                build:pro                        # npm --prefix pro-test ci && build (a second Vite app)
                build:crawlable-corpus           # indexable reference pages
                build:sitemap
                VITE_VARIANT=full tsc && vite build
```

Static output lands in `dist/`.

### Functions

- **`api/**`** — 157 route files become Vercel Functions. 114 of them declare
  `export const config = { runtime: 'edge' }`; the rest run on the Node runtime.
  Files prefixed with `_` are shared helpers, not routes.
- **`.vercelignore`** excludes `api/**/*.test.mjs`. Keep that. Every
  non-underscore file under `api/` becomes a *live* function, and a deployed
  test file would execute its whole `node:test` suite on every request.
- **`middleware.ts`** — one Edge Middleware. It serves real 404s for unknown
  page paths, redirects legacy dashboard URLs, and emits variant-specific
  crawler stubs. It does **not** gate unknown hosts, so your Vercel domain
  passes through it normally.

### Routing

`vercel.json` carries 57 redirects, 34 rewrites and 90 header rules. Two are
worth knowing about on a fork:

- `/` has a rewrite to `/pro/welcome.html` **conditioned on
  `host = worldmonitor.app`**. On your domain that condition does not match, so
  `/` serves the dashboard directly. This is the behaviour you want.
- `/docs/:match*` proxies to `worldmonitor.mintlify.dev`. Upstream documentation
  will be served from your domain. Remove that rewrite if you would rather link
  out.

---

## 5. Canonical URL — the one thing to fix after your domain is live

`src/config/variant-meta.ts` still points at upstream:

```ts
full: {
  url: 'https://www.worldmonitor.app/dashboard',
}
```

That value becomes `<link rel="canonical">`, `og:url` and `twitter:url`, and the
origin for OG images. Left as-is, search engines are told your deployment is a
duplicate of upstream.

It was **deliberately not changed** during the fork prep because no Bulgar domain
had been chosen yet. Once you have one:

1. Edit `full.url` in `src/config/variant-meta.ts`.
2. Mirror the same value in `index.html` for `<link rel="canonical">`,
   `og:url` and `twitter:url` — `tests/variant-meta-index-html-drift.test.mts`
   asserts the two sides match, and `vite.config.ts`'s `htmlVariantPlugin`
   rewrites those tags from `VARIANT_META.full` at build time anyway.
3. Check `tests/deploy-config.test.mjs`, which derives an expected host list from
   the `url:` fields in `variant-meta.ts`.

---

## 6. The Ignored Build Step will cancel deploys — on purpose

`scripts/vercel-ignore.sh` skips a build when a commit touches nothing
web-relevant. A commit that only changes `docs/`, `README.md`, or most of
`scripts/` shows up in Vercel as **"Canceled by Ignored Build Step"**. That is
success, not failure.

The web-relevant paths are `src/ api/ server/ shared/ public/ blog-site/
pro-test/ proto/ convex/`, plus `package.json`, `package-lock.json`,
`vite.config.ts`, `tsconfig.json`, `tsconfig.api.json`, `vercel.json`,
`middleware.ts`, `index.html`, `CHANGELOG.md` and a named set of build scripts.

On branches the script compares against `git merge-base HEAD origin/main`, so
your fork's default branch must be `main` for branch previews to evaluate
correctly. To force a build, touch any web-relevant path, or use **Redeploy** in
the dashboard.

---

## 7. Troubleshooting

Read the **Vercel build log** first. Do not reproduce a failing build locally on
a small server — the install alone is ~905 packages and 2.1 GB.

| Symptom in the build log | Cause | Fix |
|---|---|---|
| `Canceled by Ignored Build Step` | No web-relevant files changed | Expected. See §6. |
| `VITE_-prefixed secret variables must not be committed` | A `VITE_` name matches the secret pattern | Rename it without `VITE_` and read it server-side. |
| `sh: 1: tsc: not found` / `vite: not found` | Install ran with `--production` or `--ignore-scripts`, so devDependencies or bin links are missing | Clear the Install Command override; let Vercel run plain `npm install`. |
| Astro/blog step fails with missing modules | `blog-site/` was never installed — the root `postinstall` was skipped | Remove any `--ignore-scripts` from the Install Command. |
| `npm --prefix pro-test ci` fails | `pro-test/package-lock.json` out of sync with its `package.json` | Regenerate that lockfile and commit it. |
| Syntax error inside `node_modules` or on a `node:` import | Node.js Version too old | Raise it in Settings → General. See §2. |
| Deploy succeeds, page is blank, console shows a chunk 404 | Stale build cache | **Redeploy without cache**. |
| API route returns `503 WS_RELAY_URL is not configured` | Relay not deployed or not wired | Expected without a relay. See [`RAILWAY_RELAY_SETUP.md`](RAILWAY_RELAY_SETUP.md). |
| A panel shows a disabled state | Its API key is unset | Expected — check the fallback table in [`REALTIME_ARCHITECTURE.md`](REALTIME_ARCHITECTURE.md). |
| Cross-origin browser call to your API is blocked | `api/_cors.js` and `server/cors.ts` hard-code an allowlist of `*.worldmonitor.app` and upstream's Vercel preview scope | Same-origin use is unaffected. Only relevant for embeds on another domain — see §8. |

---

## 8. Known limitations on a fork

- **CORS allowlist is hard-coded to upstream's domains.** `api/_cors.js` and
  `server/cors.ts` allow `*.worldmonitor.app`, upstream's `-eliewm.vercel.app`
  preview scope, and the Tauri desktop origins. It was deliberately left alone:
  it is a security allowlist, and the dashboard calls its own API *same-origin*,
  which never consults it. If you later want to embed the map on a different
  Bulgar domain, add that origin to both files — and add a specific origin, never
  a bare `*.vercel.app`.
- **Desktop download links** in the README and header point at upstream's
  release artifacts. That is correct: Bulgar does not build Tauri binaries.
- **Variant switcher** links (`tech.` / `finance.` / …) point at upstream's
  subdomains. Your deployment serves the `full` variant only.
- **Cron jobs**: `vercel.json` declares an empty `crons` array. Seed scripts that
  upstream runs on a schedule are not scheduled here; layers that depend on
  seeded data will use whatever the public/live path provides.

---

## 9. Reproducing a deploy

```bash
git checkout main
git pull
# make changes
git checkout -b feat/<something>
git commit -am "..."
git push -u origin feat/<something>     # Vercel builds a Preview deployment
# merge to main                          # Vercel builds Production
```

Every deployment is reproducible from the commit SHA alone: the build takes no
input from any Bulgar machine, only from the repository and the environment
variables configured in the Vercel project.
