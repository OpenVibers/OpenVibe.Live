'use strict';
// ═══════════════════════════════════════════════════════════════
// openvibe-shared/legal — Terms, Privacy and DMCA for every OpenVibe site.
//
// Each domain answers for itself: /terms, /privacy and /dmca live on the site's own apex and say
// what THAT site does. One template per document, with clauses switched by the site's profile:
//   streaming  live video, chat, payments      tools    files processed, then deleted
//   ugc        posts, pastes, comments          games    accounts and game state
//   hosting    stored user media                account  the identity provider
//   info       read-only / placeholder site
//
//   const legal = require('openvibe-shared/legal');
//   app.get(legal.PATHS, legal.handler({ host: 'openvibe.tools', name: 'OpenVibe.Tools', profile: 'tools' }));
//   legal.page('privacy', site) → complete HTML document (static generators use this)
//
// Plain language on purpose. These are templates maintained by the project, not legal advice;
// the owner reviews them before relying on them. Facts stated here (what is stored, for how
// long) must match the code — change both together.
// ═══════════════════════════════════════════════════════════════
const UPDATED = '2026-09-18';
const UPDATED_TEXT = 'September 18, 2026';
const CONTACT = 'dmca@openvibe.live';
const PATHS = ['/terms', '/privacy', '/dmca'];
const TITLES = { terms: 'Terms of Service', privacy: 'Privacy Policy', dmca: 'DMCA & Copyright' };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const has = (site, ...profiles) => profiles.includes(site.profile);
const userContent = (site) => has(site, 'streaming', 'ugc', 'hosting', 'games');

function terms(site) {
    const n = esc(site.name);
    const S = [];
    S.push(['The short version', `<p>${n} is part of OpenVibe, an open source, community-run network. Use it for lawful things, be decent to other people, and do not try to break it. We can remove content or accounts that break these terms. The software is provided as it is, without warranties.</p>`]);
    S.push(['Who can use it', `<p>You must be at least 13 years old, or the minimum age of digital consent where you live. If you are under 18, a parent or guardian must agree to these terms for you. You may not use ${n} if you were previously banned from the network.</p>`]);
    if (!has(site, 'info')) S.push(['Your account', `<p>Most of ${n} works without signing in. An OpenVibe account, managed at <a href="https://openvibe.network/">openvibe.network</a>, adds things that need to remember you. You are responsible for what happens under your account; keep your password to yourself and tell us if you think someone else has it.</p>`]);
    if (has(site, 'tools')) S.push(['Files and links you give the tools', `<p>The tools process what you upload or paste and hand you the result. Uploads and results are temporary: they are deleted automatically, normally within one hour for visitors and within 24 hours for signed-in users. Do not rely on ${n} to store anything.</p><p>Only process material you have the right to use. Downloaders are for your own uploads and for content you are allowed to keep; respecting the terms of the site the content comes from is your responsibility. Lookup tools (DNS, WHOIS, ping, port checks) may only be pointed at systems you are allowed to test.</p>`]);
    if (userContent(site)) S.push(['What you post', `<p>You keep ownership of what you ${has(site, 'streaming') ? 'stream, upload, clip or write' : 'upload or write'}. You give OpenVibe a worldwide, non-exclusive, royalty-free licence to host, display, transcode and distribute it so the service can work, including on other OpenVibe sites where your content is meant to appear. The licence ends when you delete the content, except for copies other people made while it was public and backups that expire on their own.</p><p>You are responsible for having the rights to everything you post.</p>`]);
    S.push(['Rules', `<p>OpenVibe leans toward open expression. These limits apply everywhere:</p><ul><li>Nothing illegal where you are or where our servers are (United States).</li><li>No sexual content involving minors, and no sexualisation of minors, ever.</li><li>No credible threats of violence, and no publishing of someone's private information to harm them.</li><li>No content you do not have the rights to.</li><li>No malware, phishing, spam, scraping that ignores robots.txt rate limits, or attempts to disrupt or gain unauthorised access to the service or to other people's systems.</li>${has(site, 'streaming') ? '<li>Streams must be labelled honestly; adult or graphic content belongs behind the mature flag.</li>' : ''}</ul>`]);
    if (has(site, 'streaming')) S.push(['Money', `<p>Donations, tips and purchases of virtual currency are voluntary and final except where the law requires a refund. Virtual currencies have no cash value outside the payout rules shown on the site. Streamers are responsible for their own taxes.</p>`]);
    if (has(site, 'games')) S.push(['Game items and progress', `<p>Items, currency and progress in games have no cash value and may be changed, reset or removed as the games evolve. Cheating, automation that gives an unfair advantage and exploiting bugs can lead to a reset or a ban.</p>`]);
    S.push(['Moderation and ending accounts', `<p>We may remove content, limit features, or suspend accounts that break these terms or put other people or the service at risk. You can stop using ${n} at any time and delete your account from your account settings.</p>`]);
    S.push(['Open source', `<p>OpenVibe's code is public. The code is licensed under the terms in each repository; those licences, not this page, govern your use of the code. These terms cover your use of the hosted service at ${esc(site.host)}.</p>`]);
    S.push(['No warranty, limited liability', `<p>The service is provided "as is" and "as available". To the extent the law allows, OpenVibe and the people who run it are not liable for indirect or consequential losses, lost data, or lost profits arising from your use of ${n}. Nothing here limits liability that cannot be limited by law.</p>`]);
    S.push(['Governing law', `<p>These terms are governed by the laws of the United States and the State of Washington, without regard to conflicts of law. Disputes are handled in the federal or state courts located in Washington State. If part of these terms cannot be enforced, the rest still applies.</p>`]);
    S.push(['Changes and contact', `<p>We may update these terms. Material changes are announced on the site before they take effect. Questions: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>`]);
    return S;
}

function privacy(site) {
    const n = esc(site.name);
    const S = [];
    S.push(['The short version', `<p>${n} collects what it needs to work and to keep abuse out, and no more. We do not sell personal information and we do not run advertising trackers.</p>`]);
    const collect = [
        '<li><b>Request logs.</b> Like every web server, ours record your IP address, browser type, the page requested and the time. We use them for security, rate limiting and aggregate traffic statistics.</li>',
        '<li><b>Usage statistics.</b> Page views and a random session identifier, so we can see which parts of the network people use. These are first-party statistics kept on our own servers.</li>',
    ];
    if (!has(site, 'info')) collect.push(`<li><b>Account information, if you sign in.</b> Your OpenVibe account (username, email address, password hash, profile and preferences) is held by <a href="https://openvibe.network/privacy">openvibe.network</a>. ${n} receives your user id, username, avatar and role so it can show you as signed in.</li>`);
    if (has(site, 'tools')) collect.push('<li><b>What you give a tool.</b> Files, text, links, domain names and IP addresses you submit are processed to produce your result. Uploaded files and generated results are deleted automatically, normally within one hour for visitors and 24 hours for signed-in users. Many text and developer tools run entirely in your browser and send nothing to us.</li>');
    if (has(site, 'streaming')) collect.push('<li><b>Streams, clips, VODs and chat.</b> What you broadcast and write is stored so it can be shown, and is public unless you choose otherwise.</li><li><b>Payments.</b> Payment processors handle card details; we receive a record of the transaction, not your card number.</li><li><b>AI features.</b> Public streams and chat may be transcribed and summarised by AI services to create captions, highlights and overviews.</li>');
    if (has(site, 'ugc')) collect.push('<li><b>What you post.</b> Pastes, posts and comments, with the account that made them. Public items are visible to everyone and may be indexed by search engines.</li>');
    if (has(site, 'hosting')) collect.push('<li><b>Media you upload or record.</b> Videos, clips, images and files, with their metadata, stored so the sites that use them can show them.</li>');
    if (has(site, 'games')) collect.push('<li><b>Game state.</b> Your characters, items, progress and in-game chat.</li>');
    if (has(site, 'account')) collect.push('<li><b>Your account.</b> Username, email address, a salted hash of your password, profile, theme and notification preferences, linked services, sign-in history and, if you keep it switched on, your cross-site history.</li>');
    S.push(['What we collect', `<ul>${collect.join('')}</ul>`]);
    S.push(['Cookies and local storage', `<p>We use a small number of first-party cookies: a sign-in token (<code>ov_token</code>), a refresh token, and a hint that remembers whether you were signed in so other OpenVibe sites can sign you in quietly. Your theme, recent pages and similar preferences are kept in your browser's local storage. There are no third-party advertising cookies. Our sites sit behind Cloudflare, which may set its own security cookies.</p>`]);
    S.push(['Who we share with', `<p>Only the services needed to run the network: our hosting and network providers (OVH, Cloudflare), storage providers for media${has(site, 'streaming') ? ', payment processors, AI providers used for transcription and summaries' : ''}, and email delivery for account messages. We disclose information when the law requires it, and we tell you when we are allowed to.</p>`]);
    S.push(['Across OpenVibe sites', `<p>OpenVibe sites share one account. When you are signed in, the site you visit learns who you are from openvibe.network; it does not receive your password or email address. You can see and clear your cross-site history, and switch it off, at <a href="https://openvibe.network/history">openvibe.network/history</a>.</p>`]);
    S.push(['How long we keep things', `<p>Request logs and raw usage events are kept for a limited period and then reduced to totals. ${has(site, 'tools') ? 'Tool uploads and results are deleted within hours. ' : ''}${userContent(site) ? 'Content you post stays until you delete it or your account. ' : ''}Account data stays until you delete your account; backups expire on their own shortly afterwards.</p>`]);
    S.push(['Your choices and rights', `<p>You can use most of ${n} without an account. With an account you can view, change, export and delete your data from your account settings, or ask us to do it. Depending on where you live (for example the EEA, the UK or California) you may have additional rights to access, correct, delete or restrict the use of your data; write to us and we will honour them.</p>`]);
    S.push(['Children', `<p>${n} is not for children under 13, and we do not knowingly collect their information. If you believe a child has given us personal information, contact us and we will delete it.</p>`]);
    S.push(['Changes and contact', `<p>We will post changes here and update the date above. Questions and requests: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>`]);
    return S;
}

function dmca(site) {
    const n = esc(site.name);
    const S = [];
    S.push(['Our position', `<p>${n} respects copyright and responds to clear notices of infringement under the Digital Millennium Copyright Act (17 U.S.C. § 512).${has(site, 'tools') ? ` The tools here process material at a user's request and do not keep a library of it: results are deleted automatically within hours.` : ''}${has(site, 'info') ? ` ${n} publishes its own material and does not host uploads from the public.` : ''}</p>`]);
    S.push(['Send a takedown notice', `<p>Email <a href="mailto:${CONTACT}">${CONTACT}</a> with all of the following:</p><ol><li>Your name, address, phone number and email address, and whom you represent.</li><li>The copyrighted work you say was infringed.</li><li>The exact URL on ${esc(site.host)} of the material you want removed. General descriptions are not enough to find it.</li><li>A statement that you have a good-faith belief the use is not authorised by the copyright owner, its agent or the law.</li><li>A statement, under penalty of perjury, that the information is accurate and that you are the owner or authorised to act for the owner.</li><li>Your physical or electronic signature.</li></ol>`]);
    S.push(['What happens next', `<p>We remove or disable access to the material, tell the person who posted it, and give them your notice. We act on complete notices as quickly as we can, normally within a few business days.</p>`]);
    if (!has(site, 'info')) S.push(['Counter-notice', `<p>If your material was removed by mistake or misidentification, send a counter-notice to the same address with: your contact details, the material and where it appeared, a statement under penalty of perjury that you believe it was removed by mistake, your consent to the jurisdiction of the federal court for your district (or for Washington State if you are outside the United States), and your signature. We forward it to the complainant and may restore the material after 10 to 14 business days unless they tell us they have filed a court action.</p>`]);
    S.push(['Repeat infringers and false claims', `<p>Accounts that repeatedly infringe are terminated. Knowingly false notices and counter-notices carry legal liability under § 512(f); we also refuse notices that are clearly abusive.</p>`]);
    return S;
}

const BUILDERS = { terms, privacy, dmca };

/** { title, description, sections: [[heading, html]], updated } for one document of one site. */
function build(kind, site) {
    if (!BUILDERS[kind]) throw new Error('Unknown legal document: ' + kind);
    const s = Object.assign({ profile: 'info' }, site);
    return { kind, title: `${TITLES[kind]} — ${s.name}`, heading: TITLES[kind],
        description: { terms: `The rules for using ${s.name}, in plain language.`, privacy: `What ${s.name} collects, why, and the choices you have.`, dmca: `How to report copyright infringement on ${s.name}, and how to respond to a report.` }[kind],
        updated: UPDATED, sections: BUILDERS[kind](s) };
}

/** Article markup only, for sites that wrap it in their own layout. */
function article(kind, site) {
    const d = build(kind, site);
    const others = Object.keys(TITLES).filter(k => k !== kind);
    return `<article class="ov-legal"><p class="ov-legal-kicker">${esc(site.name)}</p><h1>${esc(d.heading)}</h1><p class="ov-legal-date">Last updated <time datetime="${d.updated}">${UPDATED_TEXT}</time></p>
${d.sections.map(([h, html], i) => `<section><h2 id="s${i + 1}">${esc(h)}</h2>${html}</section>`).join('\n')}
<nav class="ov-legal-more" aria-label="Other policies">${others.map(k => `<a href="/${k}">${esc(TITLES[k])}</a>`).join('')}<a href="https://openvibe.network/">About OpenVibe</a></nav></article>`;
}

const CSS = `*{box-sizing:border-box}body{margin:0;background:var(--bg-primary,#0a0f18);color:var(--text-primary,#e6edf7);font:400 16px/1.65 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.ov-legal{max-width:760px;margin:0 auto;padding:40px 20px 24px}.ov-legal-kicker{margin:0;font-size:13px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--accent-light,var(--accent,#60a5fa))}
.ov-legal h1{font-size:clamp(28px,4.5vw,40px);letter-spacing:-.03em;line-height:1.1;margin:6px 0 4px}.ov-legal-date{color:var(--text-muted,#7d8aa0);font-size:14px;margin:0 0 28px}
.ov-legal h2{font-size:19px;margin:30px 0 8px;letter-spacing:-.01em}.ov-legal p,.ov-legal li{color:var(--text-secondary,#a8b3c4)}.ov-legal li{margin:6px 0}.ov-legal b{color:var(--text-primary,#e6edf7)}
.ov-legal a{color:var(--accent-light,var(--accent,#60a5fa))}.ov-legal code{font-size:13.5px;background:var(--bg-secondary,#111826);padding:1px 6px;border-radius:5px}
.ov-legal-more{display:flex;flex-wrap:wrap;gap:10px;margin-top:40px;padding-top:20px;border-top:1px solid var(--border,rgba(255,255,255,.1))}.ov-legal-more a{padding:8px 14px;border:1px solid var(--border,rgba(255,255,255,.12));border-radius:10px;text-decoration:none;font-weight:600;font-size:14px}`;

/** A complete page: shared theme, navbar and footer, readable without JavaScript. */
function page(kind, site) {
    const d = build(kind, site);
    const url = `https://${site.host}/${kind}`;
    let head;
    try { head = require('./seo').headTags({ title: d.title, description: d.description, canonical: url, siteName: site.name, type: 'article' }); }
    catch { head = `<title>${esc(d.title)}</title><meta name="description" content="${esc(d.description)}"><link rel="canonical" href="${url}">`; }
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${head}
${require('./app-icon').headTags({ site: site.id })}
<script src="https://openvibe.network/shared/theme-loader.js"></script><style>${CSS}</style></head><body>
<noscript><p style="padding:12px 20px;margin:0"><a href="/">${esc(site.name)}</a></p></noscript>
<main>${article(kind, site)}</main><div id="ov-footer"></div>
<script src="https://openvibe.network/shared/navbar.js" defer></script><script src="https://openvibe.network/shared/footer.js" defer></script>
<script>addEventListener('DOMContentLoaded',function(){var t=null;try{t=(document.cookie.match(/(?:^|; )ov_token=([^;]*)/)||[])[1]||localStorage.getItem('ov_token')}catch(e){}
try{OpenVibeNavbar.init({service:${JSON.stringify(site.service || site.id || 'network')},apiBase:'https://openvibe.network',token:t?decodeURIComponent(t):null})}catch(e){}
try{OpenVibeFooter.init({service:${JSON.stringify(site.service || site.id || 'network')},variant:'compact',mount:'#ov-footer',apiBase:'https://openvibe.network'})}catch(e){}});</script>
</body></html>`;
}

/** Express handler for legal.PATHS. */
function handler(site) {
    const cache = new Map();
    return function ovLegal(req, res, next) {
        const kind = String(req.path || '').replace(/^\/+|\/+$/g, '');
        if (!BUILDERS[kind]) return next();
        if (!cache.has(kind)) cache.set(kind, page(kind, site));
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
        res.send(cache.get(kind));
    };
}

module.exports = { PATHS, TITLES, UPDATED, CONTACT, build, article, page, handler, CSS };
