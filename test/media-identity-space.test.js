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

// ── C: identity travels beside the app key, never as the caller's credential ─────────
assert.ok(/Authorization: `Bearer \$\{MEDIA_API_KEY\}`/.test(client),
    'Media calls must authenticate as this app');
assert.ok(/h\['X-OV-User-Id'\] = String\(opts\.actingUser\)/.test(client),
    'the acting user must ride along as a header, not be inferred by Media');
assert.ok(/if \(opts\.actingUser != null\)/.test(client),
    'an anonymous call must not claim to act as anyone');
console.log('OK C: app key authenticates, X-OV-User-Id names the acting user');

// ── D: the commenter's own address reaches Media ─────────────────────────────────────
assert.ok(/headers\['X-Forwarded-For'\] = req\.ip/.test(client),
    "Media's per-IP comment cooldown and its stored address both need the real client IP");
console.log('OK D: proxied requests carry the client IP, not this process\'s loopback');

// ── E: every forwarding route resolves identity first ────────────────────────────────
{
    // A forward() route sends whatever actingUserFrom finds on req — so a route with no
    // auth middleware silently posts as nobody.
    const lines = pastes.split('\n').filter(l => /^router\.(get|post|put|delete)\(/.test(l.trim()));
    const needsIdentity = lines.filter(l => /forward\(|forwardEnriched\(/.test(l) && !/forwardAsApp\(/.test(l));
    assert.ok(needsIdentity.length >= 8, `expected the forwarding routes, found ${needsIdentity.length}`);
    for (const line of needsIdentity) {
        if (/'\/config'/.test(line)) continue;   // static config, no caller identity
        assert.ok(/optionalAuth|requireAuth|requireAdmin/.test(line),
            `route must resolve the caller before forwarding: ${line.trim()}`);
    }
    console.log(`OK E: all ${needsIdentity.length - 1} identity-bearing paste routes resolve the caller first`);
}

// ── F: the owner gate compares one id space ──────────────────────────────────────────
{
    const gate = pastes.slice(pastes.indexOf('const viewingSelf'), pastes.indexOf('const mine ='));
    assert.ok(/String\(req\.user\.id\) === String\(user\.id\)/.test(gate), 'owner check must compare local ids');
    assert.ok(!/networkId/.test(gate),
        'matching the viewed user\'s NETWORK id let whoever holds that number locally read their unlisted pastes');
    console.log('OK F: unlisted-paste owner gate compares local ids only');
}

console.log('✅ media identity space test passed');
