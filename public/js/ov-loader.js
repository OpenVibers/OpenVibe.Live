/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — feature loader and route lifecycle
   ═══════════════════════════════════════════════════════════════

   The site used to ship every route's code to every page: 40+ scripts parsed on the home page for a
   broadcast desk, a dashboard, voice calls and a player nobody on the home page is using. Features
   are now described once, in public/features.json, and this file loads them when they are needed:

     ov.load('broadcast')          → its markup fragment, stylesheets, dependencies, scripts (in
                                      order), then its `after` hook. Deduplicated and cached; a
                                      failed load can be retried.
     ov.route(path)                → everything the route needs, as one promise.
     ov.prefetch('channel')        → download only (link rel=prefetch), never execute; skipped on
                                      Save-Data and slow connections.
     ov.gen() / ov.isCurrent(gen)  → a route generation, so a loader that awaited something can tell
                                      whether the visitor has already moved on.
     ov.scope()                    → timers, listeners, observers and an AbortSignal owned by the
                                      current route, released by teardownRoute().

   The server puts the requested route's stylesheets and scripts into the first HTML response, so a
   direct visit does not wait for this loader; those tags are recognised and not loaded twice.
   Global function stubs (from the registry) keep inline onclick handlers working before a feature
   has loaded: the stub loads the feature and then calls the real function, which replaces it.
*/
(function () {
    'use strict';
    if (window.ov && window.ov.load) return;

    var cfg = { v: {}, features: {}, routes: [] };
    try { cfg = JSON.parse(document.getElementById('ov-assets').textContent) || cfg; } catch (e) { /* plain checkout without the server: load unversioned */ }
    var FEATURES = cfg.features || {};
    var ROUTES = (cfg.routes || []).map(function (r) { return { re: new RegExp(r.path), features: r.features }; });

    function url(p) { var h = cfg.v && cfg.v[p]; return h ? p + '?v=' + h : p; }
    function bare(src) { try { return new URL(src, location.href).pathname; } catch (e) { return String(src).split('?')[0]; } }

    // ── Scripts and styles, once each ────────────────────────────────────────────────────────
    var scripts = Object.create(null);
    var styles = Object.create(null);

    // Tags the server already put in the document count as loaded (or loading).
    function adoptExisting() {
        var tags = document.querySelectorAll('script[src]');
        for (var i = 0; i < tags.length; i++) {
            var p = bare(tags[i].src);
            if (!scripts[p]) scripts[p] = tagPromise(tags[i], true);
        }
        var links = document.querySelectorAll('link[rel="stylesheet"][href]');
        for (var j = 0; j < links.length; j++) {
            var q = bare(links[j].href);
            if (!styles[q]) styles[q] = links[j].sheet ? Promise.resolve() : tagPromise(links[j], false);
        }
    }
    function tagPromise(el, isScript) {
        // A deferred script that has executed fired `load` long ago; after DOMContentLoaded every
        // parser-inserted script has run.
        if (isScript && document.readyState !== 'loading' && !el.dataset.ovInjected) return Promise.resolve();
        return new Promise(function (resolve) {
            el.addEventListener('load', function () { resolve(); }, { once: true });
            el.addEventListener('error', function () { resolve(); }, { once: true });
            if (isScript && document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { resolve(); }, { once: true });
        });
    }

    function loadScript(p) {
        if (scripts[p]) return scripts[p];
        var s = document.createElement('script');
        s.src = url(p);
        s.async = false;                    // injected together → execute in insertion order
        s.dataset.ovInjected = '1';
        scripts[p] = new Promise(function (resolve, reject) {
            s.onload = function () { resolve(); };
            s.onerror = function () {
                delete scripts[p];          // allow a retry
                s.remove();
                reject(new Error('Could not load ' + p));
            };
        });
        document.head.appendChild(s);
        return scripts[p];
    }

    function loadStyle(p) {
        if (styles[p]) return styles[p];
        var l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = url(p);
        styles[p] = new Promise(function (resolve) {
            // A missing stylesheet must not block a route; wait at most 4s for it.
            var done = false;
            var finish = function () { if (!done) { done = true; resolve(); } };
            l.onload = finish;
            l.onerror = function () { delete styles[p]; finish(); };
            setTimeout(finish, 4000);
        });
        // Rules split out of style.css go where they used to be in the cascade: right after style.css
        // (above the anchor). Stylesheets that were always separate files go last, as before.
        var anchor = document.querySelector('meta[name="ov-css-anchor"]');
        var early = p.indexOf('/css/features/') === 0 || p === '/css/home-fx.css' || p === '/css/home-tour.css';
        if (early && anchor) anchor.parentNode.insertBefore(l, anchor);
        else document.head.appendChild(l);
        return styles[p];
    }

    // ── Markup fragments ─────────────────────────────────────────────────────────────────────
    var fragments = Object.create(null);
    function loadFragment(name, sectionId) {
        var section = document.getElementById(sectionId);
        if (!section) return Promise.resolve();
        if (section.dataset.fragmentLoaded === '1') return Promise.resolve();
        if (fragments[name]) return fragments[name];
        section.setAttribute('aria-busy', 'true');
        fragments[name] = fetch(url('/fragments/' + name + '.html'), { credentials: 'same-origin' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
            .then(function (html) {
                // Inserted once, never replaced: live players, previews and call tiles bind to these
                // exact nodes and must survive leaving and re-entering the route.
                if (section.dataset.fragmentLoaded !== '1') {
                    section.innerHTML = html;
                    section.dataset.fragmentLoaded = '1';
                    section.dispatchEvent(new CustomEvent('ov:fragment', { bubbles: true, detail: { name: name } }));
                }
                section.removeAttribute('aria-busy');
            })
            .catch(function (err) {
                delete fragments[name];
                section.removeAttribute('aria-busy');
                throw err;
            });
        return fragments[name];
    }

    // ── Features ─────────────────────────────────────────────────────────────────────────────
    var features = Object.create(null);
    var afterRan = Object.create(null);

    function load(name) {
        var f = FEATURES[name];
        if (!f) return Promise.resolve();
        if (features[name]) return features[name];
        // The feature's own markup goes in first — before its dependencies and scripts run — because
        // several modules bind to their markup when they load (chat inputs and resize handles, the
        // voice channel list, ~30 broadcast settings inputs).
        var markup = f.fragment ? loadFragment(f.fragment, f.section || ('page-' + f.fragment)) : Promise.resolve();
        features[name] = markup
            .then(function () { return Promise.all((f.deps || []).map(load)); })
            .then(function () {
                return Promise.all((f.css || []).map(loadStyle).concat((f.js || []).map(loadScript)));
            })
            .then(function () {
                if (f.after && !afterRan[name] && typeof window[f.after] === 'function') {
                    afterRan[name] = true;
                    try { window[f.after](); } catch (e) { console.error('[ov] ' + name + ' after-hook failed:', e); }
                }
                document.dispatchEvent(new CustomEvent('ov:feature', { detail: { name: name } }));
            })
            .catch(function (err) {
                delete features[name];
                throw err;
            });
        return features[name];
    }

    function featuresFor(path) {
        var out = [];
        ROUTES.forEach(function (r) { if (r.re.test(path)) r.features.forEach(function (n) { if (out.indexOf(n) === -1) out.push(n); }); });
        return out;
    }

    function route(path) {
        return Promise.all(featuresFor(path || location.pathname).map(load));
    }

    // ── Prefetch (download, never execute) ───────────────────────────────────────────────────
    var prefetched = Object.create(null);
    function constrained() {
        var c = navigator.connection;
        if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return true;
        return typeof navigator.deviceMemory === 'number' && navigator.deviceMemory < 2;
    }
    function prefetchAsset(p) {
        if (prefetched[p] || scripts[p] || styles[p]) return;
        prefetched[p] = true;
        var l = document.createElement('link');
        l.rel = 'prefetch';
        l.href = url(p);
        l.as = /\.css$/.test(p) ? 'style' : /\.js$/.test(p) ? 'script' : 'fetch';
        document.head.appendChild(l);
    }
    function prefetch(name, seen) {
        seen = seen || {};
        var f = FEATURES[name];
        if (!f || seen[name] || features[name] || constrained()) return;
        seen[name] = true;
        (f.deps || []).forEach(function (d) { prefetch(d, seen); });
        (f.css || []).concat(f.js || []).forEach(prefetchAsset);
        if (f.fragment) prefetchAsset('/fragments/' + f.fragment + '.html');
    }
    function prefetchRoute(path) { featuresFor(path).forEach(function (n) { prefetch(n); }); }

    // Hover or keyboard focus on an in-site link is a strong signal: fetch that route's code.
    function onIntent(e) {
        var a = e.target && e.target.closest && e.target.closest('a[href^="/"]');
        if (!a) return;
        var path = a.getAttribute('href').split(/[?#]/)[0];
        if (path) prefetchRoute(path);
    }

    // ── Route generations and scopes ─────────────────────────────────────────────────────────
    var generation = 0;
    var currentScope = null;

    function makeScope(gen) {
        var disposers = [];
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var scope = {
            gen: gen,
            signal: controller ? controller.signal : undefined,
            interval: function (fn, ms) { var id = setInterval(fn, ms); disposers.push(function () { clearInterval(id); }); return id; },
            timeout: function (fn, ms) { var id = setTimeout(fn, ms); disposers.push(function () { clearTimeout(id); }); return id; },
            listen: function (target, type, fn, opts) {
                if (!target) return;
                target.addEventListener(type, fn, opts);
                disposers.push(function () { target.removeEventListener(type, fn, opts); });
            },
            observe: function (observer) { disposers.push(function () { try { observer.disconnect(); } catch (e) { /* */ } }); return observer; },
            onDispose: function (fn) { disposers.push(fn); },
            get disposed() { return !!scope._disposed; },
        };
        scope.dispose = function () {
            if (scope._disposed) return;
            scope._disposed = true;
            if (controller) try { controller.abort(); } catch (e) { /* */ }
            while (disposers.length) { try { disposers.pop()(); } catch (e) { console.warn('[ov] scope cleanup failed:', e); } }
        };
        return scope;
    }

    /** Called by teardownRoute(): everything the previous route owned is released. */
    function nextRoute() {
        generation++;
        if (currentScope) currentScope.dispose();
        currentScope = makeScope(generation);
        return generation;
    }

    // ── Stubs for inline handlers ────────────────────────────────────────────────────────────
    function installStubs() {
        Object.keys(FEATURES).forEach(function (name) {
            (FEATURES[name].stubs || []).forEach(function (fn) {
                if (typeof window[fn] === 'function') return;
                var stub = function () {
                    var args = arguments, self = this;
                    return load(name).then(function () {
                        if (window[fn] !== stub && typeof window[fn] === 'function') return window[fn].apply(self, args);
                        console.warn('[ov] ' + fn + ' is unavailable after loading ' + name);
                    }, function (err) {
                        console.error('[ov]', err);
                        if (typeof window.toast === 'function') window.toast('That part of the site could not load. Check your connection and try again.', 'error');
                    });
                };
                stub.__ovStub = name;
                window[fn] = stub;
            });
        });
    }

    // ── Recoverable failure UI for a route ───────────────────────────────────────────────────
    function showRouteError(pageId, err, retry) {
        var page = document.getElementById(pageId);
        if (!page) return;
        var box = page.querySelector(':scope > .ov-route-error');
        if (!box) {
            box = document.createElement('div');
            box.className = 'ov-route-error';
            box.setAttribute('role', 'alert');
            page.insertBefore(box, page.firstChild);
        }
        box.innerHTML = '<i class="fa-solid fa-plug-circle-xmark" aria-hidden="true"></i>'
            + '<div><strong>This page could not load.</strong><span>Check your connection, then try again.</span></div>'
            + '<button type="button" class="btn btn-primary">Try again</button>';
        box.querySelector('button').addEventListener('click', function () { box.remove(); retry(); }, { once: true });
        console.error('[ov] route failed to load:', err);
    }

    window.ov = {
        load: load,
        route: route,
        featuresFor: featuresFor,
        prefetch: prefetch,
        prefetchRoute: prefetchRoute,
        loadScript: loadScript,
        loadStyle: loadStyle,
        url: url,
        gen: function () { return generation; },
        isCurrent: function (gen) { return gen === generation; },
        scope: function () { if (!currentScope) currentScope = makeScope(generation); return currentScope; },
        nextRoute: nextRoute,
        showRouteError: showRouteError,
        isLoaded: function (name) { return !!features[name]; },
    };
    // Compatibility with the inline loader this replaces (ovLoadRoute('broadcast') etc.).
    window.ovLoadRoute = load;
    window.ovPrefetchRoutes = function () { /* replaced by intent + idle prefetch */ };

    installStubs();
    function boot() {
        adoptExisting();
        // Features the server included for this URL are loaded already; record them.
        try {
            var initial = JSON.parse((document.getElementById('ov-route-features') || {}).textContent || '[]');
            initial.forEach(function (n) { load(n); });
        } catch (e) { /* */ }
        document.addEventListener('pointerover', onIntent, { passive: true });
        document.addEventListener('focusin', onIntent);
        document.addEventListener('touchstart', onIntent, { passive: true });
        // A guided journey can be resumed from any page.
        try {
            if (/[?&]guide=/.test(location.search) || localStorage.getItem('ovg:pending')) load('guide');
        } catch (e) { /* storage unavailable */ }
        // Likely next steps from this route, after the page has settled.
        var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 3000); };
        window.addEventListener('load', function () {
            setTimeout(function () {
                idle(function () {
                    featuresFor(location.pathname).forEach(function (n) {
                        (FEATURES[n].idle || []).forEach(function (m) { prefetch(m); });
                    });
                }, { timeout: 15000 });
            }, 4000);
        }, { once: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
