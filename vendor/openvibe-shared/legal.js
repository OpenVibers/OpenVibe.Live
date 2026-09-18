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

// Clause helpers. Every statement of fact below is backed by code in one of the repositories:
// retention windows (OpenVibe.Tools apps/*/server/config.js), cookies (server/auth/*), the anonymous
// page-view count (Network server/chrome), cross-site history (Network server/history), display and
// theme preferences (theme-loader.js), AI site copy (Live server/internal/routes.js).
const P = (...t) => t.map(x => `<p>${x}</p>`).join('');
const UL = (items) => `<ul>${items.filter(Boolean).map(i => `<li>${i}</li>`).join('')}</ul>`;

function terms(site) {
    const n = esc(site.name), host = esc(site.host);
    const S = [];
    S.push(['The short version', P(`${n} is part of OpenVibe, an open source, community-run network. Use it for lawful things, be decent to other people, and do not try to break it. Most of it works without an account. We can remove content or accounts that break these terms. The service is provided as it is, without warranties.`,
        `These terms cover ${host}, its subdomains, and any other domain that serves the same service. Other OpenVibe sites have their own terms, written for what those sites do.`)]);
    S.push(['Who can use it', P(`You must be at least 13 years old, or the minimum age of digital consent where you live. If you are under 18, a parent or guardian must agree to these terms for you. You may not use ${n} if you were banned from the network, or if the law where you live forbids it.`)]);
    if (has(site, 'info')) S.push(['This site is not open yet', P(`${n} is a reserved address that currently shows a preview page. There is nothing to sign up for or post here yet. When it opens, these terms will be replaced with ones written for what it does, and the date above will change.`)]);
    if (!has(site, 'info')) S.push(['Your account', P(`An OpenVibe account is managed at <a href="https://openvibe.network/">openvibe.network</a> and works on every OpenVibe site. One sign-in can quietly sign you in on the other sites you visit; you can sign out everywhere from your account page.`,
        `You are responsible for what happens under your account. Keep your password to yourself, use a working email address so you can recover access, and tell us if you think someone else has got in. One person per account; do not sell, lend or share it. We may reclaim usernames that impersonate someone or sit unused.`)]);
    if (has(site, 'account')) S.push(['What the account does', P(`The account holds your sign-in, profile, theme, display and notification preferences, linked services, cross-site history and any balances shown in your wallet. Linking a third-party service (for example Discord) lets us read the basic profile that service shares and nothing you did not approve. You can unlink a service at any time.`,
        `Themes you publish to the theme gallery are shared with other users under the licence shown when you publish; do not publish a theme that copies someone else's work.`,
        `Balances, points, payouts and purchases are governed by the rules shown at the place where you earn, buy or cash them out. Unless those rules say otherwise, balances have no cash value and cannot be transferred.`)]);
    if (has(site, 'tools')) {
        S.push(['Files, text and links you give the tools', P(`A tool processes what you upload, paste or point it at and hands you the result. Uploads and results are temporary: they are deleted automatically, normally within one hour for visitors and within 24 hours for signed-in users. ${n} is not storage; keep your own copies.`,
            `Many text and developer tools run entirely in your browser and send nothing to us. Tools that need a server say so by their nature: converters, downloaders, PDF tools and network lookups.`,
            `You keep all rights in what you process and in the results. We claim no ownership of either. Logos, wordmarks and other generated designs are yours to use, but we do not check them against trademarks; clearing a name or a design is your job.`)]);
        S.push(['Rules for specific tools', UL([
            `<b>Downloaders</b> are for your own uploads and for content you are allowed to keep: public-domain and openly licensed work, or where the law gives you the right. You are responsible for respecting the terms of the site the content comes from. We do not host or index the downloaded content.`,
            `<b>Network tools</b> (DNS, WHOIS, ping, traceroute, port and SSL checks, HTTP fetchers) send real traffic to the target you enter. Only point them at systems you own or are authorised to test. Do not use them to scan, probe or load-test other people's infrastructure.`,
            `<b>Maps and food finder</b> data comes from public and community sources and can be out of date. Check opening hours, access rules and land status before you travel. It is not an emergency service; in an emergency call your local emergency number.`,
            `<b>Converters and PDF tools</b>: do not upload files you have no right to process, and do not use the unlock or protect tools to defeat protection on documents that are not yours.`,
            `<b>Automation</b>: the tool catalog is public JSON and crawlers are welcome. Automated use of the tools themselves is rate limited; heavy or commercial automation needs our agreement first.`])]);
    }
    if (has(site, 'ugc')) S.push(['Pastes, posts and comments', P(`You choose whether an item is public or unlisted. Public items appear in listings and feeds, can be indexed by search engines, and may be copied by other people while they are public. Unlisted items are reachable by anyone who has the link; they are not private. Mark adult content as such.`,
        `Never post passwords, API keys, private keys, payment details or other people's personal information. We remove leaked credentials, malware, phishing kits and doxxing when we find them, and may do so without notice to limit harm.`)]);
    if (has(site, 'hosting')) S.push(['Stored media', P(`${n} stores recorded streams, clips, thumbnails, images and files for the OpenVibe sites that use them. Whether an item is public follows the setting on the site it came from. Public media can be embedded and linked from elsewhere. Media may be kept on third-party object storage and served through a content delivery network.`,
        `Deleting an item on the site it came from removes it here; copies in caches expire on their own. We may remove media that breaks these terms, and we may expire old or unused media according to the storage limits shown on the originating site.`)]);
    if (has(site, 'streaming')) S.push(['Streams, clips and chat', P(`You are responsible for everything in your broadcast, including music, games, other people who appear in it, and what your viewers can control. Get consent before streaming people in private settings. Label streams honestly and put adult or graphic content behind the mature flag.`,
        `Streams may be recorded, clipped by viewers, transcribed and summarised by automated systems so they can be searched and highlighted. Restreaming to other platforms is done on your behalf and is subject to those platforms' rules.`)]);
    if (has(site, 'games')) S.push(['Games', P(`Games here are in active development. Worlds, characters, items and progress may be changed, rebalanced, rolled back or reset, and servers may be unavailable. Items and in-game currency have no cash value and may not be sold or traded for money.`,
        `Play fair: no cheats, bots, packet tampering, exploiting bugs for advantage, or harassing other players in game chat. What you draw on shared canvases is public, may be captured in public snapshots, and follows the same content rules as the rest of the network.`)]);
    if (userContent(site)) S.push(['Your content and the licence you give us', P(`You keep ownership of what you ${has(site, 'streaming') ? 'stream, upload, clip or write' : 'create, upload or write'}. You give OpenVibe a worldwide, non-exclusive, royalty-free licence to host, store, reproduce, transcode, display and distribute it so the service can work, including on other OpenVibe sites where your content is meant to appear, and to show it in previews and search results. The licence ends when you delete the content, except for copies other people made while it was public and backups that expire on their own.`,
        `You promise that you have the rights to everything you post and that it does not break the law or anyone's rights.`)]);
    S.push(['Rules for everyone', P(`OpenVibe leans toward open expression. These limits apply on every site:`) + UL([
        'Nothing illegal where you are or in the United States, where our servers are.',
        'No sexual content involving minors and no sexualisation of minors, ever. We report it to the authorities.',
        'No credible threats, incitement to violence, or publishing private information to harm someone.',
        'No content you do not have the rights to.',
        'No malware, phishing, spam, fraud, or impersonation of a person or organisation to deceive.',
        'No attempts to disrupt the service, get around bans, rate limits or access controls, or reach other people\'s accounts or data.',
        'No scraping that ignores robots.txt or our rate limits. Respectful crawlers, archives and AI agents are welcome; a machine-readable map is at /llms.txt where available.'])]);
    if (has(site, 'streaming')) S.push(['Money', P(`Donations, tips and purchases of virtual currency are voluntary and final except where the law requires a refund. Payment processors handle the payment under their own terms. Virtual currencies have no cash value outside the payout rules shown on the site. Creators are responsible for their own taxes, and we may withhold payouts connected to fraud or chargebacks.`)]);
    S.push(['Automated and AI-written text', P(`Some descriptive text on OpenVibe, such as footer blurbs, summaries and suggestions, is written by automated systems and checked by rules rather than by a person. It can be wrong. Do not rely on it for decisions that matter.`)]);
    S.push(['Reporting and moderation', P(`Report content with the report controls where they exist, or write to <a href="mailto:${CONTACT}">${CONTACT}</a>. Copyright complaints follow the <a href="/dmca">DMCA process</a>. We may remove content, limit features, or suspend accounts that break these terms or put other people or the service at risk, and we may act without notice when the harm is urgent. If you think we got it wrong, reply to the notice or write to the same address and a person will look again.`)]);
    S.push(['Leaving', P(`You can stop using ${n} at any time${has(site, 'info') ? '' : ' and delete your account from your account settings. Deleting the account removes your access on every OpenVibe site'}. Sections that by their nature should survive (licences for content already shared, liability, governing law) continue after you leave.`)]);
    S.push(['Open source, links and feedback', P(`OpenVibe's code is public. Each repository's licence governs your use of the code; these terms govern your use of the hosted service at ${host}. Links to other sites are provided for convenience and we are not responsible for them. If you send us ideas or fixes, we may use them without owing you anything, and contributions to the code are made under the repository's licence.`)]);
    S.push(['No warranty, limited liability', P(`The service is provided "as is" and "as available", without warranties of any kind, including fitness for a particular purpose, accuracy of results, or uninterrupted availability. To the extent the law allows, OpenVibe and the people who run it are not liable for indirect, incidental or consequential losses, lost data or lost profits arising from your use of ${n}, and our total liability is limited to the greater of what you paid us in the past twelve months or fifty US dollars. Nothing here limits liability that cannot be limited by law, and consumer rights you have under the law of your country remain.`,
        `If your use of ${n} breaks these terms or the law and someone brings a claim against us because of it, you agree to cover our reasonable costs.`)]);
    S.push(['Governing law', P(`These terms are governed by the laws of the United States and the State of Washington, without regard to conflicts of law. Disputes are handled in the federal or state courts located in Washington State, unless the consumer law of your country gives you the right to use your local courts. If part of these terms cannot be enforced, the rest still applies. Not enforcing a term once does not waive it. These terms are the whole agreement between us about ${n}.`)]);
    S.push(['Changes and contact', P(`We may update these terms. Material changes are announced on the site before they take effect, and the date at the top changes. Continuing to use ${n} after a change means you accept it. Questions: <a href="mailto:${CONTACT}">${CONTACT}</a>.`)]);
    return S;
}

function privacy(site) {
    const n = esc(site.name);
    const S = [];
    S.push(['The short version', P(`${n} collects what it needs to work and to keep abuse out, and no more. We do not sell or rent personal information, we do not share it for advertising, and we do not run advertising trackers. Most of ${n} works without an account.`)]);
    S.push(['What we collect', UL([
        '<b>Request logs.</b> Like every web server, ours record your IP address, browser type, the address requested and the time. We use them for security, rate limiting, debugging and aggregate traffic statistics.',
        '<b>Usage statistics.</b> First-party page views with a random session identifier, kept on our own servers, so we can see which parts of the network are used.',
        '<b>An anonymous page count.</b> The shared navigation bar reports one count per page load containing only the site\'s hostname and the day. No user, IP address or page is stored with it. It decides the order of sites in our menus. It is skipped when your browser sends Global Privacy Control or Do Not Track.',
        has(site, 'info') ? '' : `<b>Account information, if you sign in.</b> Your OpenVibe account is held by <a href="https://openvibe.network/privacy">openvibe.network</a>. ${has(site, 'account') ? 'See the next section.' : `${n} receives your user id, username, avatar and role so it can show you as signed in. It does not receive your password or your email address.`}`,
        has(site, 'account') ? '<b>Your account.</b> Username, email address, a salted hash of your password, profile and avatar, theme, display and notification preferences, push-notification subscriptions for devices where you switched them on, linked services and the basic profile they share, sign-in sessions, wallet balances and transactions, and your cross-site history while it is switched on.' : '',
        has(site, 'tools') ? '<b>What you give a tool.</b> Files, text, links, domain names and IP addresses you submit are processed to produce your result. Uploads and results are deleted automatically, normally within one hour for visitors and 24 hours for signed-in users. Files can contain hidden metadata such as location or author; the tools only read what they need, but consider removing it first.' : '',
        has(site, 'tools') ? '<b>Targets of network tools.</b> A lookup necessarily sends the domain or address you enter to third parties such as DNS servers, WHOIS and RDAP registries and the target itself. Downloaders fetch the link you give from its source on your behalf. Maps load tiles and search results from third-party map providers, which see your IP address and the area you view.' : '',
        has(site, 'streaming') ? '<b>Streams, clips, VODs and chat.</b> What you broadcast and write is stored so it can be shown, and is public unless you choose otherwise. Public streams and chat may be transcribed and summarised by AI services to create captions, highlights and overviews.' : '',
        has(site, 'streaming') ? '<b>Payments.</b> Payment processors handle card details; we receive a record of the transaction, not your card number.' : '',
        has(site, 'ugc') ? '<b>What you post.</b> Pastes, posts and comments, their visibility setting, and the account that made them. Public items are visible to everyone and may be indexed and archived by third parties. Unlisted items are visible to anyone with the link.' : '',
        has(site, 'hosting') ? '<b>Media.</b> Videos, clips, images, thumbnails and files, with technical metadata (size, duration, format), the site and account they came from, and view counts. Files may contain embedded metadata that becomes public with the file.' : '',
        has(site, 'games') ? '<b>Game data.</b> Characters, items, progress, world edits, canvas pixels and in-game chat, linked to your account or to a guest identifier stored in your browser.' : ''])]);
    S.push(['Why we use it', UL(['To provide the service you asked for and keep you signed in (performance of our agreement with you).', 'To keep the service secure, prevent abuse and understand usage in aggregate (our legitimate interests).', 'To send account email such as verification and password resets, and notifications you switched on (agreement and consent).', 'To comply with the law.'])]);
    S.push(['Cookies and storage in your browser', P(`We use a small number of first-party cookies: a sign-in token (<code>ov_token</code>), a refresh token limited to the sign-in paths, a short-lived state cookie during sign-in, and a hint (<code>ov_sso_hint</code>) that remembers whether you were signed in. openvibe.network also keeps a sign-in cookie that lets other OpenVibe sites check, in a hidden frame or through your browser's built-in federated sign-in, whether to sign you in quietly. It is never used for anything except that check.`,
        `Your theme, display settings (text size, reduced motion), recent pages, a cached copy of the navigation and similar conveniences are kept in your browser's local storage. There are no third-party advertising or social cookies. Our sites sit behind Cloudflare, which may set its own security cookies and measure performance.`)]);
    S.push(['Across OpenVibe sites', P(`OpenVibe sites share one account. When you are signed in, the site you visit learns who you are from openvibe.network. While cross-site history is switched on, the pages and tools you open while signed in are listed for you, and only you, at <a href="https://openvibe.network/history">openvibe.network/history</a>, where you can clear the list or pause it.`)]);
    S.push(['Who we share with', P(`Only the services needed to run the network: hosting (OVH, servers in the United States), network security and delivery (Cloudflare), object storage for media (Backblaze B2 or Cloudflare R2)${has(site, 'streaming') ? ', payment processors, AI providers used for transcription and summaries' : ''}, and email delivery for account messages. They process data on our instructions. We disclose information when the law requires it, and we tell the person affected when we are allowed to. If OpenVibe is ever reorganised or handed to new maintainers, the data moves under the same promises.`)]);
    S.push(['How long we keep things', UL(['Request logs and raw usage events: a limited rolling period, then totals only.', 'The anonymous page count: totals per site and day, nothing personal to delete.',
        has(site, 'tools') ? 'Tool uploads and results: one hour for visitors, 24 hours for signed-in users, temporary upload fragments about ten minutes.' : '',
        userContent(site) ? 'Content you post: until you delete it or your account, plus short-lived caches and backups.' : '',
        has(site, 'info') ? '' : 'Account data: until you delete your account. Backups expire on their own shortly afterwards. Records we must keep by law, such as payment records, are kept for the required period.'])]);
    S.push(['Where your data is', P(`Our servers are in the United States. If you use OpenVibe from elsewhere, your information is transferred to and processed in the United States, which may have different data protection rules from your country.`)]);
    S.push(['Security', P(`Traffic is encrypted in transit. Passwords are stored as salted hashes, sign-in tokens are signed and short-lived, and internal service routes are not reachable from the internet. No system is perfectly secure; if a breach affects your personal information we will tell you and the relevant authorities as the law requires.`)]);
    S.push(['Your choices and rights', P(`You can use most of ${n} without an account, block cookies, and switch on Global Privacy Control to skip the anonymous page count. With an account you can view, correct, export and delete your data from your account settings, or ask us to do it.`,
        `Depending on where you live, including the EEA, the UK and US states such as California, you may have rights to access, correct, delete, restrict or object to the use of your data, to data portability, and to complain to your data protection authority. We do not sell or share personal information as those laws define it, and we do not make automated decisions with legal effect. Write to <a href="mailto:${CONTACT}">${CONTACT}</a>; we answer within 30 days and will not treat you differently for asking.`)]);
    S.push(['Children', P(`${n} is not for children under 13, and we do not knowingly collect their information. If you believe a child has given us personal information, contact us and we will delete it.`)]);
    S.push(['Changes and contact', P(`We will post changes here and update the date above; significant changes are announced on the site. Questions and requests: <a href="mailto:${CONTACT}">${CONTACT}</a>.`)]);
    return S;
}

function dmca(site) {
    const n = esc(site.name), host = esc(site.host);
    const S = [];
    const position = has(site, 'tools') ? ` The tools here process material at a user's request and do not keep a library of it: uploads and results are deleted automatically within hours, and downloaders neither host nor index what they fetch. If the material you are concerned about lives on another platform, a notice to that platform removes it at the source.`
        : has(site, 'info') ? ` ${n} currently publishes only its own material and does not host uploads from the public.`
        : has(site, 'hosting') ? ` ${n} stores media for other OpenVibe sites. Removing an item here removes it from the sites that embed it.`
        : has(site, 'account') ? ` ${n} hosts account profiles, avatars and published themes; content on the other OpenVibe sites is handled by the notice process on those sites.` : '';
    S.push(['Our position', P(`${n} respects copyright and responds to clear notices of alleged infringement under the Digital Millennium Copyright Act (17 U.S.C. § 512).${position}`)]);
    S.push(['Before you send a notice', P(`Consider whether the use is permitted, for example as fair use, commentary, criticism, or under a licence. Notices must come from the copyright owner or someone authorised to act for them. Misrepresentations in a notice carry legal liability.`)]);
    S.push(['Send a takedown notice', P(`Email <a href="mailto:${CONTACT}">${CONTACT}</a> with all of the following:`) + `<ol><li>Your name, postal address, phone number and email address, and whom you represent.</li><li>The copyrighted work you say was infringed, or a representative list if there are several.</li><li>The exact URL on ${host} of each item you want removed. General descriptions, search results and channel links are not enough to find it.</li><li>A statement that you have a good-faith belief the use is not authorised by the copyright owner, its agent or the law.</li><li>A statement, under penalty of perjury, that the information is accurate and that you are the owner or authorised to act for the owner.</li><li>Your physical or electronic signature.</li></ol>`]);
    S.push(['What happens next', P(`We remove or disable access to the material, tell the person who posted it, and give them a copy of your notice, including your contact details. We act on complete notices as quickly as we can, normally within a few business days. Incomplete notices get a reply saying what is missing.${userContent(site) ? ' Copies held in caches and in third-party archives are outside our control and expire or must be requested separately.' : ''}`)]);
    if (!has(site, 'info', 'tools')) S.push(['Counter-notice', P(`If your material was removed by mistake or misidentification, send a counter-notice to the same address with: your name, address, phone number and email; the material and where it appeared before removal; a statement under penalty of perjury that you believe in good faith it was removed by mistake or misidentification; your consent to the jurisdiction of the federal district court for your address (or for Washington State if you are outside the United States) and to accept service from the complainant; and your signature.`,
        `We forward the counter-notice to the complainant and may restore the material after 10 to 14 business days unless they tell us they have filed a court action.`)]);
    S.push(['Repeat infringers and false claims', P(`Accounts that receive repeated valid notices lose the ability to post and, in appropriate circumstances, are terminated across the network. Knowingly false notices and counter-notices carry liability under § 512(f); we refuse notices that are clearly abusive or automated without review.`)]);
    S.push(['Other complaints', P(`Trademark, privacy, impersonation, harassment and other non-copyright complaints go to the same address; say which kind of complaint it is and give the exact URL. Content that sexually exploits children should be reported to us immediately and to the <a href="https://report.cybertip.org/" rel="noopener">NCMEC CyberTipline</a> or your national hotline; we remove it and report it to the authorities.`)]);
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
<nav class="ov-legal-toc" aria-label="On this page"><ol>${d.sections.map(([h], i) => `<li><a href="#s${i + 1}">${esc(h)}</a></li>`).join('')}</ol></nav>
${d.sections.map(([h, html], i) => `<section><h2 id="s${i + 1}">${esc(h)}</h2>${html}</section>`).join('\n')}
<nav class="ov-legal-more" aria-label="Other policies">${others.map(k => `<a href="/${k}">${esc(TITLES[k])}</a>`).join('')}<a href="https://openvibe.network/">About OpenVibe</a></nav></article>`;
}

const CSS = `*{box-sizing:border-box}body{margin:0;background:var(--bg-primary,#0a0f18);color:var(--text-primary,#e6edf7);font:400 16px/1.65 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.ov-legal{max-width:760px;margin:0 auto;padding:40px 20px 24px}.ov-legal-kicker{margin:0;font-size:13px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--accent-light,var(--accent,#60a5fa))}
.ov-legal h1{font-size:clamp(28px,4.5vw,40px);letter-spacing:-.03em;line-height:1.1;margin:6px 0 4px}.ov-legal-date{color:var(--text-muted,#7d8aa0);font-size:14px;margin:0 0 28px}
.ov-legal-toc{margin:0 0 8px;padding:14px 18px;border:1px solid var(--border,rgba(255,255,255,.1));border-radius:12px;background:var(--bg-secondary,#111826)}.ov-legal-toc ol{margin:0;padding-left:20px;columns:2 220px;column-gap:28px}.ov-legal-toc li{margin:3px 0;font-size:14px;break-inside:avoid}.ov-legal-toc a{text-decoration:none}.ov-legal section{scroll-margin-top:80px}
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
<script src="https://openvibe.network/shared/theme-loader.js" defer></script><style>${CSS}</style></head><body>
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
