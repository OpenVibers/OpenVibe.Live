# Performance audit — 2026-09-16/17

Starting point: **HEAD `808262d`** ("Load pastes.js and dashboard.js on demand…"), branch `seadragon`,
clean worktree. Everything below was measured, not estimated; where a number could not be measured it
says so.

## How it was measured

| Tool | What it does |
|---|---|
| `scripts/perf/measure-page.js <url> [--runs N] [--phone] [--phone-cpu]` | cold load in headless Chrome over the DevTools protocol, fresh profile and HTTP cache disabled per run; reports medians of transfer, requests, DOM nodes, running animations, FCP/LCP/CLS, long tasks, TBT, script/style/layout time |
| `scripts/perf/ab.js <urlA> <urlB> --runs N` | the same, **interleaved** A,B,A,B… so machine load affects both sides equally |
| `scripts/perf/trace-page.js <url>` | Chrome trace; attributes style/layout work to the JavaScript that forced it |
| `test/browser/smoke.js` | routes × widths, errors, overflow, navigation, duplicate scripts, resource growth over repeated navigation |

Profiles: **desktop** 1366×900 unthrottled; **phone** 412×900, 4× CPU, 1.6 Mbps/150 ms;
**phone-cpu** 412×900, 4× CPU, network unthrottled.

Caveats that matter:
- Production numbers go through Cloudflare (Brotli). The local A/B runs against a local Node server
  that does **not** compress, so local transfer sizes are raw bytes; use the relative change.
- Local A/B used the old build (`808262d`, port 4189, a detached worktree) and the new build (port 4188)
  on the same machine and data; the machine is a shared workstation, so main-thread timings are noisy.
  Only differences that held across repeated runs are claimed.
- Headless Chrome composites in software; frame rates are not reported.
- The new build has **not** been deployed, so there are no production "after" numbers yet.

## Baseline — production, `https://openvibe.live/`, 3 cold runs (median)

| Metric | Desktop | Phone (4× CPU, 1.6 Mbps) |
|---|---|---|
| HTML | 381 KB raw / 75.5 KB wire | same |
| Scripts | 44 files, 1 993 KB raw / 612 KB wire | 49 files, 2 677 KB raw / 784 KB wire (idle prefetch ran) |
| Stylesheets | 12 files, 1 029 KB raw / 237 KB wire | same |
| Requests | 101 | 91 |
| DOM nodes | 7 448 | 7 160 |
| Running animations | 53 | 20 |
| FCP | 1 620 ms | 6 344 ms |
| LCP | 5 792 ms | 9 808 ms |
| CLS | 0.086 | 0.133 |
| TBT | 807 ms | 2 589 ms |
| Style / layout | 589 / 1 085 ms | 1 807 / 2 012 ms |

## Results — local A/B, home page, old build vs new build

### Desktop, 7 interleaved runs each

| Metric | Before | After | Change |
|---|---|---|---|
| HTML (raw) | 374.8 KB | 94.9 KB | −74.7% |
| Script files | 43 | 23 | −46.5% |
| Script bytes (raw) | 1 965 KB | 1 000 KB | −49.1% |
| CSS bytes (raw) | 1 029 KB | 824 KB | −19.9% |
| Requests | 77 | 55 | −28.6% |
| Total transfer | 3 743 KB | 2 252 KB | −39.8% |
| DOM nodes | 6 402 | 1 741 | −72.8% |
| LCP | 5 644 ms | 2 552 ms | −54.8% |
| FCP | 2 668 ms | 2 552 ms | −4.3% (noise range) |
| Script time | 428 ms | 338 ms | −21.0% |
| Layout time | 1 659 ms | 1 487 ms | −10.4% |
| CLS | 0.062 | 0.064 | unchanged |

### Phone CPU profile, 9 interleaved runs each (final build, self-hosted icons)

| Metric | Before | After | Change |
|---|---|---|---|
| HTML (raw) | 374.8 KB | 94.7 KB | −74.7% |
| Script bytes (raw) | 1 965 KB | 1 000 KB | −49.1% |
| CSS bytes (raw) | 1 029 KB | 824 KB | −19.9% |
| Total transfer | 3 743 KB | 2 347 KB | −37.3% |
| DOM nodes | 6 342 | 1 732 | −72.7% |
| Running animations | 30 | 21 | −30.0% |
| FCP | 3 260 ms | 2 792 ms | −14.4% |
| LCP | 3 412 ms | 3 024 ms | −11.4% |
| TBT | 4 565 ms | 3 846 ms | −15.8% |
| Script time | 618 ms | 336 ms | −45.6% |
| Style time | 2 061 ms | 1 858 ms | −9.8% |
| Layout time | 2 717 ms | 2 667 ms | unchanged |

What did **not** improve: layout on the home page is dominated by the page's own content
(hero, collage, rails) and stayed flat; long-task totals are within noise.

## What changed, and why it moved these numbers

| Change | Effect |
|---|---|
| Route markup moved to `public/fragments/*.html`, inlined by the server only for the route requested | index.html 382 KB → 81 KB source; DOM nodes −73% |
| `public/features.json` + `js/ov-loader.js`: 28 route scripts load with their route (and are prefetched on link hover/focus, download-only) | home scripts 44 → 23 files |
| `app.js` split by reachability analysis into core (128 KB) + `app-home`, `app-channel`, `app-media`, `app-chatpage`, `app-docs` | 539 KB → 128 KB always-loaded |
| Stylesheet split by class ownership with cascade-order checks (computed styles diffed on 44 route states: only data-driven differences remain) | style.css 666 KB → 484 KB; broadcast.css 100 KB → 51 KB; 8 feature files |
| A stray `}` in style.css made browsers drop the whole `@media (max-width:1200px)` block | fixed: nav links no longer overflow at 1100 px (79 px → 0) |
| Forced synchronous layouts found with `trace-page.js`: `ov-density` measured inside render (≈0.5 s at 4× CPU), odometer reflow per digit, tour diagram wired below the fold, `innerWidth` reads during load | measured in ResizeObserver, batched, wired on visibility, `matchMedia` |
| Hero quip and first rotating word shipped in the HTML | LCP element paints at first render instead of after `/api/home/hero` |
| Font Awesome self-hosted (woff2 only, content-hashed URLs) | no third-party connection on the critical path |
| Dead `theme-engine.js` (parser-blocking) removed | one fewer blocking script |

## Server

| Metric | Before | After | How measured |
|---|---|---|---|
| Graceful shutdown (SIGTERM → exit) | forced exit after ~5.3 s with code 1 (SSE clients kept `server.close()` open; per audit) | 1.1 s, exit 0 | local, `kill` + timing |
| Local boot to `/api/ready` | ~2.5 s | ~2–3 s | restart script (unchanged within noise) |
| Event-loop delay | not observable | p50/p99/max per minute at `GET /api/admin/diagnostics`, logged when p99 ≥ 200 ms | server/diagnostics.js |
| Static response for style.css (8 concurrent, Node) | 67 ms median | cached in nginx after first fetch (X-Cache HIT verified with nginx 1.27) | local bench + docker nginx |

## Deploy

| Change type | Before | After (verified in `test/deploy-sim.test.js`) |
|---|---|---|
| docs / public only | restart (legacy script restarted on every commit) | no restart; release layout switches `current`, same PID |
| server code | restart | restart, readiness-gated, automatic rollback |
| lockfile | `npm ci` in place; rollback kept new `node_modules` | installed into the new release; rollback returns the old release's `node_modules` |

## Budgets

`npm run perf:budget` (scripts/perf/check-budgets.js) fails if the home page's raw HTML, eagerly
loaded JS or render-blocking CSS grow past the limits recorded there.
