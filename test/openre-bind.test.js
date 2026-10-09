'use strict';

// OpenVibe Live on by default for OpenRestream (contracts 0.126.0, live.openre.slot.bind): a stream someone makes on
// openre.stream gets its own new slot on their Live channel, ingested by OpenRestream, and its sessions become live
// `streams` rows through the mirror. Existing slots are never touched; a second bind for the stream returns the same
// slot; someone else's stream, a person with no Live account and a full set of slots are refused.

const assert = require('assert');

process.env.OPENRE_URL = 'http://127.0.0.1:9';           // configured (never called here: a started event needs no call)
process.env.OV_OAUTH_CLIENT_SECRET = 'test-secret';

const SUBJECT = 'usr_01J0000000000000000000000B';
const OTHER = 'usr_01J0000000000000000000000C';
const NOBODY = 'usr_01J0000000000000000000000D';
const STREAM = 'std_01J0000000000000000000000B';
const SES = 'ses_01J0000000000000000000000B';

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const d = db.getDb();
    await d.prepare("INSERT INTO users (id, username, display_name, password_hash, stream_key) OVERRIDING SYSTEM VALUE VALUES (801, 'restreamer', 'Restreamer', 'x', 'personalkey801')").run();
    await d.prepare("INSERT INTO users (id, username, display_name, password_hash) OVERRIDING SYSTEM VALUE VALUES (802, 'other', 'Other', 'x')").run();
    await d.prepare(`INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (801, 'network', '81', '${SUBJECT}')`).run();
    await d.prepare(`INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (802, 'network', '82', '${OTHER}')`).run();
    const existing = await db.createManagedStream({ user_id: 801, title: 'My usual slot', protocol: 'rtmp', streaming_method: 'obs', stream_key: 'slotkey801' });
    const before = await db.getManagedStreamById(existing.lastInsertRowid);

    const { bindSlot, BindError } = require('../server/openre/bind');
    const refused = async (input, status, code) => {
        await assert.rejects(() => bindSlot(input), (err) => err instanceof BindError && err.status === status && err.code === code, `${code}`);
    };

    // Bad input and no Live account.
    await refused({ subject: 'nope', openre_stream_id: STREAM }, 400, 'request.invalid');
    await refused({ subject: SUBJECT, openre_stream_id: 'std_x' }, 400, 'request.invalid');
    await refused({ subject: SUBJECT, openre_stream_id: STREAM, protocol: 'hls' }, 400, 'request.invalid');
    await refused({ subject: NOBODY, openre_stream_id: STREAM }, 409, 'live.no_account');
    console.log('  ✓ bad input and a person with no Live account are refused');

    // A new slot, ingested by OpenRestream; the existing slot is untouched.
    const first = await bindSlot({ subject: SUBJECT, openre_stream_id: STREAM, title: '  Saturday\u0007 streams ', protocol: 'rtmp' });
    assert.strictEqual(first.created, true);
    assert.match(first.channel_url, /^https?:\/\/[^/]+\/@restreamer$/);
    const slot = await db.getManagedStreamById(first.managed_stream_id);
    assert.strictEqual(slot.user_id, 801);
    assert.strictEqual(slot.ingest_authority, 'openre');
    assert.strictEqual(slot.openre_stream_id, STREAM);
    assert.strictEqual(slot.title, 'Saturday streams');
    assert.strictEqual(slot.protocol, 'rtmp');
    assert.ok(slot.stream_key && slot.stream_key !== 'personalkey801' && slot.stream_key !== 'slotkey801', 'a fresh Live key nobody is shown');
    const after = await db.getManagedStreamById(before.id);
    assert.deepStrictEqual({ a: after.ingest_authority, k: after.stream_key, o: after.openre_stream_id }, { a: before.ingest_authority, k: before.stream_key, o: before.openre_stream_id }, 'the existing slot is untouched');
    console.log('  ✓ a stream gets a new slot on the person\'s channel, ingested by OpenRestream; the existing slot is untouched');

    // Idempotent, also when two binds race.
    const [again, race] = await Promise.all([bindSlot({ subject: SUBJECT, openre_stream_id: STREAM }), bindSlot({ subject: SUBJECT, openre_stream_id: STREAM })]);
    assert.deepStrictEqual([again.managed_stream_id, again.created, race.managed_stream_id, race.created], [first.managed_stream_id, false, first.managed_stream_id, false]);
    assert.strictEqual((await d.prepare('SELECT count(*)::int AS n FROM managed_streams WHERE openre_stream_id = ?').get(STREAM)).n, 1);
    console.log('  ✓ a second bind (and two at once) returns the same slot');

    // Someone else's stream id, and a full set of slots.
    await refused({ subject: OTHER, openre_stream_id: STREAM }, 409, 'live.slot_taken');
    await d.prepare('UPDATE users SET max_managed_streams = 1 WHERE id = 802').run();
    await db.createManagedStream({ user_id: 802, title: 'Only slot', protocol: 'rtmp', stream_key: 'slotkey802' });
    await refused({ subject: OTHER, openre_stream_id: 'std_01J0000000000000000000000C' }, 409, 'live.slot_limit');
    console.log('  ✓ another person\'s stream and a full set of slots are refused');

    // The mirror shows the stream's session live on the channel.
    const mirror = require('../server/openre/mirror');
    const event = {
        event_id: 'evt_01J0000000000000000000000B', event_type: 'openre.session.started', version: 1, source: 'openre',
        actor: { type: 'user', id: SUBJECT }, timestamp: new Date().toISOString(),
        subject: { type: 'ingest_session', id: SES, revision: 1 },
        payload: { session_id: SES, external_refs: [{ service: 'live', type: 'managed_stream', id: String(first.managed_stream_id) }], mirror_to_live: true, started_at: new Date().toISOString() },
    };
    const r = await mirror.apply(event);
    assert.strictEqual(r.outcome, 'created');
    const live = await d.prepare('SELECT id, user_id, is_live FROM streams WHERE managed_stream_id = ? AND is_live = 1').get(first.managed_stream_id);
    assert.ok(live && live.user_id === 801, 'the session is a live stream on the person\'s channel');
    const off = await mirror.apply({ ...event, event_id: 'evt_01J0000000000000000000000C', subject: { ...event.subject, id: 'ses_01J0000000000000000000000C' }, payload: { ...event.payload, session_id: 'ses_01J0000000000000000000000C', mirror_to_live: false } });
    assert.strictEqual(off.outcome, 'not_mirrored', 'switched off on OpenRestream: not shown on Live');
    console.log('  ✓ the bound slot\'s session goes live on the channel through the mirror; switched off, it does not');

    console.log('openre bind: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
