'use strict';
/**
 * Channel social links (server/social/): validation of saved links, the merge with connected restream platforms,
 * and the preview adapters (Bluesky posts, Twitch live status, OpenGraph fallback, bare link on failure), with the
 * egress fetch stubbed. Also: previews never take a URL from the request (only a channel's own links).
 */
const assert = require('assert');
const egress = require('../server/net/egress');
const { cleanSocialLinks, cleanLink, channelSocialLinks } = require('../server/social/links');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

(async () => {
    await check('links: handles and URLs become canonical https links; wrong hosts, http-only tricks and junk are refused', async () => {
        assert.deepStrictEqual(cleanLink({ kind: 'x', handle: '@OpenVibe' }), { kind: 'x', url: 'https://x.com/OpenVibe', handle: 'OpenVibe', label: '', preview: true });
        assert.strictEqual(cleanLink({ kind: 'twitch', url: 'https://www.twitch.tv/goosely/' }).handle, 'goosely');
        assert.strictEqual(cleanLink({ kind: 'custom', url: 'https://twitter.com/someone' }).kind, 'x', 'a pasted URL finds its platform');
        assert.strictEqual(cleanLink({ kind: 'bluesky', handle: 'alice.bsky.social' }).url, 'https://bsky.app/profile/alice.bsky.social');
        assert.strictEqual(cleanLink({ kind: 'twitch', url: 'https://evil.example/twitch' }), null, 'a platform link must point at the platform');
        assert.strictEqual(cleanLink({ kind: 'custom', url: 'javascript:alert(1)' }), null);
        assert.strictEqual(cleanLink({ kind: 'custom', url: 'https://user:pw@example.com/' }), null);
        assert.strictEqual(cleanLink({ kind: 'website', url: 'example.com/shop' }).url, 'https://example.com/shop');
        assert.strictEqual(cleanLink({ kind: 'custom', url: 'http://example.com' }).url, 'https://example.com', 'upgraded to https');
        const stored = JSON.parse(cleanSocialLinks({ links: [{ kind: 'x', handle: 'a' }, { kind: 'x', url: 'https://x.com/a' }, { kind: 'custom', url: 'nope' }], hidden_auto: ['twitch', 'root'] }));
        assert.strictEqual(stored.links.length, 1, 'duplicates and invalid links dropped');
        assert.deepStrictEqual(stored.hidden_auto, ['twitch']);
        assert.strictEqual(cleanSocialLinks('not a list'), null);
    });

    await check('merge: saved links first, then connected Twitch/YouTube/Kick not already listed and not hidden; editors see what is missing', async () => {
        const db = {
            all(sql) {
                if (/platform_connections/.test(sql)) return [{ platform: 'twitch', platform_username: 'goosely', channel_url: 'https://www.twitch.tv/goosely' }, { platform: 'kick', platform_username: 'goosely', channel_url: null }];
                if (/restream_destinations/.test(sql)) return [{ platform: 'twitch' }, { platform: 'youtube' }];
                return [];
            },
        };
        const channel = { user_id: 1, social_links: cleanSocialLinks({ links: [{ kind: 'x', handle: 'goosely' }], hidden_auto: ['kick'] }) };
        const viewer = await channelSocialLinks(channel, db);
        assert.deepStrictEqual(viewer.links.map((l) => [l.kind, !!l.auto]), [['x', false], ['twitch', true]]);
        assert.ok(viewer.links[0].icon && viewer.links[0].color);
        assert.strictEqual(viewer.connected, undefined, 'viewers get no editor data');
        const owner = await channelSocialLinks(channel, db, { owner: true });
        assert.deepStrictEqual(owner.restreams_without_link, ['youtube']);
        assert.deepStrictEqual(owner.connected.map((c) => [c.kind, c.hidden]), [['twitch', false], ['kick', true]]);
    });

    await check('the OpenVibe profile: every channel shows openvibe.network/@username after its other links, unless listed or hidden', async () => {
        const db = { all: () => [] };
        const shown = await channelSocialLinks({ user_id: 1, username: 'Goosely', social_links: cleanSocialLinks({ links: [{ kind: 'x', handle: 'goosely' }] }) }, db, { owner: true });
        assert.deepStrictEqual(shown.links.map((l) => [l.kind, l.url, !!l.auto]), [['x', 'https://x.com/goosely', false], ['openvibe', 'https://openvibe.network/@Goosely', true]]);
        assert.deepStrictEqual(shown.connected.map((c) => [c.kind, c.hidden]), [['openvibe', false]], 'the editor can hide it');
        const hidden = await channelSocialLinks({ user_id: 1, username: 'Goosely', social_links: cleanSocialLinks({ links: [], hidden_auto: ['openvibe'] }) }, db);
        assert.deepStrictEqual(hidden.links, []);
        const listed = await channelSocialLinks({ user_id: 1, username: 'Goosely', social_links: cleanSocialLinks({ links: [{ kind: 'custom', url: 'https://openvibe.network/@Goosely' }] }) }, db);
        assert.deepStrictEqual(listed.links.map((l) => [l.kind, !!l.auto]), [['openvibe', false]], 'listed by hand: once');
        assert.strictEqual(cleanLink({ kind: 'openvibe', url: 'https://evil.example/@x' }), null);
    });

    await check('the OpenVibe profile preview: the Network\'s profile API, the picture, item count and what they wear; a private one says so', async () => {
        const { preview: pv } = require('../server/social/preview');
        const realFetch = global.fetch;
        const seen = [];
        global.fetch = async (url) => {
            seen.push(String(url));
            const name = decodeURIComponent(String(url).split('/').pop());
            if (name === 'Goosely') return { ok: true, json: async () => ({ profile: { username: 'Goosely', display_name: 'Goosely', avatar_url: 'https://openvibe.network/avatar/Goosely?s=160', private: false, member_since: '2025-03-14', items: { count: 12, more: false }, showcase: [{ name: 'Void Crown', rarity: 'legendary', kind_name: 'Hat', art: { emoji: '🕳️' }, url: 'https://inventory.openvibe.network/items/itd_1' }] } }) };
            if (name === 'quiet') return { ok: true, json: async () => ({ profile: { username: 'quiet', display_name: 'Quiet', avatar_url: 'https://openvibe.network/avatar/quiet?s=160', private: true } }) };
            return { ok: false, status: 404, json: async () => ({}) };
        };
        try {
            const p = await pv(cleanLink({ kind: 'openvibe', handle: 'Goosely' }));
            assert.ok(seen[0].endsWith('/api/v1/profiles/Goosely') && seen[0].startsWith('http://127.0.0.1:4000'), 'loopback Network, fixed path');
            assert.deepStrictEqual([p.title, p.subtitle, p.image], ['Goosely', '12 items · on OpenVibe since 2025', 'https://openvibe.network/avatar/Goosely?s=160']);
            assert.deepStrictEqual(p.items, [{ text: '🕳️ Wearing Void Crown (Legendary hat)', url: 'https://inventory.openvibe.network/items/itd_1' }]);
            const q = await pv(cleanLink({ kind: 'openvibe', handle: 'quiet' }));
            assert.deepStrictEqual([q.title, q.subtitle, q.items], ['Quiet', 'Profile on OpenVibe', []]);
        } finally { global.fetch = realFetch; }
    });

    const { preview, _cache } = require('../server/social/preview');
    const real = { fetchText: egress.fetchText, fetchBuffer: egress.fetchBuffer };
    const calls = [];
    egress.fetchText = async (url) => {
        calls.push(url);
        if (url.includes('getProfile')) return { status: 200, url, headers: {}, text: JSON.stringify({ handle: 'alice.bsky.social', displayName: 'Alice', followersCount: 1200, postsCount: 30, avatar: 'https://cdn.bsky.app/a.jpg' }) };
        if (url.includes('getAuthorFeed')) return { status: 200, url, headers: {}, text: JSON.stringify({ feed: [{ post: { uri: 'at://did/app.bsky.feed.post/3k1', indexedAt: '2026-09-28T10:00:00Z', record: { text: 'Going live at 8 &lt;3' } } }] }) };
        if (url.includes('twitch.tv')) return { status: 200, url, headers: {}, text: '<meta property="og:title" content="goosely - Twitch"><meta property="og:image" content="https://static.twitch.tv/x.png">' };
        if (url.includes('shop.example')) return { status: 200, url, headers: {}, text: '<title>My shop</title><meta name="description" content="Stickers &amp; shirts">' };
        return { status: 503, url, headers: {}, text: '' };
    };
    egress.fetchBuffer = async (url) => ({ status: 200, url: url.includes('goosely') ? url : 'https://static-cdn.jtvnw.net/ttv-static/404_preview-440x248.jpg', headers: {}, body: Buffer.alloc(0) });
    try {
        await check('previews: Bluesky profile and latest posts; Twitch live from the preview image; OpenGraph for a custom link', async () => {
            const b = await preview(cleanLink({ kind: 'bluesky', handle: 'alice.bsky.social' }));
            assert.strictEqual(b.title, 'Alice');
            assert.match(b.subtitle, /1,200 followers/);
            assert.deepStrictEqual(b.items.map((i) => [i.text, i.url]), [['Going live at 8 <3', 'https://bsky.app/profile/alice.bsky.social/post/3k1']]);
            const t = await preview(cleanLink({ kind: 'twitch', handle: 'goosely' }));
            assert.strictEqual(t.live.live, true);
            const off = await preview(cleanLink({ kind: 'twitch', handle: 'sleepy' }));
            assert.strictEqual(off.live.live, false, 'the placeholder image means offline');
            const c = await preview(cleanLink({ kind: 'custom', url: 'https://shop.example/' }));
            assert.deepStrictEqual([c.title, c.subtitle], ['My shop', 'Stickers & shirts']);
        });
        await check('previews: an unavailable platform falls back to its page, else a bare link; answers are cached', async () => {
            const n = calls.length;
            const g = await preview(cleanLink({ kind: 'github', handle: 'nobody' }));
            assert.strictEqual(g.error, 'unavailable');
            await preview(cleanLink({ kind: 'bluesky', handle: 'alice.bsky.social' }));
            assert.ok(calls.slice(n).every((u) => !u.includes('bsky')), 'the Bluesky preview came from the cache');
            assert.ok(_cache.size >= 4);
        });
    } finally { Object.assign(egress, real); }

    await check('the preview route addresses a channel\'s own link by position, never a URL from the request', async () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'social', 'routes.js'), 'utf8');
        assert.ok(/\/preview\/:username\/:index/.test(src));
        assert.ok(!/req\.query\.url/.test(src));
    });
    console.log(`social-links: ${passed} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
