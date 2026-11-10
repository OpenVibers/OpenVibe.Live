'use strict';
/**
 * A card that opens /@name is named by its @handle (the owner, 2026-11-10): the offline
 * discover board's live cards, star card and "Streamers to check out" rows. Display names
 * alone would read as someone else's name while the address says @username.
 *
 *   node test/at-handle.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync(require('node:path').join(__dirname, '../public/js/context-cards.js'), 'utf8');
const { document } = parseHTML('<div id="ch-discover"></div>');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fixture = {
    channel: null,
    live: [{ username: 'alice', display_name: 'Alice Display', title: 'Night shoot', viewer_count: 7, thumbnail_url: null, avatar_url: null, profile_color: null }],
    clips: [],
    star: { username: 'starly', display_name: 'Star Display', headline: 'Still here', reason: 'Every day', live: false, avatar_url: null, profile_color: null },
    recaps: [],
    similar: [{ username: 'bob', display_name: 'Bob Display', followers: 3, live: false, last_live_at: null, avatar_url: null, profile_color: null }],
};
const context = {
    document,
    window: {},
    esc,
    timeAgo: () => '2h ago',
    ovImgW: null,
    videoHref: (kind, id) => `/${kind}/${id}`,
    handleLinkClick: () => true,
    api: async () => fixture,
    encodeURIComponent,
    Number, String, JSON, Promise,
};
context.window = context;
vm.createContext(context);
vm.runInContext(source, context);

(async () => {
const host = document.getElementById('ch-discover');
await context.window.renderOfflineDiscover('x', host);
const html = host.innerHTML;
for (const handle of ['@alice', '@starly', '@bob']) {
    assert.ok(html.includes(`<b>${handle}</b>`), `a card names the channel ${handle}`);
}
assert.ok(!html.includes('Alice Display') && !html.includes('Star Display') && !html.includes('Bob Display'), 'no bare display name names a channel');
process.stdout.write('at-handle (discover board): all checks passed\n');
})().catch((err) => { console.error(err); process.exit(1); });
