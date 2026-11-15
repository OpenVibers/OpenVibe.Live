'use strict';
// A streamer overview OpenVibe.AI's hard floor refused (2026-11-15: one streamer's unchanged input was resent every 20
// minutes and refused each time) is remembered: the job waits a day before asking again, and an overview the streamer
// already had keeps its text.
const assert = require('assert');

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const aiService = require('../server/ai/ai-service');

    // The refusal and its line, from the run's error.
    assert.strictEqual(aiService.refusalRule({ status: 'failed', error: { code: 'policy.floor_refused', detail: 'this request breaks the hard floor (sexual content involving minors) {"rule":"minors","policy":"floor"}' } }), 'minors');
    assert.strictEqual(aiService.refusalRule({ status: 'failed', error: { code: 'policy.floor_refused', rule: 'mass_harm' } }), 'mass_harm');
    assert.strictEqual(aiService.refusalRule({ status: 'failed', error: { code: 'provider.timeout' } }), null);
    assert.strictEqual(aiService.refusalRule({ status: 'succeeded', output: {} }), null);

    const raw = db.getDb();
    const addUser = async (id, username) => raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role) OVERRIDING SYSTEM VALUE
        VALUES (?, ?, ?, ?, 'x', 'streamer')`).run(id, username, username, `${username}@x`);
    await addUser(9101, 'refusedrae');
    await addUser(9102, 'decentdan');
    for (const id of [9101, 9102]) {
        await db.ensureChannel(id);
        const ch = await db.getChannelByUserId(id);
        const stream = (await db.createStream({ user_id: id, channel_id: ch.id, title: 'S', protocol: 'webrtc' })).lastInsertRowid;
        await db.run('INSERT INTO stream_memories (stream_id, user_id, description) VALUES (?, ?, ?)', [stream, id, 'A memory']);
    }
    const due = async () => (await db.getStreamersNeedingOverview({ decentLen: 220, limit: 50 })).map((r) => Number(r.user_id));
    assert.ok((await due()).includes(9101), 'a streamer without an overview is due');

    await db.markStreamerOverviewRefused(9101, 'minors');
    assert.ok(!(await due()).includes(9101), 'refused: not due now');
    const row = await db.getStreamerOverview(9101);
    assert.deepStrictEqual([row.overview, JSON.parse(row.sources)], ['', { refused: 'minors' }]);
    await db.run("UPDATE streamer_overviews SET generated_at = datetime('now','-2 hours') WHERE user_id = ?", [9101]);
    assert.ok(!(await due()).includes(9101), 'not after an hour either, as a sparse one would be');
    await db.run("UPDATE streamer_overviews SET generated_at = datetime('now','-25 hours') WHERE user_id = ?", [9101]);
    assert.ok((await due()).includes(9101), 'asked again after a day');

    // A streamer who had a good overview keeps it when a refresh is refused.
    const good = 'Dan builds small robots on stream and answers chat about wiring, motors and the parts that broke this week. '.repeat(3);
    await db.upsertStreamerOverview(9102, { overview: good, model: 'openvibe-ai', sources: '{}' });
    await db.markStreamerOverviewRefused(9102, 'mass_harm');
    const kept = await db.getStreamerOverview(9102);
    assert.ok(kept.overview.startsWith('Dan builds small robots'), 'the text stays');
    assert.ok(!(await due()).includes(9102));

    // The overview job asks AI with onRefused, and remembers the refusal through the database.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'ai', 'ai-analysis.js'), 'utf8');
    assert.match(src, /onRefused: async \(rule\) => \{[\s\S]{0,300}db\.markStreamerOverviewRefused\(userId, rule\)/);
    console.log('streamer-overview-refused: a refused overview waits a day and keeps the text it had');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
