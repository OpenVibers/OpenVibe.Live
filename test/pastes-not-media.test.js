'use strict';

// Media's read-only paste surface (`/api/v1/:app/pastes`, plan T10 step 2) is being retired on the
// note that "nothing calls the app API any more". This pins the Live half of that claim: since pastes
// moved to OpenVibe.Community, Live reads and writes them only through server/pastes-client.js (see
// test/pastes-community.test.js), and nothing under server/ or scripts/ builds a Media paste
// application-API URL or hands a paste path to the Media client. A follow-up acting on Media's note
// must find Live does not read those routes.
//
// Media's public paste URLs (/p/:slug[/raw|/screenshot]) are a different surface and stay: Live still
// builds them in server/media-client.js, but only for legacy rows Media keeps serving.
//
//   node test/pastes-not-media.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// A literal Media tenant path: /api/v1/<app>/…/pastes.
const MEDIA_API_PASTE = /\/api\/v1\/[^'"`\s)]*pastes/gi;
// A call through the Media client (media.request(method, path, …)) whose path names pastes.
const MEDIA_CLIENT_PASTE = /\bmedia(?:Client)?\.request\(\s*['"`][^'"`]*['"`]\s*,\s*['"`][^'"`]*pastes/gi;
const PATTERNS = [MEDIA_API_PASTE, MEDIA_CLIENT_PASTE];

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Every match for `regexes` in `src` that lands on a code line (not inside a comment). */
function findMediaPasteCalls(src, regexes) {
    const lines = src.split('\n');
    const hits = [];
    for (const re of regexes) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src))) {
            const startLine = src.slice(0, m.index).split('\n').length;
            const endLine = src.slice(0, m.index + m[0].length - 1).split('\n').length;
            if (isCommentLine(lines[startLine - 1]) || isCommentLine(lines[endLine - 1])) continue;
            hits.push({ line: endLine, text: lines[endLine - 1].trim() });
        }
    }
    return hits;
}

// The scanner itself: it has to catch the shapes the retired Media proxy used, and leave the public
// URL builders and the retirement comments alone.
for (const [src, n] of [
    ["media.request('POST', `/pastes/${slug}/censor`)", 1],
    ["await fetch(`${MEDIA_URL}/api/v1/live/pastes/abc`)", 1],
    ["media.request('GET', `/vods/${id}`)", 0],
    ["// media.request('POST', `/pastes/${slug}/censor`) — retired", 0],
    ["const API_BASE = `${MEDIA_URL}/api/v1/${MEDIA_APP_ID}`;", 0],
    ["pastesClient.request('GET', '/admin/stats')", 0],
]) {
    const got = findMediaPasteCalls(src, PATTERNS).length;
    assert.strictEqual(got, n, `scanner: expected ${n} hit(s) for ${JSON.stringify(src)}, got ${got}`);
}

const offenders = [];
for (const file of [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'scripts'))]) {
    const src = fs.readFileSync(file, 'utf8');
    for (const hit of findMediaPasteCalls(src, PATTERNS)) {
        offenders.push(`${path.relative(ROOT, file)}:${hit.line} — ${hit.text}`);
    }
}
assert.deepStrictEqual(offenders, [],
    `Live still calls Media's read-only paste API (retired, T10 step 2):\n${offenders.join('\n')}`);

console.log('pastes-not-media: ok (Live paste paths are Community-only)');
