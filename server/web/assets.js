'use strict';
/**
 * Content-addressed asset URLs, computed at runtime — no build step, no hand-maintained ?v=N.
 *
 * Every HTML document the server sends has its /js, /css, /shared and /fragments references
 * rewritten to `?v=<first 12 hex of sha256(file)>`. A changed file gets a new URL; an unchanged
 * file keeps its URL (and its warm browser/CDN cache) across deploys.
 *
 * Why a hash and not the old counters: the counters were edited by hand in six HTML files and
 * drifted. popout-chat.html still asked for app.js?v=132 when index.html was on 184, and because a
 * ?v= URL is cached for a year as immutable, a popout could run months-old code.
 *
 * A request is only cached as immutable when its ?v= matches the bytes being served. A mismatch
 * is one of two things:
 *   - a page rendered before a deploy asking for the previous version. When releases live side by
 *     side (/opt/openvibe.live/releases/<id>/public), the old bytes are still on disk and are served
 *     from there, so old HTML never runs new JS. That is what makes a deploy atomic for a browser.
 *   - anything else (a hand-typed URL, a legacy ?v=N). The current file is served with no-cache so
 *     no cache anywhere can pin the wrong bytes under that URL.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Where static files are read from on every request. By default the public/ next to this file. In the
// release layout (deploy/scripts/deploy.sh) the unit sets OV_APP_ROOT=/opt/openvibe.live/current: the
// path goes through the `current` symlink, so a static-only release switch is served by the running
// process without a restart. OV_PUBLIC_DIR overrides it directly (tests).
const PUBLIC_DIR = path.resolve(process.env.OV_PUBLIC_DIR
    || (process.env.OV_APP_ROOT ? path.join(process.env.OV_APP_ROOT, 'public') : path.join(__dirname, '../../public')));
const RECHECK_MS = 2000;
const HASH_LEN = 12;
// Directories whose files are versioned in documents and loadable through the manifest.
const MANIFEST_DIRS = ['js', 'css', 'fragments'];
const REF_RE = /(["'])(\/(?:js|css|shared|fragments)\/[A-Za-z0-9_./-]+?\.(?:js|css|html))(?:\?v=[A-Za-z0-9_.-]*)?\1/g;
const MANIFEST_MARK = '<!--ov:asset-manifest-->';
const ROUTE_CSS_MARK = '<!--ov:route-css-->';
const ROUTE_JS_MARK = '<!--ov:route-js-->';
const FEATURES_PATH = path.join(PUBLIC_DIR, 'features.json');

let sharedDir = null;
let generation = 0;                 // bumps whenever any tracked file's hash changes
const files = new Map();            // urlPath -> { file, mtimeMs, size, hash, checkedAt }
const history = new Map();          // `${root}\0${urlPath}` -> hash (releases are immutable)

function setSharedDir(dir) { sharedDir = dir || null; }

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, HASH_LEN); }

/** Absolute path for a URL path under `root`, or null if it escapes the root. */
function resolveIn(root, urlPath) {
    if (urlPath.startsWith('/shared/')) {
        return root === PUBLIC_DIR && sharedDir ? path.join(sharedDir, path.basename(urlPath)) : null;
    }
    const file = path.resolve(root, '.' + urlPath);
    return file.startsWith(root + path.sep) ? file : null;
}

/**
 * Current content hash of a public URL path, or null when there is no such file.
 * `fresh` skips the 2s recheck window: the immutable decision for a request must be made against the
 * bytes on disk right now, or a request in the moments after a release switch could be told the new
 * bytes belong to the old hash — and Cloudflare would cache that for a year.
 */
function hashOf(urlPath, { fresh = false } = {}) {
    const now = Date.now();
    const entry = files.get(urlPath);
    if (entry && !fresh && now - entry.checkedAt < RECHECK_MS) return entry.hash;
    const file = resolveIn(PUBLIC_DIR, urlPath);
    let st = null;
    try { st = file && fs.statSync(file); } catch { st = null; }
    if (!st || !st.isFile()) {
        if (entry) { files.delete(urlPath); generation++; }
        return null;
    }
    if (entry && entry.mtimeMs === st.mtimeMs && entry.size === st.size) {
        entry.checkedAt = now;
        return entry.hash;
    }
    let hash;
    try { hash = sha(fs.readFileSync(file)); } catch { return entry ? entry.hash : null; }
    if (!entry || entry.hash !== hash) generation++;
    files.set(urlPath, { file, mtimeMs: st.mtimeMs, size: st.size, hash, checkedAt: now });
    return hash;
}

function versioned(urlPath) {
    const h = hashOf(urlPath);
    return h ? `${urlPath}?v=${h}` : urlPath;
}

/**
 * Earlier releases, newest first, when running from a release directory
 * (<base>/releases/<id>/public). Empty for a plain checkout.
 */
let _historyRoots = null, _historyAt = 0;
function historyRoots() {
    const now = Date.now();
    let real;
    try { real = fs.realpathSync(PUBLIC_DIR); } catch { return []; }
    // Recomputed whenever `current` points somewhere new, so the release that was live a moment ago is
    // immediately one of the previous releases.
    if (_historyRoots && _historyRoots.real === real && now - _historyAt < 30000) return _historyRoots;
    _historyAt = now;
    _historyRoots = [];
    _historyRoots.real = real;
    try {
        const releaseDir = path.dirname(real);
        const releasesDir = path.dirname(releaseDir);
        if (path.basename(real) !== 'public' || path.basename(releasesDir) !== 'releases') return _historyRoots;
        _historyRoots = fs.readdirSync(releasesDir)
            .map((name) => path.join(releasesDir, name))
            .filter((dir) => dir !== releaseDir)
            .map((dir) => { try { return { dir, mtime: fs.statSync(dir).mtimeMs }; } catch { return null; } })
            .filter(Boolean)
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 4)
            .map((r) => path.join(r.dir, 'public'));
        _historyRoots.real = real;
    } catch { /* not a release layout */ }
    return _historyRoots;
}

/** The file for `urlPath` whose content hash is `hash` in an earlier release, if one is still on disk. */
function findPrevious(urlPath, hash) {
    if (urlPath.startsWith('/shared/')) return null;
    for (const root of historyRoots()) {
        const file = resolveIn(root, urlPath);
        if (!file) continue;
        const key = `${root}\0${urlPath}`;
        let h = history.get(key);
        if (h === undefined) {
            try { h = sha(fs.readFileSync(file)); } catch { h = null; }
            history.set(key, h);
            if (history.size > 4000) history.delete(history.keys().next().value);
        }
        if (h === hash) return file;
    }
    return null;
}

/** { "/js/app.js": "abc123…", … } for every loadable file. Rebuilt at most every RECHECK_MS. */
let _manifest = null, _manifestAt = 0;
function manifest() {
    const now = Date.now();
    if (_manifest && now - _manifestAt < RECHECK_MS) return _manifest;
    const out = {};
    for (const dir of MANIFEST_DIRS) {
        const walk = (rel) => {
            let entries = [];
            try { entries = fs.readdirSync(path.join(PUBLIC_DIR, rel), { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const childRel = `${rel}/${e.name}`;
                if (e.isDirectory()) walk(childRel);
                else if (/\.(js|css|html)$/.test(e.name)) {
                    const urlPath = '/' + childRel;
                    const h = hashOf(urlPath);
                    if (h) out[urlPath] = h;
                }
            }
        };
        walk(dir);
    }
    _manifest = out;
    _manifestAt = now;
    return out;
}

/** public/features.json — the feature/route registry shared with public/js/ov-loader.js. */
let _features = null, _featuresMtime = 0, _featuresAt = 0;
function features() {
    const now = Date.now();
    if (_features && now - _featuresAt < RECHECK_MS) return _features;
    _featuresAt = now;
    try {
        const st = fs.statSync(FEATURES_PATH);
        if (!_features || st.mtimeMs !== _featuresMtime) {
            const parsed = JSON.parse(fs.readFileSync(FEATURES_PATH, 'utf8'));
            _features = {
                features: parsed.features || {},
                routes: (parsed.routes || []).map((r) => ({ ...r, re: new RegExp(r.path) })),
            };
            _featuresMtime = st.mtimeMs;
            generation++;
        }
    } catch (e) {
        if (!_features) _features = { features: {}, routes: [] };
    }
    return _features;
}

/** Stylesheets that belong right after style.css in the cascade (see public/js/ov-loader.js). */
function isEarlyCss(href) {
    return href.startsWith('/css/features/') || href === '/css/home-fx.css' || href === '/css/home-tour.css';
}

/** Feature names for a URL path, dependencies first, each once. */
function featuresFor(urlPath) {
    const reg = features();
    const out = [];
    const visit = (name) => {
        if (out.includes(name) || !reg.features[name]) return;
        for (const dep of reg.features[name].deps || []) visit(dep);
        out.push(name);
    };
    for (const r of reg.routes) if (r.re.test(urlPath || '/')) r.features.forEach(visit);
    return out;
}

/** The CSS and JS a route needs at first paint, in load order, without duplicates. */
function routeAssets(urlPath) {
    const reg = features();
    const css = [], js = [];
    for (const name of featuresFor(urlPath)) {
        const f = reg.features[name];
        for (const c of f.css || []) if (!css.includes(c)) css.push(c);
        for (const j of f.js || []) if (!js.includes(j)) js.push(j);
    }
    return { features: featuresFor(urlPath), css, js };
}

/** Rewrite asset references in an HTML string and fill the manifest placeholder, if present. */
function rewriteHtml(html) {
    let out = html.replace(REF_RE, (m, q, urlPath) => {
        const h = hashOf(urlPath);
        return h ? `${q}${urlPath}?v=${h}${q}` : m;
    });
    if (out.includes(MANIFEST_MARK)) {
        const reg = features();
        const payload = {
            v: manifest(),
            features: reg.features,
            routes: reg.routes.map(({ path: p, features: f }) => ({ path: p, features: f })),
        };
        const json = JSON.stringify(payload).replace(/</g, '\\u003c');
        out = out.replace(MANIFEST_MARK, `<script type="application/json" id="ov-assets">${json}</script>`);
    }
    return out;
}

/**
 * The SPA shell for a specific URL: the route's stylesheets go in the head (so the first paint is
 * styled) and its scripts after the core scripts (so they have run before the router does). Every
 * other route's code stays out of the document until someone navigates there.
 */
function renderRoute(html, urlPath) {
    if (!html.includes(ROUTE_CSS_MARK) && !html.includes(ROUTE_JS_MARK)) return html;
    const { features: names, css, js } = routeAssets(urlPath);
    const tag = (c) => `<link rel="stylesheet" href="${versioned(c)}" data-ov-feature-asset>`;
    // Split-out rules keep their cascade position (right after style.css); stylesheets that were always
    // separate files keep theirs (after every global stylesheet). js/ov-loader.js applies the same rule.
    const cssTags = css.filter(isEarlyCss).map(tag).join('\n    ');
    const lateTags = css.filter((c) => !isEarlyCss(c)).map(tag).join('\n    ');
    const jsTags = js.map((j) => `<script src="${versioned(j)}" defer data-ov-feature-asset></script>`).join('\n');
    const bootTag = `<script type="application/json" id="ov-route-features">${JSON.stringify(names)}</script>`;
    let out = html.replace(ROUTE_CSS_MARK, cssTags).replace(ROUTE_JS_MARK, `${bootTag}\n${jsTags}`);
    if (lateTags) out = out.replace('</head>', `    ${lateTags}\n</head>`);
    // The route's page markup, inline: a direct visit renders without a second round trip, and
    // crawlers get the same content they did when every page shipped in index.html.
    const reg = features();
    for (const name of names) {
        const frag = reg.features[name] && reg.features[name].fragment;
        if (!frag) continue;
        const body = fragment(frag);
        if (body == null) continue;
        const open = `<!--ov:fragment:${frag}-->`;
        const start = out.indexOf(open);
        const end = start === -1 ? -1 : out.indexOf('<!--/ov:fragment-->', start);
        if (start === -1 || end === -1) continue;
        out = out.slice(0, start) + body + out.slice(end + '<!--/ov:fragment-->'.length);
        out = out.replace(`data-fragment="${frag}">`, `data-fragment="${frag}" data-fragment-loaded="1">`);
    }
    return out;
}

/** A page fragment's HTML (public/fragments/<name>.html), cached until the file changes. */
const _fragments = new Map();
function fragment(name) {
    if (!/^[a-z0-9-]+$/.test(name)) return null;
    const file = path.join(PUBLIC_DIR, 'fragments', `${name}.html`);
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const hit = _fragments.get(name);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.html;
    const html = rewriteHtml(fs.readFileSync(file, 'utf8'));
    _fragments.set(name, { html, mtimeMs: st.mtimeMs });
    return html;
}

/**
 * A rewritten HTML document from public/, cached until the file or any asset hash changes.
 * Returns { html, version } — `version` changes whenever the output could have changed.
 */
const docs = new Map(); // abs path -> { html, mtimeMs, gen, checkedAt, version }
function document(relPath) {
    const file = path.resolve(PUBLIC_DIR, relPath);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new Error('document outside public/');
    const now = Date.now();
    const cached = docs.get(file);
    if (cached && now - cached.checkedAt < RECHECK_MS) return cached;
    let st;
    try { st = fs.statSync(file); } catch { return cached || null; }
    // Touch every referenced hash so `generation` reflects the current files before comparing.
    if (cached && cached.mtimeMs === st.mtimeMs) {
        for (const ref of cached.refs) hashOf(ref);
        manifest();
        if (cached.gen === generation) { cached.checkedAt = now; return cached; }
    }
    const raw = fs.readFileSync(file, 'utf8');
    const refs = new Set();
    raw.replace(REF_RE, (m, q, urlPath) => { refs.add(urlPath); return m; });
    const html = rewriteHtml(raw);
    const entry = { html, mtimeMs: st.mtimeMs, gen: generation, checkedAt: now, refs, version: `${st.mtimeMs}:${generation}` };
    docs.set(file, entry);
    return entry;
}

/**
 * A report-only Content-Security-Policy for a rendered document: inline <script> elements are allowed
 * by the hash of their exact contents instead of 'unsafe-inline'. The enforced policy (helmet in
 * server/index.js) still allows unsafe-inline; this runs alongside it so violations are reported to
 * /api/csp-report before anything is enforced. Inline event handlers (onclick=…) are still allowed
 * here — they are the next thing to remove (docs/security.md#csp).
 */
const _cspCache = new Map();
function cspReportOnly(html) {
    const key = html.length + ':' + crypto.createHash('sha1').update(html.slice(0, 20000)).digest('base64');
    const hit = _cspCache.get(key);
    if (hit) return hit;
    const hashes = new Set();
    const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
        if (/type="application\/(ld\+)?json"/i.test(m[1])) continue;
        hashes.add(`'sha256-${crypto.createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
    }
    const scriptHosts = "cdnjs.cloudflare.com cdn.jsdelivr.net https://openvibe.network https://esm.sh https://static.cloudflareinsights.com";
    const policy = [
        `script-src-elem 'self' ${[...hashes].join(' ')} ${scriptHosts}`,
        "script-src-attr 'unsafe-inline'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self' https://openvibe.network https://www.paypal.com https://checkout.stripe.com",
        "frame-ancestors 'self' https://openvibe.network",
        'report-uri /api/csp-report',
    ].join('; ');
    _cspCache.set(key, policy);
    if (_cspCache.size > 200) _cspCache.delete(_cspCache.keys().next().value);
    return policy;
}

const IMMUTABLE = 'public, max-age=31536000, immutable';
function setImmutable(res) { res.setHeader('Cache-Control', IMMUTABLE); res.setHeader('CDN-Cache-Control', IMMUTABLE); }
function setNoCache(res) { res.setHeader('Cache-Control', 'no-cache'); res.setHeader('CDN-Cache-Control', 'no-store'); }

/**
 * Middleware for a static mount (`app.use('/js', versionedStatic('/js'), express.static(...))`).
 * Decides the cache policy from the hash, and serves an earlier release's bytes when asked for them.
 */
function versionedStatic(mount) {
    return (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const v = typeof req.query.v === 'string' ? req.query.v : '';
        const urlPath = mount + decodeURIComponent(req.path);
        res.locals.ovVersioned = false;
        if (!v) return next();
        const current = hashOf(urlPath, { fresh: true });
        if (current && v === current) { res.locals.ovVersioned = true; return next(); }
        const previous = current !== v ? findPrevious(urlPath, v) : null;
        if (previous) {
            setImmutable(res);
            return res.sendFile(previous, { headers: { 'X-OV-Asset': 'previous-release' } }, (err) => { if (err && !res.headersSent) next(); });
        }
        return next();
    };
}

/** express.static `setHeaders` companion for versionedStatic. */
function staticHeaders(res) {
    if (res.locals && res.locals.ovVersioned) setImmutable(res);
    else setNoCache(res);
}

module.exports = {
    PUBLIC_DIR, MANIFEST_MARK,
    setSharedDir, hashOf, versioned, manifest, rewriteHtml, document, features, featuresFor, routeAssets, renderRoute, fragment, cspReportOnly,
    versionedStatic, staticHeaders, setNoCache, setImmutable,
    _findPrevious: findPrevious,
};
