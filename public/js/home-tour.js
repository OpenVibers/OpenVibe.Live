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
    const SRC = [
        { id: 'cam', icon: 'fa-solid fa-video', label: 'Your cam', sub: 'browser · phone' },
        { id: 'robot', icon: 'fa-solid fa-robot', label: 'Your robot', sub: 'viewer-controlled' },
        { id: 'obs', icon: 'fa-solid fa-desktop', label: 'OBS / RTMP', sub: 'or WHIP' },
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
    const go = (href) => `href="${href}" onclick="return handleLinkClick(event, '${href}')"`;

    function mount() {
        const el = document.getElementById('home-tour-mount');
        if (!el || el.dataset.mounted) return;
        el.dataset.mounted = '1';
        el.innerHTML = `
            <section class="tour" aria-label="Stream from OpenVibe.Live and restream everywhere">
                <div class="tour-head">
                    <div class="tour-kicker"><i class="fa-solid fa-satellite-dish"></i> Restream</div>
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
                            <small>&lt;1s latency · chat · emotes · sounds · controls · VOD · clips</small>
                        </div>
                    </div>
                    <div class="tour-col tour-col--dst">
                        <div class="tour-col-label">It lands on</div>
                        ${DST.map(d => `<div class="tour-node tour-node--dst" data-node="${d.id}" style="--c:${d.color}"><span class="tour-node-ico"><i class="${d.icon}"></i></span><span class="tour-node-text"><b>${d.label}</b></span><span class="tour-node-dot"></span></div>`).join('')}
                    </div>
                </div>
                <div class="tour-features">${FEATURES.map(([i, t], k) => `<span class="tour-feat" style="--i:${k}"><i class="${i.startsWith('fa-brands') ? i : 'fa-solid ' + i}"></i> ${t}</span>`).join('')}</div>
                <div class="tour-actions">
                    <a class="btn btn-primary btn-lg" ${go('/broadcast')}><i class="fa-solid fa-tower-broadcast"></i> Go live</a>
                </div>
                <!-- Filled by setupNextUp() in guides-live.js: the progress quest for signed-in
                     streamers, the join panel for everyone else. The link below is the no-JS
                     fallback and what a crawler sees. -->
                <div class="tour-quest-slot" id="tour-next-up" data-fx-viewport>
                    <a class="btn btn-outline btn-lg" href="/broadcast?guide=golive:restream" onclick="event.preventDefault(); if (typeof startRestreamGuide === 'function') startRestreamGuide();"><i class="fa-solid fa-satellite-dish"></i> Set up restreams (guided)</a>
                </div>
            </section>`;
        wire();
        // Signed-in streamers get a context-aware button: the next thing they haven't set up.
        const nextUp = () => { if (typeof setupNextUp === 'function') setupNextUp(document.getElementById('tour-next-up')); };
        setTimeout(nextUp, 900); setTimeout(nextUp, 3500);
        let raf = 0;
        const redraw = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(wire); };
        if ('ResizeObserver' in window) new ResizeObserver(redraw).observe(el.querySelector('#tour-stage'));
        window.addEventListener('resize', redraw);
        document.fonts && document.fonts.ready && document.fonts.ready.then(redraw);
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
        svg.setAttribute('viewBox', `0 0 ${R.width} ${R.height}`);
        svg.setAttribute('width', R.width); svg.setAttribute('height', R.height);
        const vertical = getComputedStyle(stage).getPropertyValue('--tour-vertical').trim() === '1';
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('rs-lite');
        const core = stage.querySelector('[data-node="core"]');
        if (!core) return;
        const c = rel(core.getBoundingClientRect(), R);
        const anchorOf = (node, side) => {
            const b = rel(node.getBoundingClientRect(), R);
            if (vertical) return { x: b.x + b.w / 2, y: side === 'out' ? b.y + b.h : b.y };
            return { x: side === 'out' ? b.x + b.w : b.x, y: b.y + b.h / 2 };
        };
        const coreIn = vertical ? { x: c.x + c.w / 2, y: c.y } : { x: c.x, y: c.y + c.h / 2 };
        const coreOut = vertical ? { x: c.x + c.w / 2, y: c.y + c.h } : { x: c.x + c.w, y: c.y + c.h / 2 };
        const curve = (a, b) => vertical
            ? `M${a.x},${a.y} C${a.x},${(a.y + b.y) / 2} ${b.x},${(a.y + b.y) / 2} ${b.x},${b.y}`
            : `M${a.x},${a.y} C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x},${b.y}`;
        let defs = '', paths = '', packets = '';
        const srcNodes = [...stage.querySelectorAll('.tour-node--src')], dstNodes = [...stage.querySelectorAll('.tour-node--dst')];
        srcNodes.forEach((nd, i) => {
            const d = curve(anchorOf(nd, 'out'), coreIn);
            paths += `<path id="tw-in-${i}" class="tour-wire tour-wire--in" d="${d}"/>`;
            if (!reduce) packets += `<circle class="tour-pk tour-pk--in" r="3.5"><animateMotion dur="${(1.6 + i * 0.2).toFixed(2)}s" begin="${(i * 0.55).toFixed(2)}s" repeatCount="indefinite"><mpath href="#tw-in-${i}"/></animateMotion></circle>`;
        });
        dstNodes.forEach((nd, i) => {
            const d = curve(coreOut, anchorOf(nd, 'in'));
            const col = nd.style.getPropertyValue('--c') || '#fff';
            paths += `<path id="tw-out-${i}" class="tour-wire tour-wire--out tour-wire--${nd.dataset.node}" style="--c:${col}" d="${d}"/>`;
            if (!reduce) for (let k = 0; k < 2; k++) packets += `<circle class="tour-pk" style="--c:${col}" r="3.5"><animateMotion dur="${(1.7 + i * 0.12).toFixed(2)}s" begin="${(i * 0.3 + k * 0.9).toFixed(2)}s" repeatCount="indefinite"><mpath href="#tw-out-${i}"/></animateMotion></circle>`;
        });
        svg.innerHTML = defs + paths + packets;
    }
    function rel(b, R) { return { x: b.left - R.left, y: b.top - R.top, w: b.width, h: b.height }; }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
