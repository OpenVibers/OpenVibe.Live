'use strict';

/**
 * The go-live setup is one screen (owner, 2026-10-31: "this layout ain't too great… more intelligent… more modular"):
 * the slots are pills, the ready card comes first (title, chips, devices, what viewers get, Go live), and every other
 * setting is a fold whose line says what it holds. Nothing the old Stream / Settings / Endpoint / History tabs had is
 * lost: every field they rendered is still rendered, by the same id. Changes save as they are made.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ws = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast-workspace.js'), 'utf8');
const frag = fs.readFileSync(path.join(__dirname, '..', 'public', 'fragments', 'broadcast.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'features', 'broadcast.css'), 'utf8');
const start = ws.indexOf('function _wsRenderPanel()');
const panel = ws.slice(start, ws.indexOf('\n}\n', start));

// Every field of the old tabs, by id: Stream (title … quality), Go live (devices, button), Settings (PiP, restreams,
// overlay, PowerChat, AI viewers, recording, weather), Endpoint (key, method endpoint) and History.
const FIELDS = [
    'bc-title', 'bc-description', 'bc-nsfw', 'bc-slug',
    'bc-ws-method-picker', 'bc-ws-browser-mode-picker', 'bc-ws-mic-image',
    'bc-ws-screen-mic', 'bc-ws-screen-mic-select', 'bc-ws-screen-sysaudio', 'bc-ws-screen-cam', 'bc-ws-screen-cam-select',
    'bc-ws-screen-cam-mode', 'bc-ws-screen-pip-pos', 'bc-ws-screen-pip-size',
    'bc-ws-screen-resolution', 'bc-ws-screen-fps', 'bc-ws-screen-bitrate',
    'bc-ws-resolution', 'bc-ws-fps', 'bc-ws-bitrate', 'bc-ws-battery-saver',
    'bc-create-camera', 'bc-create-audio', 'bc-ws-golive-btn', 'bc-ws-golive-section',
    'bc-ws-pip-list', 'bc-ws-pip-add', 'bc-ws-restream-list', 'bc-ws-overlay-url',
    'bc-ws-powerchat-relay', 'bc-ws-powerchat-rs-views', 'bc-ws-aiv',
    'bc-ws-vod-recording', 'bc-ws-clip-recording', 'bc-ws-clip-notify', 'bc-ws-vod-visibility', 'bc-ws-clip-visibility',
    'bc-ws-weather-zip', 'bc-ws-weather-detail', 'bc-ws-weather-location',
    'bc-ws-stream-key', 'bc-ws-method-endpoint', 'bc-ws-history-list', 'bc-managed-stream',
];
for (const id of FIELDS) assert.ok(panel.includes(`id="${id}"`), `the setup still renders #${id}`);
// The endpoint block is one template, placed in the card (an encoder's slot) or in a fold (a browser slot): never twice.
assert.strictEqual((panel.match(/id="bc-ws-stream-key"/g) || []).length, 1, 'the key field is written once');
assert.ok(/const endpoint = `/.test(panel) && /\$\{endpoint\}/.test(panel), 'the endpoint goes where the method needs it');

// One screen: no tabs; the card first, then the folds.
assert.ok(!panel.includes('data-wstab') && !panel.includes('bc-ws-tab-panel'), 'no tabs');
const card = panel.indexOf('<section class="gl-card');
const folds = panel.indexOf('<div class="gl-folds">');
assert.ok(card > 0 && folds > card, 'the ready card, then the folds');
assert.ok(panel.indexOf('id="bc-title"') > card && panel.indexOf('id="bc-title"') < folds, 'the title is in the card');
assert.ok(panel.indexOf('${_wsPreflight(browserMode)}') > card && panel.indexOf('${_wsPreflight(browserMode)}') < folds, 'what viewers get is in the card');

// Every fold's line says what it holds (L25: a fold shows its count or summary).
const foldCount = (panel.match(/<details class="gl-fold/g) || []).length;
assert.ok(foldCount >= 12, `the settings are folds (${foldCount})`);
for (const m of panel.matchAll(/<details class="gl-fold[^>]*>\s*<summary>([\s\S]*?)<\/summary>/g)) {
    assert.ok(/class="bc-sum-val"/.test(m[1]), `a fold's line has a value: ${m[1].slice(0, 120)}`);
}
for (const id of ['gl-details-sum', 'gl-how-sum', 'gl-rs-sum', 'gl-pip-sum', 'gl-rec-sum', 'gl-weather-sum', 'gl-hist-sum']) {
    assert.ok(panel.includes(`id="${id}"`), `#${id} is in the panel`);
    assert.ok(ws.includes(`'${id}'`), `#${id} is kept current`);
}

// The chips say what is set and act in place.
for (const chip of ['id="gl-mature-v"', 'id="gl-link"', 'id="gl-rs-v"', '_wsOpenPopoutChat()']) assert.ok(panel.includes(chip), chip);

// Saving as you type: no save bar and no "unsaved changes" question; switching slots or going live saves first.
assert.ok(/function _wsMarkDirty\(\)[\s\S]{0,400}_wsAutoSaveTimer = setTimeout/.test(ws), 'a change saves after a short pause');
const select = ws.slice(ws.indexOf('async function wsSelectStream('), ws.indexOf('async function _wsSelectStream('));
assert.ok(select.includes('await _wsFlushSave()') && !select.includes('_wsConfirmUnsaved'), 'switching slots saves, never asks');
const golive = ws.slice(ws.indexOf('async function goLiveFromWorkspace('), ws.indexOf('function updateWorkspaceLiveStatus('));
assert.ok(golive.includes('await _wsFlushSave()') && !golive.includes('_wsConfirmUnsaved'), 'going live saves first, never asks');
assert.ok(/if \(\(_wsState\.rev \|\| 0\) === rev\) _wsState\.dirty = false/.test(ws), 'a change made while saving is not lost');

// The slots are pills, with New slot at the end; nothing spins while the page loads.
assert.ok(/class="gl-slot\$\{isSelected/.test(ws) && ws.includes('gl-slot--add'), 'slot pills');
assert.ok(frag.includes('class="bc-ws-sidebar gl-slots"') && !frag.includes('bc-ws-sidebar-hd'), 'the fragment has the pill row');
assert.ok(!panel.includes('fa-spin') && !frag.slice(frag.indexOf('bc-ws-list'), frag.indexOf('bc-ws-main')).includes('fa-spin'), 'no spinning ring');

// Wide screens: two columns, the card sticky; phones: 44 px targets.
assert.ok(/@container bcws \(min-width: 900px\) \{\s*\.gl \{ grid-template-columns/.test(css), 'two columns on a wide screen');
assert.ok(/@media \(pointer: coarse\) \{ \.gl-chip \{ min-height: 44px; \} \}/.test(css), 'chips are thumb-sized on touch');

console.log('golive-setup: all passed');
