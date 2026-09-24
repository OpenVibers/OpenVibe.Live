'use strict';

// A channel's page is only ever /@<username> (owner rule, 2026-09-23: a bare /<username> is a 404 and
// never redirects, so usernames and page routes can never compete). This scans Live's server and
// client code for links that put a username straight after the site's origin or a base-URL
// expression without the @, the shape go-live notifications, Discord posts and AI pastes used.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['server', 'public/js'];
// `${base}/${username}` or `openvibe.live/${user.username}` (optionally encodeURIComponent/esc-wrapped).
const BARE = /(?:\}|openvibe\.live)\/\$\{(?:encodeURIComponent\(|esc\()?[\w.?]*(?:[uU]sername|handle)\)?\}/g;

// Every entry names a line whose path is a real route, not a channel page, and why.
const ALLOWED = [
    { file: 'server/integrations/powerchat-checkout.js', contains: 'pcUsername', why: "PowerChat's own tip page (powerchat.live/<user>/tip), not an OpenVibe channel" },
    { file: 'server/integrations/powerchat-routes.js', contains: 'powerchat_username', why: "PowerChat's own tip page" },
    { file: 'public/js/app.js', contains: '/chat-ai/relay/', why: 'API path /chat-ai/relay/<platform>/<username>' },
    { file: 'public/js/chat.js', contains: '/chat/relay-user/', why: 'API path /chat/relay-user/<platform>/<username>' },
];

function* files(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') yield* files(p); }
        else if (e.name.endsWith('.js')) yield p;
    }
}

const found = [];
for (const d of DIRS) {
    for (const f of files(path.join(ROOT, d))) {
        const lines = fs.readFileSync(f, 'utf8').split('\n');
        lines.forEach((line, i) => {
            for (const m of line.matchAll(BARE)) {
                const where = `${path.relative(ROOT, f)}:${i + 1}`;
                if (!ALLOWED.some(a => where.startsWith(a.file) && line.includes(a.contains))) found.push(`${where}  ${m[0]}`);
            }
        });
    }
}

// The scanner itself catches the shapes Live used.
for (const bad of ['${base}/${username}', '`https://openvibe.live/${streamer.username}`', '${cfg.baseUrl}/${encodeURIComponent(u.username)}']) {
    assert.ok(bad.match(BARE), `the scanner catches ${bad}`);
}
for (const good of ['${base}/@${username}', '/api/users/${username}', '/@${encodeURIComponent(username)}']) {
    assert.ok(!good.match(BARE), `the scanner leaves ${good} alone`);
}

assert.deepStrictEqual(found, [], `channel links without the @ (use channelPath() on the client, /@\${encodeURIComponent(username)} on the server):\n${found.join('\n')}`);
console.log('channel links: all checks passed');
