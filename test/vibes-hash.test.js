/**
 * openvibe-shared's account menu shows a person's Vibes on every OpenVibe site and links them to openvibe.live/#vibes.
 * Live opens the shared Wallet for that link, once: the hash goes, so a reload does not open it again.
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
        location: { hash, pathname: '/@alex', search: '?x=1', assign: (url) => replaced.push(url) },
        history: { state: null, replaceState: (s, t, url) => replaced.push(url) },
        document: { readyState: 'complete', addEventListener() {} },
        setTimeout: (fn) => fn(),
        window: { OpenVibeNavbar: { openWallet: () => opened.push('wallet') } },
    };
    // eslint-disable-next-line no-new-func
    new Function(...Object.keys(env), block)(...Object.values(env));
    return { opened, replaced };
}

assert.deepStrictEqual(run('#vibes'), { opened: ['wallet'], replaced: ['/@alex?x=1'] }, 'the link opens the shared Wallet and drops the hash');
assert.deepStrictEqual(run(''), { opened: [], replaced: [] }, 'nothing otherwise');
assert.deepStrictEqual(run('#chat'), { opened: [], replaced: [] });
console.log('vibes hash: all checks passed');
