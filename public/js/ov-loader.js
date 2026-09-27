/* OpenVibe.Live — feature loader and route lifecycle. Features are described in public/features.json
   and loaded by the network's web runtime (/shared/web-runtime.js, openvibe-shared ≥ 1.23.0, which began
   as this file; its README "Web runtime" documents ov.load, ov.route, ov.prefetch, ov.gen/isCurrent,
   ov.scope, ov.nextRoute, ov.diagnostics and ov.leaks). This file configures it for Live and keeps the
   names the rest of the site uses. The server's first response already carries the route's tags. */
(function () {
    'use strict';
    if (window.ov && window.ov.load) return;
    if (!window.OVWebRuntime) { console.error('[ov] /shared/web-runtime.js did not load; routes cannot load their code'); return; }

    var cfg = { v: {}, features: {}, routes: [] };
    try { cfg = JSON.parse(document.getElementById('ov-assets').textContent) || cfg; } catch (e) { /* plain checkout without the server: load unversioned */ }

    var ov = OVWebRuntime.create({
        features: cfg.features || {},
        routes: cfg.routes || [],
        versions: cfg.v || {},
        // Rules split out of style.css go where they used to be in the cascade: right after style.css
        // (above the anchor). Stylesheets that were always separate files go last. server/web/assets.js
        // (isEarlyCss) applies the same rule to the first response.
        styleSlot: function (p) {
            var early = p.indexOf('/css/features/') === 0 || p === '/css/home-fx.css' || p === '/css/home-tour.css';
            return early ? document.querySelector('meta[name="ov-css-anchor"]') : null;
        },
        onStubError: function () {
            if (typeof window.toast === 'function') window.toast('That part of the site could not load. Check your connection and try again.', 'error');
        },
        routeError: { icon: 'fa-solid fa-plug-circle-xmark' },
    });
    window.ov = ov;
    // Compatibility with the inline loader this replaced (ovLoadRoute('broadcast') etc.).
    window.ovLoadRoute = ov.load;
    window.ovPrefetchRoutes = function () { /* replaced by intent + idle prefetch */ };

    ov.installStubs();
    var initial = [];
    try { initial = JSON.parse((document.getElementById('ov-route-features') || {}).textContent || '[]'); } catch (e) { /* */ }
    ov.boot({ initial: initial });
    // A guided journey can be resumed from any page.
    try {
        if (/[?&]guide=/.test(location.search) || localStorage.getItem('ovg:pending')) ov.load('guide').catch(function () { /* in ov.diagnostics() */ });
    } catch (e) { /* storage unavailable */ }
})();
