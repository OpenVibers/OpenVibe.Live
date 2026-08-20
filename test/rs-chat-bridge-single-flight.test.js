/**
 * Regression: RobotStreamer chat messages were mirrored into OpenVibe chat once per
 * racing start, so viewers saw every RS message two or three times in a row.
 *
 * startForStream() is called from four lifecycle hooks — stream creation, the WHIP
 * ingest going live, the boot-time restore sweep, and the integrations route — and
 * several of them fire within milliseconds for the same stream. The method is async and
 * awaits refreshIntegration() BETWEEN reading chatBridges and populating it, so every
 * concurrent caller passed the "already have a bridge" guard, opened its own websocket
 * to RobotStreamer, and then chatBridges.set() kept only the last one. The earlier
 * bridges stayed connected and kept mirroring: three racing callers, three copies of
 * every message.
 *
 * The fix is a shared in-flight promise, so the guard actually holds. This exercises
 * that directly rather than asserting on source text.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.DB_PATH = path.join(os.tmpdir(), `ov-rs-chat-${Date.now()}.db`);

const svc = require('../server/integrations/robotstreamer-service');

// ── A: concurrent starts collapse to a single underlying run ─────────────────────────
{
    let runs = 0;
    const original = svc._startForStream;
    // Stand in for the real work, with an await inside — the await is the whole point:
    // it is the window the old code left open between guard and registration.
    svc._startForStream = async function (stream) {
        runs++;
        await new Promise(r => setTimeout(r, 25));
        return { streamId: stream.id, bridge: true };
    };

    (async () => {
        const stream = { id: 4242, user_id: 7 };
        const results = await Promise.all([
            svc.startForStream(stream),
            svc.startForStream(stream),
            svc.startForStream(stream),
            svc.startForStream(stream),
        ]);
        assert.strictEqual(runs, 1, `four concurrent starts must run the work once, ran ${runs}`);
        assert.ok(results.every(r => r === results[0]), 'every caller must receive the same bridge');
        console.log('OK A: four concurrent startForStream calls produce exactly one bridge');

        // ── B: once settled, a later start may run again (stream restart must work) ──
        const after = await svc.startForStream(stream);
        assert.strictEqual(runs, 2, 'a start AFTER the first settled must be allowed to run');
        assert.ok(after, 'the later start still returns a bridge');
        console.log('OK B: single-flight releases once settled, so a genuine restart still works');

        // ── C: different streams are independent ────────────────────────────────────
        runs = 0;
        await Promise.all([
            svc.startForStream({ id: 1, user_id: 7 }),
            svc.startForStream({ id: 2, user_id: 7 }),
        ]);
        assert.strictEqual(runs, 2, 'separate streams must each get their own bridge');
        console.log('OK C: the in-flight guard is per stream, not global');

        svc._startForStream = original;

        // ── D: the map does not leak entries ────────────────────────────────────────
        assert.strictEqual(svc._startingStreams.size, 0,
            'in-flight entries must be cleared on settle, or a stream can never be started again');
        console.log('OK D: in-flight map is drained, so a stream is never permanently blocked');

        // ── E: the registration guard refuses to orphan a live bridge ───────────────
        const src = fs.readFileSync(path.join(__dirname, '../server/integrations/robotstreamer-service.js'), 'utf8');
        assert.ok(/already exists — discarding the duplicate/.test(src),
            'registration must discard a duplicate rather than overwrite the tracked bridge');
        const setIdx = src.indexOf('this.chatBridges.set(stream.id, bridge);');
        const guardIdx = src.indexOf('const raced = this.chatBridges.get(stream.id);');
        assert.ok(guardIdx > 0 && guardIdx < setIdx, 'the guard must sit before the set()');
        console.log('OK E: registration discards a duplicate instead of leaking the previous websocket');

        try { fs.unlinkSync(process.env.DB_PATH); } catch { /* */ }
        for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + ext); } catch { /* */ } }
        console.log('✅ RS chat bridge single-flight test passed');
        process.exit(0);
    })().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
}
