/**
 * home-tour.js — "One stream. Everywhere." — the restream pipeline on the home page.
 *
 * Three columns: what you send (cam / robot / OBS) → the OpenVibe.Live core → where it goes
 * (Twitch, YouTube, Kick, RobotStreamer, any RTMP). The wires are an SVG drawn between the real
 * DOM nodes after layout (so it is exact at every width, and re-flows to a vertical stack on
 * phones), and packets travel along them with SVG <animateMotion> — brand-coloured per
 * destination, staggered, transform-only. Hovering a destination lights up its wire.
 * Static content, no API. Mounted into #home-tour-mount under the hero buttons.
 */
(function () {
    'use strict';
    // Every way in. The pairs are real ingest paths (server/streaming/*): WebRTC from the browser,
    // RTMP and WHIP from encoders, the JSMPEG relay for scripts and small boards.
    const SRC = [
        { id: 'cam', icon: 'fa-solid fa-video', label: 'Your cam', sub: 'browser · phone · WebRTC' },
        { id: 'screen', icon: 'fa-solid fa-display', label: 'Your screen', sub: 'share from the browser' },
        { id: 'obs', icon: 'fa-solid fa-sliders', label: 'OBS · Streamlabs', sub: 'RTMP or WHIP' },
        { id: 'ffmpeg', icon: 'fa-solid fa-terminal', label: 'ffmpeg · scripts', sub: 'RTMP · WHIP · JSMPEG' },
        { id: 'robot', icon: 'fa-solid fa-robot', label: 'Your robot · Pi', sub: 'viewer-controlled' },
        { id: 'encoder', icon: 'fa-solid fa-microchip', label: 'Any encoder', sub: 'hardware · Larix · drones' },
    ];
    const DST = [
        { id: 'twitch', icon: 'fa-brands fa-twitch', label: 'Twitch', color: '#a970ff' },
        { id: 'youtube', icon: 'fa-brands fa-youtube', label: 'YouTube', color: '#ff4b4b' },
        { id: 'kick', icon: 'fa-solid fa-bolt', label: 'Kick', color: '#53fc18' },
        { id: 'rs', icon: 'fa-solid fa-robot', label: 'RobotStreamer', color: '#7dd3fc' },
        { id: 'rtmp', icon: 'fa-solid fa-tower-broadcast', label: 'Any RTMP', color: '#e5e7eb' },
    ];
    const FEATURES = [
        ['fa-gauge-high', 'Sub-second WebRTC'], ['fa-face-grin-squint-tears', '7TV / BTTV / FFZ emotes'], ['fa-volume-high', 'Sound commands'],
        ['fa-gamepad', 'Robot & hardware controls'], ['fa-satellite-dish', 'Free restream, all at once'], ['fa-scissors', 'VODs, clips, AI moments'],
        ['fa-comments', 'One chat from every platform'], ['fa-language', 'Auto-translated chat'], ['fa-microphone-lines', 'The Arena: mic-judged beefs'],
        ['fa-clipboard-list', 'After-show reports'], ['fa-brands fa-github', '100% open source'],
    ];

    // Starts false: the IntersectionObserver reports visibility on its first callback, and nothing is
    // measured or animated before then.
    let _tourVisible = false;

    function mount() {
        const el = document.getElementById('home-tour-mount');
        if (!el || el.dataset.mounted) return;
        el.dataset.mounted = '1';
        el.innerHTML = `
            <section class="tour" aria-label="Stream from OpenVibe.Live and restream everywhere">
                <div class="tour-head">
                    <!-- The "RESTREAM" eyebrow that used to sit here restated the heading directly
                         below it and the diagram directly below that. Three statements of one idea. -->
                    <h2>One stream. Everywhere.</h2>
                    <p>Go live here once and mirror it to every platform at the same time — your chat, emotes, sound commands, robot controls, VODs and clips stay in one place.</p>
                </div>
                <div class="tour-stage" id="tour-stage">
                    <svg class="tour-wires" id="tour-wires" aria-hidden="true"></svg>
                    <div class="tour-col tour-col--src">
                        <div class="tour-col-label">You send</div>
                        ${SRC.map(s => `<div class="tour-node tour-node--src" data-node="${s.id}"><span class="tour-node-ico"><i class="${s.icon}"></i></span><span class="tour-node-text"><b>${s.label}</b><small>${s.sub}</small></span></div>`).join('')}
                    </div>
                    <div class="tour-core-wrap">
                        <div class="tour-core" data-node="core">
                            <span class="tour-core-ring"></span><span class="tour-core-ring tour-core-ring--2"></span>
                            <span class="tour-core-logo"><span class="ov-mark" data-size="30" style="color:#fff"></span></span>
                            <b>OpenVibe.Live</b>
                            <!-- The old feature line here ("<1s latency · chat · emotes · …") listed the same
                                 things the chip grid below spells out properly. Two statements of the same
                                 list, one of them abbreviated, is worse than one. The hub just names itself. -->
                        </div>
                    </div>
                    <div class="tour-col tour-col--dst">
                        <div class="tour-col-label">It lands on</div>
                        ${DST.map(d => `<div class="tour-node tour-node--dst" data-node="${d.id}" style="--c:${d.color}"><span class="tour-node-ico"><i class="${d.icon}"></i></span><span class="tour-node-text"><b>${d.label}</b></span><span class="tour-node-dot"></span></div>`).join('')}
                    </div>
                </div>
                <div class="tour-features">${FEATURES.map(([i, t], k) => `<span class="tour-feat" style="--i:${k}"><i class="${i.startsWith('fa-brands') ? i : 'fa-solid ' + i}"></i> ${t}</span>`).join('')}</div>
                <!-- A "Go live" button used to sit here, directly above the quest slot, which is
                     itself a go-live button that knows where the reader actually is in their setup.
                     Two buttons, one of them uninformed. The slot below is the only one now. -->
                <!-- Filled by setupNextUp() in guides-live.js: the progress quest for signed-in
                     streamers, the join panel for everyone else. The link below is the no-JS
                     fallback and what a crawler sees. -->
                <div class="tour-quest-slot" id="tour-next-up" data-fx-viewport>
                    <a class="btn btn-outline btn-lg" href="/broadcast?guide=golive:restream" onclick="event.preventDefault(); if (typeof startRestreamGuide === 'function') startRestreamGuide();"><i class="fa-solid fa-satellite-dish"></i> Set up restreams (guided)</a>
                </div>
            </section>`;
        // Wiring measures the diagram's layout, so it waits until the diagram is near the viewport: it
        // sits well below the fold, and measuring it during page load forced a full synchronous
        // layout (~165ms on a 4x-throttled phone profile) for something nobody could see yet.
        // Signed-in streamers get a context-aware button: the next thing they haven't set up.
        const nextUp = () => { if (typeof setupNextUp === 'function') setupNextUp(document.getElementById('tour-next-up')); };
        setTimeout(nextUp, 900); setTimeout(nextUp, 3500);
        let raf = 0, dirty = true;
        const redraw = () => {
            dirty = true;
            if (!_tourVisible) return;          // drawn when it scrolls into view
            cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { dirty = false; wire(); });
        };
        if ('ResizeObserver' in window) new ResizeObserver(redraw).observe(el.querySelector('#tour-stage'));
        window.addEventListener('resize', redraw);
        document.fonts && document.fonts.ready && document.fonts.ready.then(redraw);
        // The packets are SMIL <animateMotion>, which the section's off-screen CSS pause cannot
        // reach — fourteen of them kept moving for the whole visit, visible or not. Drive the SVG's
        // own clock from the viewport instead.
        if ('IntersectionObserver' in window) {
            new IntersectionObserver((entries) => {
                for (const en of entries) {
                    _tourVisible = en.isIntersecting;
                    if (_tourVisible && dirty) redraw();
                    const svg = document.getElementById('tour-wires');
                    try { if (svg) (_tourVisible ? svg.unpauseAnimations() : svg.pauseAnimations()); } catch { /* */ }
                }
            }, { rootMargin: '300px 0px' }).observe(el.querySelector('#tour-stage'));
        } else {
            _tourVisible = true;
            redraw();
        }
        el.querySelectorAll('.tour-node--dst').forEach(nd => {
            nd.addEventListener('pointerenter', () => el.querySelector('#tour-wires').classList.add(`hot-${nd.dataset.node}`));
            nd.addEventListener('pointerleave', () => el.querySelector('#tour-wires').classList.remove(`hot-${nd.dataset.node}`));
        });
    }

    /** Draw the wires between the real nodes and start the packets. */
    function wire() {
        const stage = document.getElementById('tour-stage'), svg = document.getElementById('tour-wires');
        if (!stage || !svg) return;
        const R = stage.getBoundingClientRect();
        if (!R.width || !R.height) return;
        svg.setAttribute('viewBox', `0 0 ${R.width} ${R.height}`);
        svg.setAttribute('width', R.width); svg.setAttribute('height', R.height);
        const vertical = getComputedStyle(stage).getPropertyValue('--tour-vertical').trim() === '1';
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('rs-lite');
        const logo = stage.querySelector('.tour-core-logo') || stage.querySelector('[data-node="core"]');
        if (!logo) return;

        // Anchor on the visible mark, not on .tour-core. The core element is a 320px-wide column
        // holding the mark and the wordmark; wiring to its edges left every line ending ~130px
        // short of the logo, in empty space. Each wire now lands on a ring just outside the disc,
        // at the point facing the node it comes from, so the lines visibly plug into OpenVibe.
        const L = rel(logo.getBoundingClientRect(), R);
        const hub = { x: L.x + L.w / 2, y: L.y + L.h / 2 };
        const ringR = L.w / 2 + 7;
        const onRing = (p, extra = 0) => {
            const dx = p.x - hub.x, dy = p.y - hub.y, len = Math.hypot(dx, dy) || 1;
            return { x: hub.x + (dx / len) * (ringR + extra), y: hub.y + (dy / len) * (ringR + extra) };
        };
        const anchorOf = (node, side) => {
            const b = rel(node.getBoundingClientRect(), R);
            if (vertical) return { x: b.x + b.w / 2, y: side === 'out' ? b.y + b.h : b.y };
            return { x: side === 'out' ? b.x + b.w : b.x, y: b.y + b.h / 2 };
        };
        // The first control point leaves the node straight out of its edge; the second approaches
        // the hub along the radius, so every wire arrives at the ring head-on instead of sideways.
        const curve = (from, to) => {
            const lead = Math.max(40, Math.hypot(to.x - from.x, to.y - from.y) * 0.42);
            const c1 = vertical ? { x: from.x, y: from.y + Math.sign(to.y - from.y) * lead }
                                : { x: from.x + Math.sign(to.x - from.x) * lead, y: from.y };
            const c2 = onRing(from, lead);
            return `M${from.x.toFixed(1)},${from.y.toFixed(1)} C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
        };
        const curveOut = (to) => {
            // Mirror of the inbound shape: leave the ring along the radius, arrive at the node's edge.
            const from = onRing(to);
            const lead = Math.max(40, Math.hypot(to.x - from.x, to.y - from.y) * 0.42);
            const c1 = onRing(to, lead);
            const c2 = vertical ? { x: to.x, y: to.y - Math.sign(to.y - from.y) * lead } : { x: to.x - Math.sign(to.x - from.x) * lead, y: to.y };
            return { d: `M${from.x.toFixed(1)},${from.y.toFixed(1)} C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`, port: from };
        };

        let paths = '', packets = '', ports = '';
        const srcNodes = [...stage.querySelectorAll('.tour-node--src')], dstNodes = [...stage.querySelectorAll('.tour-node--dst')];
        srcNodes.forEach((nd, i) => {
            const a = anchorOf(nd, 'out');
            const end = onRing(a);
            paths += `<path id="tw-in-${i}" class="tour-wire tour-wire--in" d="${curve(a, end)}"/>`;
            ports += `<circle class="tour-port tour-port--in" cx="${end.x.toFixed(1)}" cy="${end.y.toFixed(1)}" r="2.6"/>`;
            if (!reduce) packets += `<circle class="tour-pk tour-pk--in" r="3.5"><animateMotion dur="${(1.6 + i * 0.2).toFixed(2)}s" begin="${(i * 0.55).toFixed(2)}s" repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.6 1"><mpath href="#tw-in-${i}"/></animateMotion></circle>`;
        });
        dstNodes.forEach((nd, i) => {
            const b = anchorOf(nd, 'in');
            const { d, port } = curveOut(b);
            const col = nd.style.getPropertyValue('--c') || '#fff';
            paths += `<path id="tw-out-${i}" class="tour-wire tour-wire--out tour-wire--${nd.dataset.node}" style="--c:${col}" d="${d}"/>`;
            ports += `<circle class="tour-port" style="--c:${col}" cx="${port.x.toFixed(1)}" cy="${port.y.toFixed(1)}" r="2.6"/>`;
            if (!reduce) for (let k = 0; k < 2; k++) packets += `<circle class="tour-pk" style="--c:${col}" r="3.5"><animateMotion dur="${(1.7 + i * 0.12).toFixed(2)}s" begin="${(i * 0.3 + k * 0.9).toFixed(2)}s" repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.6 1"><mpath href="#tw-out-${i}"/></animateMotion></circle>`;
        });
        // The ring the wires plug into, drawn in the same SVG so it can never drift from their ends.
        const ring = `<circle class="tour-hub-ring" cx="${hub.x.toFixed(1)}" cy="${hub.y.toFixed(1)}" r="${ringR.toFixed(1)}"/>`;
        svg.innerHTML = paths + ring + ports + packets;
        // Anything rebuilt while the diagram is off screen starts paused, like the rest of it.
        if (!_tourVisible) { try { svg.pauseAnimations(); } catch { /* */ } }
    }
    function rel(b, R) { return { x: b.left - R.left, y: b.top - R.top, w: b.width, h: b.height }; }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
