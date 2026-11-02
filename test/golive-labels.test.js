'use strict';

/**
 * Labels on the go-live card (L1, with Live #477's API): a chip in the row and a fold with the six labels as toggles;
 * the AI's suggestions are offered to confirm, never applied by themselves; the save sends the creator's labels.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ws = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast-workspace.js'), 'utf8');
const panel = ws.slice(ws.indexOf('function _wsRenderPanel()'), ws.indexOf('\n}\n', ws.indexOf('function _wsRenderPanel()')));
const fn = (name) => { const i = ws.indexOf(`function ${name}(`); assert.ok(i > 0, name); return ws.slice(i, ws.indexOf('\n}\n', i)); };

// The chip and the fold.
assert.ok(panel.includes(`onclick="_glOpenFold('gl-labels')"`) && panel.includes('id="gl-labels-v"'), 'a Labels chip that opens its fold');
assert.ok(panel.includes('<details class="gl-fold" id="gl-labels">') && panel.includes('id="gl-labels-sum"'), 'a Labels fold whose line says what is set');
assert.ok(panel.includes('Labels are choices, not bans.'), 'it says what a label does, once');

// The six labels, in the contract's words; 18+ in the warning colour.
const L = ws.slice(ws.indexOf('const _GL_LABELS = '), ws.indexOf('\n', ws.indexOf('const _GL_LABELS = ')));
for (const id of ['nudity', 'language', 'graphic', '18+', 'flashing', 'spoilers']) assert.ok(L.includes(`['${id}',`), id);
assert.ok(fn('_glLabelsChips').includes("aria-pressed=") && fn('_glLabelsChips').includes('gl-label--adult'), 'toggles that say their state');

// The AI only suggests: its chips add a label when tapped, and nothing else moves a suggestion into the labels.
const sug = fn('_glLabelsSuggested');
assert.ok(sug.includes('Nothing changes until you add one.'), 'a suggestion says it changes nothing');
assert.ok(sug.includes("onclick=\"_glToggleLabel('${id}')\""), 'a tap adds it');
const toggle = fn('_glToggleLabel');
assert.ok(toggle.includes('_wsMarkDirty()'), 'a change saves with the card');
assert.ok(toggle.includes('suggested: cur.suggested.filter((l) => !labels.includes(l))'), 'a confirmed suggestion leaves the suggestions');

// The save sends the creator's labels (PUT /api/streams/managed/:id { labels }).
const save = fn('_wsSaveAll');
assert.ok(save.includes('labels: _glLabelsOf(ms).labels,'), 'the save sends the labels');
assert.ok(fn('_glSyncSummaries').includes("set('gl-labels-sum'"), 'the line follows the change');

console.log('golive-labels: all passed');
