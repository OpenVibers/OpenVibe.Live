/**
 * Media stores OUR user ids, so every call must speak our id space.
 *
 * Live used to forward the caller's Network JWT to Media and let Media read the identity
 * out of it. Media took `sub` — the NETWORK's id for that account — and wrote it into
 * user_id columns that hold LIVE-LOCAL ids everywhere else. The two spaces are unrelated
 * numbers over the same accounts, so a comment posted by Maticus (local 80, network 57)
 * was stored as user 57 and rendered under fakefitz's name, and the same mismatch decided
 * who could open a private paste or VOD.
 *
 * The fix authenticates as the app and names the acting user explicitly, so nothing
 * downstream has to guess which space a number is in.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const client = read('server/media-client.js');
const pastes = read('server/media-proxy/pastes.js');

// ── A: the raw token is gone from every Media call site ──────────────────────────────
for (const f of ['server/media-client.js', 'server/media-proxy/pastes.js',
                 'server/media-proxy/vods.js', 'server/media-proxy/clips.js']) {
    assert.ok(!/userTokenFrom/.test(read(f)), `${f} must not forward the caller's token to Media`);
}
console.log("OK A: no Media call site forwards the caller's Network JWT any more");
// ── B: the acting user is a Live-local id, taken from the resolved account ───────────
{
    const media = require('../server/media-client');
    assert.strictEqual(typeof media.actingUserFrom, 'function', 'actingUserFrom must be exported');
    assert.strictEqual(media.userTokenFrom, undefined, 'the token-forwarding helper must be retired');
    assert.strictEqual(media.actingUserFrom({ user: { id: 80 } }), 80, 'a signed-in caller acts as their local id');
    assert.strictEqual(media.actingUserFrom({}), null, 'an anonymous caller acts as nobody');
    assert.strictEqual(media.actingUserFrom({ user: {} }), null, 'a user record with no id acts as nobody');
    // req.user is produced by requireAuth/optionalAuth, which resolve BOTH a Network JWT
    // and an hbt_ API token to the same local account — that is what makes one space.
    assert.strictEqual(media.actingUserFrom({ user: { id: 0 } }), null, 'id 0 is not an account');
    assert.strictEqual(media.actingUserFrom({ user: { id: '80' } }), null,
        'only a real integer id may be sent — a string would mask a bad lookup');
    console.log('OK B: actingUserFrom yields the resolved Live-local id, or nobody');
}

// ── C: identity travels beside Live's service token, never as the caller's credential ──
assert.ok(/createServiceTokenClient/.test(client), 'Media calls authenticate with Live\'s Network service token');
assert.ok(/const MEDIA_AUDIENCE = 'openvibe\.media'/.test(client) && /audience: MEDIA_AUDIENCE/.test(client),
    'that token is for audience openvibe.media');
assert.ok(/async function _authHeader/.test(client), '_authHeader is async (the token is fetched)');
assert.ok(/h\.Authorization = `Bearer \$\{await client\.getToken\(\)\}`/.test(client),
    'the Authorization header is the fetched service token');
assert.ok(/h\['X-OV-User-Id'\] = String\(opts\.actingUser\)/.test(client),
    'the acting user must ride along as a header, not be inferred by Media');
assert.ok(/if \(opts\.actingUser != null\)/.test(client),
    'an anonymous call must not claim to act as anyone');
const mediaSource = read('server/lineage/media-source.js');
assert.ok(/await media\._authHeader\(\)/.test(mediaSource),
    'media-source reuses media-client\'s token helper (one client)');
assert.ok(!/Authorization/.test(mediaSource), 'media-source names no credential of its own');
console.log('OK C: service token authenticates, X-OV-User-Id names the acting user');

// ── D: the commenter's own address reaches Media ─────────────────────────────────────
assert.ok(/headers\['X-Forwarded-For'\] = req\.ip/.test(client),
    "Media's per-IP comment cooldown and its stored address both need the real client IP");
console.log('OK D: proxied requests carry the client IP, not this process\'s loopback');

// ── E: every paste route resolves identity before it reaches Community ───────────────
{
    // toCommunity() names whoever optionalAuth/requireAuth resolved, so a route with no auth
    // middleware silently forwards as nobody.
    const lines = pastes.split('\n').filter(l => /^communityRouter\.(get|post|put|delete|all)\(/.test(l.trim()));
    assert.ok(lines.length >= 6, `expected the forwarding routes, found ${lines.length}`);
    for (const line of lines) {
        if (/'\/:slug\/raw'/.test(line)) continue;   // a plain redirect, no caller identity
        assert.ok(/optionalAuth|requireAuth|requireAdmin/.test(line),
            `route must resolve the caller before forwarding: ${line.trim()}`);
    }
    assert.ok(!/^router\./m.test(pastes) && !/mediaRouter/.test(pastes), 'the Media paste router is gone');
    console.log(`OK E: all ${lines.length - 1} identity-bearing paste routes resolve the caller first`);
}

console.log('✅ media identity space test passed');
