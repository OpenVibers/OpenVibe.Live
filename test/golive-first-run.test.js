'use strict';
/**
 * Go Live with no streams yet (a new streamer's first visit). It used to say "Check the card, press Go live" with no
 * card on the page, offered two buttons that did the same thing ("New slot" and "Create stream slot") and explained the
 * word "slot" instead of going live (signed-in sweep, 2026-11-09). Now one card leads with going live from the browser
 * (one press makes a browser stream and opens its card), OBS and other apps get the full form with RTMP picked, the
 * slot row stays empty, and the line under Go Live says what to do first.
 *
 *   node test/golive-first-run.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/fragments/broadcast.html'), 'utf8');
const ws = fs.readFileSync(path.join(root, 'public/js/broadcast-workspace.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/features/broadcast.css'), 'utf8');

// The card: going live from the browser first, apps second; no "slot" lecture, no second create button.
const empty = html.slice(html.indexOf('id="bc-ws-empty"'), html.indexOf('id="bc-ws-panel"'));
assert.ok(empty.includes('Your first stream'), 'the first-run card names what it is');
assert.ok(/onclick="wsFirstBrowserStream\(this\)"[^>]*>[\s\S]*?Go live from this browser/.test(empty), 'the browser is the main action');
assert.ok(/onclick="wsFirstAppStream\(\)"[^>]*>[\s\S]*?Use OBS or another app/.test(empty), 'apps are the second action');
assert.ok(empty.indexOf('wsFirstBrowserStream') < empty.indexOf('wsFirstAppStream'), 'the browser comes first');
assert.ok(!/Create stream slot|A slot is one stream/.test(empty), 'no second create button and no slot lecture');
assert.ok(/no OBS, no download, no follower minimum/.test(empty), 'the headline promise is on the card');
assert.ok(html.includes('id="bc-page-subtitle"'), 'the line under Go Live can change with the state');

// One press: a browser stream (WebRTC), then its card opens (onManagedStreamCreated selects it).
const first = ws.slice(ws.indexOf('async function wsFirstBrowserStream'), ws.indexOf('function wsFirstAppStream'));
assert.ok(/streaming_method: 'browser'/.test(first) && /protocol: 'webrtc'/.test(first), 'a browser stream is made');
assert.ok(/onManagedStreamCreated\(data\.managed_stream\.id\)/.test(first), 'and its card opens');
assert.ok(/if \(!currentUser\)/.test(first), 'a guest gets the sign-in gate, not a 401');
assert.ok(/btn\.disabled = true/.test(first) && /btn\.disabled = false/.test(first), 'no double press makes two streams');
const app = ws.slice(ws.indexOf('function wsFirstAppStream'), ws.indexOf('function wsFirstAppStream') + 300);
assert.ok(/showCreateManagedStreamModal\(\)/.test(app) && /_cmsSelectMethod\('rtmp'\)/.test(app), 'apps open the form with RTMP picked');

// No streams: the slot row is empty (the card has the ways to start); with streams, New slot is at the end of the row.
const side = ws.slice(ws.indexOf('function _wsRenderSidebar'), ws.indexOf('function _wsRenderSidebar') + 1800);
assert.ok(/managedStreams\.length === 0\) \{\s*list\.innerHTML = '';/.test(side), 'no New slot pill beside the first-run card');
assert.ok(/\}\)\.join\(''\) \+ add;/.test(side), 'New slot still ends the row once streams exist');

// The subtitle: what to do first while there is no card, the card line back once a card shows.
const showEmpty = ws.slice(ws.indexOf('function _wsShowEmpty'), ws.indexOf('function _wsSubtitle'));
assert.ok(/Make your first stream, then press Go live on its card\./.test(showEmpty), 'the first-run line');
const renderPanel = ws.slice(ws.indexOf('function _wsRenderPanel'), ws.indexOf('function _wsRenderPanel') + 600);
assert.ok(/_wsSubtitle\(null\)/.test(renderPanel), 'a shown card restores the card line');

// Phone: both buttons full width and 44 px tall.
assert.ok(/\.bc-first-actions \.btn \{ min-height: 44px;/.test(css), '44 px buttons');
assert.ok(/@media \(max-width: 480px\) \{[^}]*\.bc-ws-empty[^}]*\}[^}]*\.bc-first-actions \.btn \{ flex: 1 1 100%; \}/.test(css), 'full width on a phone');

console.log('go live first run: one card, the browser first, apps second, no duplicate create button');
