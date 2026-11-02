'use strict';
/**
 * The offline screen's social pills (public/js/channel-socials.js pills): the OpenVibe profile pill says "OpenVibe
 * profile", since its @handle is the channel's own and is already written just above it (the header read
 * "JapaneseOldGuy · @JapaneseOldGuy · @JapaneseOldGuy" on 2026-11-02); other platforms keep their @handle, and a label
 * the streamer typed wins.
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
assert.deepStrictEqual(spans, ['OpenVibe profile', '@jog', 'My other channel']);
assert.match(host.innerHTML, /href="https:\/\/openvibe\.network\/@JapaneseOldGuy"/, 'the link is unchanged');
assert.match(host.innerHTML, /title="OpenVibe \(connected\) @JapaneseOldGuy"/, 'the handle stays in its title');
console.log('channel social pills: the OpenVibe profile pill says what it is; other handles and typed labels stay');
