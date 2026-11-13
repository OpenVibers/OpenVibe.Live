'use strict';

/**
 * Labels on the go-live screen (2026-11-13, the owner: "use AI to infer labels and shit. So just remove the label
 * section, don't make that customizable … add like a 18+ to the description drop down"; "move the restream up, like
 * right under details"): no Labels fold; an 18+ switch in Details that saves with the card; Restreams right under
 * Details. The AI's labels are applied by server/ai/stream-memory-job.js (test/content-labels.test.js).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ws = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast-workspace.js'), 'utf8');
const panel = ws.slice(ws.indexOf('function _wsRenderPanel()'), ws.indexOf('\n}\n', ws.indexOf('function _wsRenderPanel()')));
const fn = (name) => { const i = ws.indexOf(`function ${name}(`); assert.ok(i > 0, name); return ws.slice(i, ws.indexOf('\n}\n', i)); };

assert.ok(!panel.includes('id="gl-labels"') && !ws.includes('function _glLabelsChips(') && !ws.includes('function _glLabelsSuggested('), 'no Labels fold, no label chips, no suggestions to confirm');
assert.ok(panel.includes('id="gl-adult"') && panel.includes('role="switch"') && panel.includes('_glSetAdult(this.checked)'), 'an 18+ switch');
const details = panel.slice(panel.indexOf('<details class="gl-fold" id="gl-details">'), panel.indexOf('</details>', panel.indexOf('id="gl-details"')));
assert.ok(details.includes('id="gl-adult"'), 'the switch is in Details');
const afterDetails = panel.slice(panel.indexOf('</details>', panel.indexOf('id="gl-details"')));
assert.ok(/^<\/details>\s*<!-- Restream Destinations -->\s*<details class="gl-fold" id="bc-ws-restream-details">/.test(afterDetails), 'Restreams right under Details');
assert.strictEqual((panel.match(/id="bc-ws-restream-details"/g) || []).length, 1, 'one Restreams section');

const adult = fn('_glSetAdult');
assert.ok(adult.includes("'18+'") && adult.includes('_wsMarkDirty()'), 'the switch sets 18+ and saves with the card');
const save = fn('_wsSaveAll');
assert.ok(save.includes('labels: _glLabelsOf(ms).labels,'), 'the save sends the labels');

const job = fs.readFileSync(path.join(__dirname, '..', 'server', 'ai', 'stream-memory-job.js'), 'utf8');
assert.ok(job.includes('db.inferStreamContentLabels(') && !job.includes('suggestStreamContentLabels'), 'the AI job applies what it notices');

console.log('golive-labels: all passed');
