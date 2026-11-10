#!/usr/bin/env node
'use strict';
/**
 * The home page's "OpenVibe network" section (public/fragments/home.html, between <!--ov:network--> and
 * <!--/ov:network-->), rendered from the network's own list of sites: OpenVibe.Network's frame
 * (https://openvibe.network/api/frame), the same list the OV mark's site switcher shows. The owner, 2026-11-07: "this
 * area on live is so outdated and lame. Remake this area entirely considering what all the network offers … improve
 * the SEO". The old section was fourteen hand-written cards; this one is every open site, by what people come to do.
 *
 * The HTML is written into the fragment so crawlers and the first paint get every site's name, address and line as
 * real links (no script needed). In the browser, app-home.js initHomeNetwork() reads the same frame again and adds a
 * site that opened since this was run, so the page is never behind for long; run this again to bake it in.
 *
 *   node scripts/build-network-section.js              fetch the frame and rewrite the section
 *   node scripts/build-network-section.js frame.json   from a saved frame (tests, offline)
 *
 * Only https links on OpenVibe's own hosts are written, and the names the owner keeps private never appear.
 */
const fs = require('fs');
const path = require('path');

const FRAGMENT = path.join(__dirname, '..', 'public', 'fragments', 'home.html');
const OPEN = '<!--ov:network-->';
const CLOSE = '<!--/ov:network-->';
const FRAME_URL = 'https://openvibe.network/api/frame?host=openvibe.live';

// Hosts a network site may live on, and the ones that are never named in public.
const OURS = /(^|\.)(openvibe\.[a-z]+|open\.shoes|openre\.stream)$/i;
const NEVER = /(^|\.)(openvibe\.(fund|ai|recipes|page)|openvalve\.games|therecipelist\.com)$/i;

// What each group looks like: an accent, a Font Awesome icon and one plain line.
const GROUPS = {
    streams: { accent: '#ef4444', icon: 'fa-tower-broadcast', line: 'Go live, watch, share pictures and video' },
    games: { accent: '#a855f7', icon: 'fa-gamepad', line: 'Play in the browser, laugh, explore' },
    answers: { accent: '#f59e0b', icon: 'fa-newspaper', line: 'News, reports, reviews and answers' },
    make: { accent: '#3b82f6', icon: 'fa-wand-magic-sparkles', line: 'Tools, sites, bots, designs and code' },
    shop: { accent: '#22c55e', icon: 'fa-basket-shopping', line: 'Deals, jobs, food, homes and trades' },
    people: { accent: '#ec4899', icon: 'fa-user-group', line: 'Your people, your account, your stuff' },
    build: { accent: '#14b8a6', icon: 'fa-code', line: 'APIs and services to build on' },
};
const FALLBACK_GROUP = { accent: '#38bdf8', icon: 'fa-circle-nodes', line: '' };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const idOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);

/** The frame's sites that may be shown: { id, name, url, host, icon, tagline, group }. */
function sitesOf(frame) {
    const out = [];
    const seen = new Set();
    for (const s of (frame && Array.isArray(frame.nav) ? frame.nav : [])) {
        if (!s || typeof s.url !== 'string' || typeof s.name !== 'string') continue;
        let u; try { u = new URL(s.url); } catch { continue; }
        if (u.protocol !== 'https:' || u.username || u.password) continue;
        const host = u.hostname.toLowerCase();
        if (!OURS.test(host) || NEVER.test(host)) continue;
        const id = idOf(s.id) || idOf(host);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name: s.name.slice(0, 40), url: u.href, host, icon: idOf(s.icon) || id, tagline: String(s.tagline || '').slice(0, 90), group: idOf(s.group) });
    }
    return out;
}

/** The frame's groups in order, each with its sites; a site in no known group goes to "More". */
function groupsOf(frame, sites) {
    const named = (frame && Array.isArray(frame.groups) ? frame.groups : []).filter((g) => g && g.id && g.name).map((g) => ({ id: idOf(g.id), name: String(g.name).slice(0, 40) }));
    const known = new Set(named.map((g) => g.id));
    const groups = named.map((g) => ({ ...g, sites: sites.filter((s) => s.group === g.id) })).filter((g) => g.sites.length);
    const rest = sites.filter((s) => !known.has(s.group));
    if (rest.length) groups.push({ id: 'more', name: 'More', sites: rest });
    return groups;
}

function siteHtml(s, i) {
    return `<li><a class="ovnet-site" href="${esc(s.url)}" data-site="${esc(s.id)}" style="--i:${i}">`
        + `<span class="ov-icon" data-icon="${esc(s.icon)}" data-size="40" aria-hidden="true"></span>`
        + `<span class="ovnet-txt"><b>${esc(s.name)}</b><small>${esc(s.host)}</small>${s.tagline ? `<span>${esc(s.tagline)}</span>` : ''}</span></a></li>`;
}

/** The section's inside: the head, the jump links, every group and the foot. */
function render(frame) {
    const sites = sitesOf(frame);
    const groups = groupsOf(frame, sites);
    const look = (g) => GROUPS[g.id] || FALLBACK_GROUP;
    const jump = groups.map((g) => `<a href="#ovnet-g-${esc(g.id)}" style="--g:${look(g).accent}"><i class="fa-solid ${look(g).icon}" aria-hidden="true"></i>${esc(g.name)}<b>${g.sites.length}</b></a>`).join('');
    let n = 0;
    const blocks = groups.map((g) => {
        const L = look(g);
        const items = g.sites.map((s) => siteHtml(s, n++)).join('');
        return `<div class="ovnet-group" id="ovnet-g-${esc(g.id)}" role="group" aria-labelledby="ovnet-gh-${esc(g.id)}" data-group="${esc(g.id)}" style="--g:${L.accent}">`
            + `<h3 id="ovnet-gh-${esc(g.id)}"><i class="fa-solid ${L.icon}" aria-hidden="true"></i><span>${esc(g.name)}</span><b class="ovnet-n">${g.sites.length}</b></h3>`
            + (L.line ? `<p class="ovnet-gline">${esc(L.line)}</p>` : '')
            + `<ul class="ovnet-sites" data-ovk-scroll>${items}</ul></div>`;
    }).join('');
    return `
    <div class="ovnet-sky" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <header class="ovnet-head">
        <p class="ovnet-eyebrow"><span class="ovnet-dot" aria-hidden="true"></span>The OpenVibe network</p>
        <h2 id="ovnet-title">One account. <span class="ovnet-count" data-count="${sites.length}">${sites.length}</span> sites.</h2>
        <p class="ovnet-lede">Stream, play, cook, find work, build and ship: every OpenVibe site opens with the same sign-in, wears your theme and carries your OpenCoins and Vibes.</p>
        <nav class="ovnet-jump" data-ovk-scroll aria-label="Kinds of OpenVibe sites">${jump}</nav>
    </header>
    <div class="ovnet-groups" data-sites="${sites.length}">${blocks}</div>
    <footer class="ovnet-foot">
        <a class="ovnet-cta" href="/api/auth/sso/login?next=%2F" data-ovnet-signin><i class="fa-solid fa-user-plus" aria-hidden="true"></i> Create your free account</a>
        <button type="button" class="ovnet-switch" data-ovnet-switcher><span class="ovnet-orb" aria-hidden="true"><svg class="ovmb" viewBox="0 0 24 24" width="22" height="22"><rect class="ovmb-bar" x="4" y="5.2" width="16" height="5.6" rx="2.8"/><circle class="ovmb-dot" cx="7.4" cy="8" r="1.15"/><rect class="ovmb-app ovmb-a0" x="4.2" y="14.6" width="4" height="4" rx="1.3"/><rect class="ovmb-app ovmb-a1" x="10" y="14.6" width="4" height="4" rx="1.3"/><rect class="ovmb-app ovmb-a2" x="15.8" y="14.6" width="4" height="4" rx="1.3"/></svg></span><span class="ovnet-switch-t"><b>Every site is in the menu</b><small>This button, at the top of every page</small></span><i class="ovnet-switch-go" aria-hidden="true"></i></button>
    </footer>
    `;
}

async function frameFrom(arg) {
    if (arg) return JSON.parse(fs.readFileSync(arg, 'utf8'));
    const r = await fetch(FRAME_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`the frame answered ${r.status}`);
    return await r.json();
}

/** The fragment with its network section replaced. */
function rewrite(html, inner) {
    const a = html.indexOf(OPEN), b = html.indexOf(CLOSE);
    if (a < 0 || b < a) throw new Error(`${path.basename(FRAGMENT)} has no ${OPEN} … ${CLOSE} block`);
    return html.slice(0, a + OPEN.length) + inner + html.slice(b);
}

if (require.main === module) {
    (async () => {
        const frame = await frameFrom(process.argv[2]);
        const sites = sitesOf(frame);
        if (sites.length < 10) throw new Error(`only ${sites.length} sites in the frame: not rewriting the home page with that`);
        const html = rewrite(fs.readFileSync(FRAGMENT, 'utf8'), render(frame));
        fs.writeFileSync(FRAGMENT, html);
        console.log(`network section: ${sites.length} sites in ${groupsOf(frame, sites).length} groups`);
    })().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { sitesOf, groupsOf, render, rewrite, OPEN, CLOSE, GROUPS };
