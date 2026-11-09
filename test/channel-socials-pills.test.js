'use strict';
/**
 * Channel social pills name the Network destination; other platforms keep their own handle.
 *
 *   node test/channel-socials-pills.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'channel-socials.js'), 'utf8');
const sandbox = { window: {}, document: {}, console };
vm.runInNewContext(src, sandbox);
const { pills } = sandbox.window.ChannelSocials;

const host = { innerHTML: '', hidden: true };
pills(host, [
    { kind: 'openvibe', url: 'https://openvibe.network/@JapaneseOldGuy', handle: 'JapaneseOldGuy', name: 'OpenVibe', icon: 'fa-solid fa-id-card', color: '#3b82f6', auto: true },
    { kind: 'x', url: 'https://x.com/jog', handle: 'jog', name: 'X', icon: 'fa-brands fa-x-twitter', color: '#000' },
    { kind: 'openvibe', url: 'https://openvibe.network/@other', handle: 'other', label: 'My other channel', name: 'OpenVibe', icon: 'fa-solid fa-id-card', color: '#3b82f6' },
]);
const spans = [...host.innerHTML.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]);
assert.deepStrictEqual(spans, ['Network profile', '@jog', 'Network profile']);
assert.match(host.innerHTML, /href="https:\/\/openvibe\.network\/@JapaneseOldGuy"/, 'the link is unchanged');
assert.match(host.innerHTML, /title="OpenVibe \(connected\) @JapaneseOldGuy"/, 'the handle stays in its title');
console.log('channel social pills: Network links name their destination; other handles stay');
