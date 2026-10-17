# Performance audit — 2026-09-16/17

Starting point: **HEAD `808262d`** ("Load pastes.js and dashboard.js on demand…"), branch `seadragon`,
clean worktree. Everything below was measured, not estimated; where a number could not be measured it
says so.

## How it was measured

| Tool | What it does |
|---|---|
| `scripts/perf/measure-page.js <url> [--runs N] [--phone] [--phone-cpu]` | cold load in headless Chrome over the DevTools protocol, fresh profile and HTTP cache disabled per run; reports medians of transfer, requests, DOM nodes, running animations, FCP/LCP/CLS, long tasks, TBT, script/style/layout time, the LCP element (`lcpEl`) and the element behind the largest layout shift (`clsEl`) |
| real users (`public/js/ov-rum.js` → `server/web/rum.js`) | every page load (not automated browsers) reports its own TTFB/FCP/LCP/CLS/INP/blocking time and script errors; aggregates per page kind × device class at `GET /api/admin/rum` (staff) and `live_rum_p75` / `live_rum_errors` on `/metrics` |
| `scripts/perf/ab.js <urlA> <urlB> --runs N` | the same, **interleaved** A,B,A,B… so machine load affects both sides equally |
| `scripts/perf/trace-page.js <url> [--tasks]` | Chrome trace; attributes style/layout work to the JavaScript that forced it; `--tasks` lists each main-thread task over 100 ms with what ran inside it |
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

| Change type | Before | After (release layout) |
|---|---|---|
| docs / public only | restart (legacy script restarted on every commit) | no restart; release layout switches `current`, same PID |
| server code | restart | restart, readiness-gated, automatic rollback |
| lockfile | `npm ci` in place; rollback kept new `node_modules` | installed into the new release; rollback returns the old release's `node_modules` |

## Measurement 2026-09-26: after the release-client work (roadmap WS-T task 2)

Shared 1.17 to 1.20 changed `release-watch.js`, which every page loads after first paint. It gained release notifications (one EventSource), session beats every 5 minutes, the `prompted` count and client generations, and stayed under its 5 KB brotli budget (4.94 KB). Production `https://openvibe.live/`, desktop 1366×900 unthrottled, `node scripts/perf/measure-page.js https://openvibe.live/ --runs 3 --settle 8000`, two runs of three, medians:

| Metric | Baseline (above) | 2026-09-26 |
|---|---|---|
| HTML | 381 KB raw / 75.5 KB wire | 92.5 KB raw / 23.6 KB wire |
| Scripts | 44 files, 612 KB wire | 33 files, 438 KB wire |
| Stylesheets | 12 files, 237 KB wire | 11 files, 194 KB wire |
| Requests | 101 | 103–104 (the release-watch stream and its manifest read) |
| DOM nodes | 7 448 | 2 969 |
| Running animations | 53 | 38 |
| FCP / LCP | 1 620 / 5 792 ms | 884–908 / 884–908 ms |
| CLS | 0.086 | 0.073–0.083 |
| TBT | 807 ms | 217–259 ms |
| Style / layout | 589 / 1 085 ms | 595–598 / 554–589 ms |

The release client adds one request (the EventSource, which excludes itself from idle-network checks) and no measurable paint or blocking cost. The size budgets in `npm test` (scripts/perf/check-budgets.js) still pass.

## Measurement 2026-10-12: the first-paint stylesheet

A phone-profile sweep of every OpenVibe home page (4x CPU, ~1.6 Mbit/s) put openvibe.live last: first paint 4.9–5.3 s.
Every route blocked on all of `style.css` (468 KB raw, ~97 KB brotli as served), while CDP rule coverage over the public
routes (home, content, VODs, clips, moments, arena, chat, search, a channel, a VOD, a clip, pastes) at 412 and 1366 px
used 436 of its selectors, 17–18 % of the file.

- `scripts/perf/critical-css.js` writes those selectors to `public/css/critical-selectors.json`; `server/web/critical-css.js`
  builds the subset from the `style.css` on disk (rules naming a listed selector, `:root`/`html`/`body`/`*`, each inside
  its `@media`/`@supports`/`@container`, and only the `@keyframes` they use): 84 KB raw, ~15 KB brotli.
- On those routes the shell links `/css/style.core.css?v=…` (generated, content-hashed, served before the `/css` static
  mount) as the blocking stylesheet, and the full `style.css` right after it with `media="print"` flipped on load, plus a
  `<noscript>` copy. Both sit where `style.css` sat, before the feature stylesheets, so once the full file has arrived the
  cascade is exactly the old one (the subset's rules come earlier and are repeated unchanged). Other routes (dashboard,
  settings, broadcast, admin, …) keep `style.css` blocking.
- A/B on production pages through a local same-origin proxy (brotli, phone profile): first paint home 2.48 → 1.47 s,
  channel 2.51 → 1.46 s, VOD 2.24 → 1.48 s (LCP 3.8 → 1.5 s); LCP and CLS elsewhere unchanged; the settled pages are
  pixel-identical apart from animations and timestamps.
- Re-run `node scripts/perf/critical-css.js` after changing a public page's look: a rule it does not list still arrives
  with the full file, just after the first paint. `test/critical-css.test.js` fails when more than a tenth of the listed
  selectors are no longer in `style.css`.

## Measurement 2026-10-12: layout shift on direct visits

With the first paint earlier, what moved afterwards showed: on a phone a direct visit to a channel scored CLS 1.31, a
clip 0.99, a VOD 0.43 and the home page 0.13 (Chrome's "good" line is 0.1). Each had the same shape: the shell painted
placeholder markup, then the data, and then several parts that load on their own, each pushing the page down.

- **The right page from the start.** The shell marked home active, so a channel visit painted the home page until the
  router swapped. `renderRoute` now moves `active` to the route's own section (`activePage` in `server/web/assets.js`),
  and `app.js` starts `currentPage` from it, so its first `showPage()` is not a change and does not fade the page in again.
- **Channel** (`_channelReady` in `app-channel.js`): until the data (`ch-data`) the header's placeholder words
  ("Channel", "0 followers") are outlines; until the first render and, offline, the "Most watched" block and the discover
  board (`ch-ready`, at most 2.5 s after the data) the tabs are out of the layout and the page keeps a full viewport, so
  the footer never shows and climbs back down.
- **VOD and clip** (`_mediaReady` in `app-media.js`, `mp-data`/`mp-ready`): the same outlines; the AI timeline, the
  activity strip, the source card, the clips and the comments appear together. `.vod-player-container` keeps a 16:9 box
  (`max-height: 70vh`, like the video) before the video knows its size; a taller video still grows it.
- **Home hero:** the countdown line ships as `&nbsp;` instead of `hidden`; the "shipped" line is no longer `hidden`
  (shipped.js collapsed it, then refilled it) and keeps its 33 px while empty; the stats board's reserved heights now
  include the "Show all" button (256 / 204 / 120 px, phone / tablet / wide).
- The cosmetics modal and the messenger panel are built by scripts whose stylesheets load without blocking; until those
  land the shell's inline style keeps them closed and the messenger toggle in its corner.

Same A/B harness (phone profile, worst of two runs): channel 1.31 → 0.012, clip 0.99 → 0.025, VOD 0.43 → 0.004, home
0.127 → 0.011; at 1366 px channel 0.09 → 0.015, VOD 0.19 → 0.001, home 0.06 → 0.01. First paint unchanged.
`test/first-paint-stability.test.js` holds the pieces in place.

## Measurement 2026-10-17: largest paints, the channel page's blocking time, real users

Phone CPU profile (4× CPU, network unthrottled), production, median of 3:

| Page | Before | After | What it was |
|---|---|---|---|
| home: LCP | 2.94 s | 1.15 s | the hero's AI-moment background (`div.hero-bg-layer`) was set by app-home.js after `/api/home/hero`; the server now preloads it and paints it on the first layer (#206) |
| `/@goosely` (offline): TBT | 3.7 s | 1.2 s | chat.js re-rendered the whole scrollback (500 channel + 500 global rows) in one idle callback, 2.7 s; now the newest 50 rows, then 10-row pieces per idle deadline (#207, #209, #210) |
| `/@goosely`: LCP | 3.3 s | 2.45 s | the offline screen's "#1 VOD" picture was lazy and waited for `/popular` after the channel request; now eager, high priority, fetched with the channel (#216) |
| openvibe.video watch page: LCP | 3.8 s | 0.88 s | the `<video>` had no poster, so the largest paint waited for the first frame (MediaHub#94) |

Server side (host, warm): `/api/streams/channel/:username` 120–150 → 95–120 ms (clipper names and AI overviews in one
query each instead of one per row, #213); `/api/vods/:id` and `/api/clips/:id` now run their six lookups in parallel
(23–40 ms, #214). Other OpenVibe sites' homes and inner pages: FCP/LCP 0.5–0.9 s, TBT under 210 ms, no overflow at 320 px.

The throttled-network `--phone` profile still shows the home's first paint at 3.3 s (six render-blocking stylesheets
share the 1.6 Mbps link with ~30 deferred scripts). Real-user data (#217) is the arbiter now: compare
`live_rum_p75{page="home",device="phone"}` before restructuring the stylesheets.

## Budgets

`npm run perf:budget` (scripts/perf/check-budgets.js) fails if the home page's raw HTML, eagerly
loaded JS or render-blocking CSS grow past the limits recorded there.
