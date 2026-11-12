'use strict';
// Every script a page adds from another host is allowed by Live's Content Security Policy, both the enforced one
// (server/index.js helmet scriptSrc) and the report-only one (server/web/assets.js cspReportOnly).
//
// 11-12: the go-live page loaded OpenVibe.Cam's camera kit while script-src never named https://openvibe.cam, so every
// browser refused it and "Turn on camera" answered "Could not load camera controls" from 11-09. (Since 11-12 the
// camera is Live's own, public/js/live-capture.js, and no page loads a script from openvibe.cam.)
//   node test/csp-script-hosts.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { cspReportOnly } = require('../server/web/assets');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const directive = (name) => {
    const m = index.match(new RegExp(`${name}:\\s*\\[([^\\]]*)\\]`));
    assert.ok(m, `server/index.js has a ${name} list`);
    return m[1];
};
const scriptSrc = directive('scriptSrc');
const styleSrc = directive('styleSrc');
const reportOnly = cspReportOnly('<html><head></head></html>').split('; ').find((d) => d.startsWith('script-src-elem ')) || '';

// script.src = 'https://host/…' (or "…") in any page script: the host must be in both policies.
const files = [];
const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (e.name.endsWith('.js')) files.push(p);
    }
};
walk(path.join(root, 'public/js'));
const hosts = new Map();
for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\b[A-Za-z_$][\w$]*\.src\s*=\s*['"`](https:\/\/[a-z0-9.-]+)\//g)) {
        // Only script elements: an <img>/<video> src is another directive. The variable is named for its element.
        const before = text.slice(Math.max(0, m.index - 800), m.index);
        if (!/createElement\(\s*['"]script['"]\s*\)/.test(before)) continue;
        hosts.set(m[1], path.relative(root, f));
    }
}
assert.ok(hosts.has('https://cdn.jsdelivr.net'), 'the scan finds a known third-party script (pastes.js), so it reads the pages');
assert.ok(!hosts.has('https://openvibe.cam'), 'no page loads a script from OpenVibe.Cam: the camera is Live\'s own');
for (const [host, file] of hosts) {
    const bare = host.replace(/^https:\/\//, '');   // a source may be written with or without its scheme
    assert.ok(scriptSrc.includes(`"${host}"`) || scriptSrc.includes(`"${bare}"`), `${file} loads a script from ${host}: script-src must allow it`);
    assert.ok(reportOnly.split(' ').some((x) => x === host || x === bare), `${file} loads a script from ${host}: the report-only script-src-elem must allow it`);
}
assert.ok(!scriptSrc.includes('openvibe.cam') && !styleSrc.includes('openvibe.cam'), 'and the policy no longer lets one');
console.log(`csp script hosts: ${hosts.size} third-party script host(s) allowed`);
