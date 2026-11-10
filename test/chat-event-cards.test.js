'use strict';
// Go-live and Rundown notices in chat are event cards (public/js/chat.js _chatEventOf / renderChatEventCard;
// 2026-11-07, the owner: "improve how these go live chat notifications look and add timestamp ... styled like the
// rest of chat"). What this proves:
//   - Live's go-live row (metadata.kind live_link) and an old text-only row both become a 'live' event with the name
//     and the stream URL; a Rundown row becomes a 'rundown' event with the name, title and episode URL;
//   - only an OpenVibe address is ever a link (a row naming another site is left as plain text);
//   - other system rows (deploys, bans, plain notes) are not events;
//   - the card is built from DOM nodes (no innerHTML of the name or title), shows the time with the viewer's setting,
//     and folds the same person going live again within 15 minutes.
//   node test/chat-event-cards.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
const start = src.indexOf('const _CHAT_EV_LIVE_RE');
const end = src.indexOf('function _chatEvCss(');
assert.ok(start > 0 && end > start, 'the event code is in chat.js');
const window = { location: { origin: 'https://openvibe.live' } };
const { _chatEventOf } = new Function('window', `${src.slice(start, end)}; return { _chatEventOf };`)(window);

const live = _chatEventOf({ id: 7, message_type: 'system', message: '\u{1F534} moosely is live. Share the stream: https://openvibe.live/@moosely',
    metadata: JSON.stringify({ kind: 'live_link', url: 'https://openvibe.live/@moosely' }), timestamp: '2026-11-07T09:03:00Z' });
assert.deepStrictEqual({ kind: live.kind, name: live.name, url: live.url, key: live.key },
    { kind: 'live', name: 'moosely', url: 'https://openvibe.live/@moosely', key: 'live:moosely' });

const old = _chatEventOf({ message_type: 'system', message: '\u{1F534} AmberFieraGames37 is live. Share the stream: https://openvibe.live/@AmberFieraGames37' });
assert.strictEqual(old.kind, 'live'); assert.strictEqual(old.name, 'AmberFieraGames37');

const fromMeta = _chatEventOf({ message_type: 'system', message: 'something else', metadata: { kind: 'live_link', url: 'https://openvibe.live/@iZoR_One' } });
assert.strictEqual(fromMeta.name, 'iZoR_One', 'the name comes from the link when the text is not the usual one');

const rd = _chatEventOf({ message_type: 'system', message: '\u{1F4F0} goosely: “Second McDoanld\'s Run: Bug Fix Later” → https://openvibe.live/rundown/e/2891',
    metadata: { rundown_episode: 2891, url: 'https://openvibe.live/rundown/e/2891' } });
assert.deepStrictEqual({ kind: rd.kind, name: rd.name, title: rd.title, url: rd.url },
    { kind: 'rundown', name: 'goosely', title: "Second McDoanld's Run: Bug Fix Later", url: 'https://openvibe.live/rundown/e/2891' });

assert.strictEqual(_chatEventOf({ message_type: 'system', message: '\u{1F534} x is live. Share the stream: https://evil.example/@x' }), null, 'never a link to another site');
assert.strictEqual(_chatEventOf({ message_type: 'system', message: '\u{1F534} x is live. Share the stream: javascript:alert(1)' }), null);
assert.strictEqual(_chatEventOf({ message_type: 'system', message: '🚀 1 update shipped' }), null, 'a deploy row is not an event');
assert.strictEqual(_chatEventOf({ message_type: 'chat', message: '\u{1F534} me is live. Share the stream: https://openvibe.live/@me' }), null, 'a person typing the words is just chat');

// The card: DOM nodes only, the viewer's timestamp setting, the 15-minute fold.
const card = src.slice(src.indexOf('function renderChatEventCard('), src.indexOf('/* ── Deploy notices'));
assert.ok(!/innerHTML\s*=\s*[^;]*ev\.(name|title)/.test(card), 'the name and title never go through innerHTML');
assert.ok(/who\.textContent = ev\.name/.test(card) && /title\.textContent = `“\$\{ev\.title\}”`/.test(card), 'they are text nodes');
assert.ok(/showTime = !!opts\.isGlobal \|\| !!chatSettings\.showTimestamps/.test(card), 'time: global always, elsewhere the viewer\'s setting');
assert.ok(/_CHAT_EV_FOLD_MS/.test(card) && /went live again/.test(card), 'the same person within 15 minutes updates the card');
assert.ok(!/prefers-reduced-motion/.test(src.slice(src.indexOf('function _chatEvCss('), src.indexOf('function _chatEvTime('))), 'Calm plays the cards (openvibe-shared 4.183.0); only motion off stops them, by the loader\'s one rule');
console.log('chat event cards: ok');
