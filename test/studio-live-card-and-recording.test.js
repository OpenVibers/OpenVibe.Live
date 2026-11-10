'use strict';
// moosely's phone studio (11-08): her own "is live" chat card sat over the picture, its Watch button and copy link
// crushing "is live" to a letter per line; the self-view stayed paused under the browser's play button after the phone
// paused it; and deleting the recording of a test stream "wasn't immediately obvious". What this proves:
//   - a live card about the page you are on (your own studio, or the channel you are watching) is a quiet line with no
//     Watch button ("You went live" for the streamer); anywhere else it keeps its buttons;
//   - in a chat narrower than 240px the card's buttons go under its text instead of beside it;
//   - the phone studio starts its self-view again when it finds it paused;
//   - "Your last streams" offers Delete beside Replay (DELETE /api/vods/:id, after a confirm), says when a recording is
//     still saving, and lists the stream just ended again a few seconds after it ends; the dashboard's delete is labelled.
//   node test/studio-live-card-and-recording.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

const chat = read('js/chat.js');
const isHereSrc = chat.slice(chat.indexOf('function _chatEvIsHere('), chat.indexOf('function renderChatEventCard('));
assert.ok(isHereSrc.length > 50, '_chatEvIsHere is in chat.js');
function isHere({ path: p, studioActive = false, me = 'moosely' }, name) {
    const document = { querySelector: (q) => (q === '#page-broadcast.active' && studioActive ? {} : null) };
    const location = { pathname: p };
    const currentUser = me ? { username: me } : null;
    return new Function('document', 'location', 'currentUser', `${isHereSrc}; return _chatEvIsHere;`)(document, location, currentUser)({ name });
}
assert.deepStrictEqual(isHere({ path: '/@moosely/studio' }, 'moosely'), { mine: true }, 'the streamer in her own studio');
assert.deepStrictEqual(isHere({ path: '/broadcast', studioActive: true }, 'Moosely'), { mine: true }, 'the broadcast desk, any case');
assert.deepStrictEqual(isHere({ path: '/@moosely', me: 'someone' }, 'moosely'), { mine: false }, 'a viewer on that channel');
assert.strictEqual(isHere({ path: '/@goosely', me: 'someone' }, 'moosely'), null, 'another channel keeps the full card');
assert.strictEqual(isHere({ path: '/', me: 'someone' }, 'moosely'), null, 'the home or global chat keeps the full card');
assert.strictEqual(isHere({ path: '/@moosely/studio' }, 'goosely'), null, 'someone else going live, seen from my studio');

const card = chat.slice(chat.indexOf('function renderChatEventCard('), chat.indexOf('/* ── Deploy notices'));
assert.ok(/const here = ev\.kind === 'live' && _chatEvIsHere\(ev\)/.test(card), 'the card asks where it is');
assert.ok(card.includes("what.textContent = 'You went live'"), 'the streamer reads "You went live"');
assert.ok(/if \(here\) el\.append\(icon, body\);\s*else el\.append\(icon, body, acts\);/.test(card), 'no Watch button or copy link here');
const css = chat.slice(chat.indexOf('function _chatEvCss('), chat.indexOf('function _chatEvTime('));
assert.ok(/@container \(max-width:260px\)\{\.chat-ev-cta\{padding:0;width:28px;/.test(css), 'narrow: the button is its icon alone, the words keep the row');

const studio = read('js/broadcast-studio.js');
assert.ok(/if \(pv && pv\.paused && pv\.srcObject && pv\.style\.display !== 'none'\) pv\.play\(\)\.catch\(\(\) => \{\}\);/.test(studio), 'a paused self-view plays again');

const bc = read('js/broadcast.js');
const ended = bc.slice(bc.indexOf('function _renderEndedStream('), bc.indexOf('/** Delete a recording from'));
assert.ok(/class="bc-last-delete"/.test(ended) && /Replay<\/a><button/.test(ended), 'Delete sits beside Replay');
assert.ok(/saving the recording…/.test(ended), 'a recording still being saved says so');
assert.ok(/await api\(`\/vods\/\$\{encodeURIComponent\(id\)\}`, \{ method: 'DELETE' \}\)/.test(bc) && /if \(!confirm\(/.test(bc.slice(bc.indexOf('async function bcDeleteRecording('))), 'it asks, then deletes');
assert.strictEqual((bc.match(/_bcRefreshEndedSoon\(\); toast\('Stream ended\. Its recording shows under Your last streams/g) || []).length, 2, 'both ways of ending list the stream again soon');
assert.ok(/\.bc-last-delete \{/.test(read('css/features/broadcast.css')), 'it is styled');
assert.ok(/onclick="deleteVod\('\$\{v\.id\}'\)" aria-label="Delete [^"]+"><i class="fa-solid fa-trash-can" aria-hidden="true"><\/i> Delete<\/button>/.test(read('js/dashboard.js')), 'the dashboard says Delete');
console.log('studio: no self "is live" card in the way, the self-view plays, and a recording is one Delete away');
