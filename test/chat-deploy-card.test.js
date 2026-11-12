'use strict';
/**
 * The "updates shipped" card in chat (public/js/chat.js renderDeployCard) says what changed for the people in chat:
 * a docs-only commit is left out, and a subject's "(#843)" PR number is dropped (11-12 review: "README: the event list
 * no longer includes merge events (#841)" was in a channel's chat).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const chat = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
const m = chat.match(/const DOCS_ONLY = (\/.+\/i);/);
assert.ok(m, 'the card has its docs-only rule');
const DOCS_ONLY = new Function(`return ${m[1]};`)();
for (const s of ['README: the event list no longer includes merge events (#841)', 'CHANGELOG: drop the account merge entry (#268)', 'docs: deploy kinds', 'Docs - the WHIP guide'])
    assert.ok(DOCS_ONLY.test(s), `left out: ${s}`);
for (const s of ['Go live: allow the camera kit from openvibe.cam (#843)', 'Elements stage 1: the Viewer Deck (#842)', 'Readmes everywhere get a search box', 'Documentation page loads faster'])
    assert.ok(!DOCS_ONLY.test(s), `kept: ${s}`);
assert.ok(chat.includes(".replace(/\\s*\\(#\\d+\\)\\s*$/, '')"), 'the PR number is dropped from each subject');
const strip = (s) => s.replace(/\s*\(#\d+\)\s*$/, '');
assert.strictEqual(strip('Go live: allow the camera kit from openvibe.cam (it was refused on every browser) (#843)'), 'Go live: allow the camera kit from openvibe.cam (it was refused on every browser)');
console.log('chat-deploy-card: docs-only commits left out, PR numbers dropped');
