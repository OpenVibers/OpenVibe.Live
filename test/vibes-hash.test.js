/**
 * openvibe-shared 4.3's account menu shows a person's Vibes on every OpenVibe site and links them to openvibe.live/#vibes.
 * Live opens its Vibes window for that link, once: the hash goes, so a reload does not open it again.
 *
 *   node test/vibes-hash.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'vibes.js'), 'utf8');
const block = src.slice(src.indexOf('(function openVibesFromLink()'));

function run(hash) {
    const opened = [];
    const replaced = [];
    const env = {
        location: { hash, pathname: '/@alex', search: '?x=1' },
        history: { state: null, replaceState: (s, t, url) => replaced.push(url) },
        document: { readyState: 'complete', addEventListener() {} },
        setTimeout: (fn) => fn(),
        showModal: (id) => opened.push(id),
    };
    // eslint-disable-next-line no-new-func
    new Function(...Object.keys(env), block)(...Object.values(env));
    return { opened, replaced };
}

assert.deepStrictEqual(run('#vibes'), { opened: ['buy-funds'], replaced: ['/@alex?x=1'] }, 'the link opens the Vibes window and drops the hash');
assert.deepStrictEqual(run(''), { opened: [], replaced: [] }, 'nothing otherwise');
assert.deepStrictEqual(run('#chat'), { opened: [], replaced: [] });
console.log('vibes hash: all checks passed');
