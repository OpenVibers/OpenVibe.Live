// The 202 trap: POST /chat "accepted" ≠ displayed. The verifier reads /chat/history
// back once per tick per streamer and classifies accepted ids as displayed / dropped /
// unverified (no chat:read). DB, OAuth and config are stubbed.
const assert = require('assert');
const path = require('path');
function stub(modPath, exportsObj) { const full = require.resolve(modPath); require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj }; }

const conns = {
    1: { user_id: 1, powerchat_username: 'goosely', access_token: 'a', refresh_token: 'r', scope: 'chat:write chat:read' },
    2: { user_id: 2, powerchat_username: 'legacy', access_token: 'a', refresh_token: 'r', scope: 'chat:write' }, // no chat:read
};
stub(path.join(__dirname, '../server/db/database'), {
    getPowerchatConnection: (id) => conns[id] || null,
    setPowerchatConnectionError: () => {}, getSetting: () => null, getUserById: () => null,
});
stub(path.join(__dirname, '../server/config'), { baseUrl: 'https://openvibe.live' });
const api = { calls: [], history: [] };
stub(path.join(__dirname, '../server/integrations/powerchat-oauth'), {
    getConfig: () => ({ enabled: true, baseUrl: 'https://pc.example', apiBase: 'https://pc.example/api/dev/v1' }),
    apiRequest: async (userId, req) => {
        api.calls.push({ userId, ...req });
        if (req.path === '/chat') return { data: { accepted: true } };
        if (req.path === '/chat/history') return { data: api.history };
        throw new Error('unexpected ' + req.path);
    },
});
const platform = require('../server/integrations/powerchat-platform');

(async () => {
    let t = 1_000_000;
    platform._test.setNow(() => t);

    // Two relays for streamer 1, one for streamer 2 (no chat:read).
    assert.strictEqual(await platform.forwardChat(1, { chatterName: 'pat', message: 'hello', messageId: 'm1' }), 'accepted', '202 is reported as accepted, not delivered');
    assert.strictEqual(await platform.forwardChat(1, { chatterName: 'pat', message: 'again', messageId: 'm2' }), 'accepted');
    assert.strictEqual(await platform.forwardChat(2, { chatterName: 'pat', message: 'hi', messageId: 'x1' }), 'accepted');
    assert.deepStrictEqual(api.calls.map(c => c.path), ['/chat', '/chat', '/chat']);
    assert.strictEqual(api.calls[0].body.messageId, 'm1');
    let s = platform.chatRelayStats(1);
    assert.deepStrictEqual([s.accepted, s.displayed, s.dropped, s.pending, s.verifiable], [2, 0, 0, 2, true]);

    // Too early: nothing is read back yet.
    await platform._test.verifyTick();
    assert.strictEqual(api.calls.filter(c => c.path === '/chat/history').length, 0);

    // After the settle delay: ONE history read for streamer 1 (both ids in one call);
    // streamer 2 has no chat:read → its ids become "unverified" without any API call.
    t += 3000;
    api.history = [{ messageId: 'app:app_1:m1', platform: 'developer_app', text: 'hello' }, { messageId: 'kick-123', platform: 'kick' }];
    await platform._test.verifyTick();
    const reads = api.calls.filter(c => c.path === '/chat/history');
    assert.strictEqual(reads.length, 1);
    assert.strictEqual(reads[0].userId, 1);
    assert.deepStrictEqual(reads[0].query, { limit: 100 });
    s = platform.chatRelayStats(1);
    assert.deepStrictEqual([s.displayed, s.dropped, s.pending], [1, 0, 1], 'm1 matched via the app:<id>: namespace; m2 still pending');
    const s2 = platform.chatRelayStats(2);
    assert.deepStrictEqual([s2.accepted, s2.unverified, s2.pending, s2.verifiable], [1, 1, 0, false]);

    // Within the tick interval: no second read even though m2 is pending.
    t += 1000;
    await platform._test.verifyTick();
    assert.strictEqual(api.calls.filter(c => c.path === '/chat/history').length, 1);

    // Past max age and still absent from history → dropped (counted, never re-sent).
    t += 50000;
    await platform._test.verifyTick();
    assert.strictEqual(api.calls.filter(c => c.path === '/chat/history').length, 2);
    assert.strictEqual(api.calls.filter(c => c.path === '/chat').length, 3, 'a dropped message is not re-posted');
    s = platform.chatRelayStats(1);
    assert.deepStrictEqual([s.displayed, s.dropped, s.pending, s.lastDroppedId], [1, 1, 0, 'm2']);
    assert.ok(s.lastDroppedAt);

    // Envelope tolerance: { data: { rows } } and bare arrays / plain ids both match.
    platform._test.reset();
    await platform.forwardChat(1, { chatterName: 'p', message: 'a', messageId: 'z1' });
    await platform.forwardChat(1, { chatterName: 'p', message: 'b', messageId: 'z2' });
    t += 60000;
    api.history = { rows: [{ id: 'z1' }, { messageId: 'z2' }] };
    await platform._test.verifyTick();
    s = platform.chatRelayStats(1);
    assert.deepStrictEqual([s.displayed, s.dropped, s.pending], [2, 0, 0]);

    // A transient read failure keeps ids pending (no false "dropped").
    platform._test.reset();
    await platform.forwardChat(1, { chatterName: 'p', message: 'c', messageId: 'q1' });
    t += 6000;
    const realApi = require.cache[require.resolve('../server/integrations/powerchat-oauth')].exports;
    const orig = realApi.apiRequest;
    realApi.apiRequest = async (u, r) => { if (r.path === '/chat/history') throw Object.assign(new Error('boom'), { status: 503 }); return orig(u, r); };
    await platform._test.verifyTick();
    s = platform.chatRelayStats(1);
    assert.deepStrictEqual([s.displayed, s.dropped, s.pending], [0, 0, 1]);
    realApi.apiRequest = orig;

    console.log('✅ powerchat chat display-verification tests passed');
})().catch((e) => { console.error('❌', e); process.exit(1); });
