/**
 * home-tour.js — "One stream. Everywhere. Every toy." — the animated feature tour on the home page.
 *
 * Static content, no API: the restream pipeline (your cam or robot → OpenVibe.Live → Twitch,
 * YouTube, Kick, RobotStreamer, any RTMP) with packets flowing along it, and the feature chips
 * that only exist here. Mounted into #home-tour-mount under the hero CTA. Transform-only
 * animations, so it stays smooth in mobile lite mode.
 */
(function () {
    'use strict';
    function mount() {
        const el = document.getElementById('home-tour-mount');
        if (!el || el.dataset.mounted) return;
        el.dataset.mounted = '1';
        const go = (href) => `href="${href}" onclick="return handleLinkClick(event, '${href}')"`;
        el.innerHTML = `
            <div class="tour">
                <div class="tour-head">
                    <h2><i class="fa-solid fa-satellite-dish"></i> One stream. Everywhere. Every toy.</h2>
                    <p>Go live here once and mirror it to every platform at the same time — while your chat, emotes, sound commands, robot controls, VODs and clips all live in one place.</p>
                </div>
                <div class="tour-flow" aria-label="Stream from OpenVibe.Live and restream everywhere">
                    <div class="tour-src"><span class="tour-node"><i class="fa-solid fa-video"></i> your cam</span><span class="tour-node"><i class="fa-solid fa-robot"></i> your robot</span><span class="tour-node"><i class="fa-solid fa-desktop"></i> OBS / RTMP</span></div>
                    <div class="tour-wire" aria-hidden="true"><span class="tour-packet"></span><span class="tour-packet"></span></div>
                    <div class="tour-hub"><b><i class="fa-solid fa-circle-nodes"></i> OpenVibe.Live</b><small>WebRTC &lt;1s latency · emotes · sound commands · robot controls · VODs · clips · AI moments</small></div>
                    <div class="tour-wire tour-fan" aria-hidden="true"><span class="tour-packet"></span><span class="tour-packet"></span><span class="tour-packet"></span></div>
                    <div class="tour-out">
                        <span class="tour-node tour-twitch"><i class="fa-brands fa-twitch"></i> Twitch</span>
                        <span class="tour-node tour-yt"><i class="fa-brands fa-youtube"></i> YouTube</span>
                        <span class="tour-node tour-kick"><i class="fa-solid fa-bolt"></i> Kick</span>
                        <span class="tour-node tour-rs"><i class="fa-solid fa-robot"></i> RobotStreamer</span>
                        <span class="tour-node"><i class="fa-solid fa-tower-broadcast"></i> any RTMP</span>
                    </div>
                </div>
                <div class="tour-features">
                    <span class="tour-feat" style="--i:0"><i class="fa-solid fa-gauge-high"></i> Sub-second WebRTC latency</span>
                    <span class="tour-feat" style="--i:1"><i class="fa-solid fa-face-grin-squint-tears"></i> 7TV / BTTV / FFZ + custom emotes</span>
                    <span class="tour-feat" style="--i:2"><i class="fa-solid fa-volume-high"></i> Sound commands &amp; soundboard</span>
                    <span class="tour-feat" style="--i:3"><i class="fa-solid fa-gamepad"></i> Robot &amp; hardware controls</span>
                    <span class="tour-feat" style="--i:4"><i class="fa-solid fa-satellite-dish"></i> Free restream, all at once</span>
                    <span class="tour-feat" style="--i:5"><i class="fa-solid fa-scissors"></i> VODs, clips, AI moments</span>
                    <span class="tour-feat" style="--i:6"><i class="fa-solid fa-comments"></i> One chat from every platform</span>
                    <span class="tour-feat" style="--i:7"><i class="fa-solid fa-language"></i> Auto-translated chat</span>
                    <span class="tour-feat" style="--i:8"><i class="fa-solid fa-microphone-lines"></i> The Arena: mic-judged beefs</span>
                    <span class="tour-feat" style="--i:9"><i class="fa-brands fa-github"></i> 100% open source</span>
                </div>
                <div class="tour-actions">
                    <a class="btn btn-primary btn-lg" ${go('/broadcast')}><i class="fa-solid fa-tower-broadcast"></i> Go live</a>
                    <a class="btn btn-outline btn-lg" href="/broadcast?setup=restream" onclick="event.preventDefault(); startRestreamGuide();"><i class="fa-solid fa-satellite-dish"></i> Set up restreams (guided)</a>
                </div>
            </div>`;
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
