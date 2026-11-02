/**
 * The AI's stale clips leave the lists (server/ai/auto-clip-sweep.js; open item 151, "prune stale auto-clips, hide
 * first"): a public automatic clip cut more than 30 days ago that no person ever opened (Media's unvisited=1) is made
 * unlisted, never deleted, and remembered so it can be put back. A person's clip is never touched; a Media that does
 * not apply unvisited=1 makes the sweep do nothing.
 *
 *   node test/run.js auto-clip-sweep
 */
'use strict';
const assert = require('assert');

const media = require('../server/media-client');
const db = require('../server/db/database');
const state = new Map();
db.getState = async (k) => state.get(k) || null;
db.setState = async (k, v) => { state.set(k, v); };

const NOW = Date.parse('2026-11-02T20:00:00Z');
const old = '2026-09-20 10:00:00', recent = '2026-10-25 10:00:00';
let clips, applies, calls;
const reset = () => {
    clips = [
        { id: 1, auto_generated: true, visibility: 'public', created_at: old, visited: false },
        { id: 2, auto_generated: true, visibility: 'public', created_at: old, visited: true },
        { id: 3, auto_generated: false, visibility: 'public', created_at: old, visited: false },
        { id: 4, auto_generated: true, visibility: 'public', created_at: recent, visited: false },
        { id: 5, auto_generated: true, visibility: 'public', created_at: '2026-09-01T00:00:00Z', visited: false },
    ];
    applies = true;
    calls = [];
};
media.listClips = async (q) => {
    calls.push({ list: q });
    const before = Date.parse(q.before);
    let rows = clips.filter((c) => c.visibility === 'public' && (q.auto_generated !== 1 || c.auto_generated)
        && Date.parse(c.created_at.includes('T') ? c.created_at : c.created_at.replace(' ', 'T') + 'Z') < before);
    if (q.unvisited && applies) rows = rows.filter((c) => !c.visited);
    return { clips: rows.slice(0, q.limit), total: rows.length };
};
media.updateClip = async (id, fields) => {
    calls.push({ update: id, fields });
    const c = clips.find((x) => x.id === id);
    Object.assign(c, fields);
    return { clip: { ...c } };
};
const sweep = require('../server/ai/auto-clip-sweep');

(async () => {
    reset();
    const out = await sweep.sweep({ now: NOW });
    assert.deepStrictEqual(out.hidden.sort(), [1, 5], 'old, AI-made, never opened: unlisted');
    assert.strictEqual(clips.find((c) => c.id === 1).visibility, 'unlisted');
    assert.strictEqual(clips.find((c) => c.id === 2).visibility, 'public', 'opened by a person: kept');
    assert.strictEqual(clips.find((c) => c.id === 3).visibility, 'public', 'a person\'s clip: never touched');
    assert.strictEqual(clips.find((c) => c.id === 4).visibility, 'public', 'younger than 30 days: kept');
    assert.ok(calls.every((c) => !c.fields || c.fields.visibility === 'unlisted'), 'unlisted, never deleted');
    const list = calls.find((c) => c.list && c.list.unvisited);
    assert.strictEqual(list.list.auto_generated, 1);
    assert.strictEqual(list.list.before, '2026-10-03T20:00:00.000Z', '30 days before now');
    const log = JSON.parse(state.get(sweep.SETTING));
    assert.deepStrictEqual(log.map((e) => e.id).sort(), [1, 5], 'remembered');

    // Put one back.
    await sweep.restore(1);
    assert.strictEqual(clips.find((c) => c.id === 1).visibility, 'public');
    assert.deepStrictEqual(JSON.parse(state.get(sweep.SETTING)).map((e) => e.id), [5], 'and forgotten');

    // A dry run says what it would hide and changes nothing.
    reset(); state.clear();
    const dry = await sweep.sweep({ now: NOW, dryRun: true });
    assert.deepStrictEqual(dry.hidden.sort(), [1, 5]);
    assert.ok(!calls.some((c) => c.update), 'nothing changed');
    assert.strictEqual(state.get(sweep.SETTING), undefined);

    // A Media that ignores unvisited=1 answers every old clip: the sweep does nothing.
    reset(); applies = false;
    const blind = await sweep.sweep({ now: NOW });
    assert.deepStrictEqual(blind.hidden, []);
    assert.match(blind.why, /did not apply unvisited/);
    assert.ok(!calls.some((c) => c.update));

    // At most `max` a run.
    reset();
    const one = await sweep.sweep({ now: NOW, max: 1 });
    assert.strictEqual(one.hidden.length, 1);

    // Media down: nothing, no throw.
    reset();
    const listClips = media.listClips;
    media.listClips = async () => { throw Object.assign(new Error('down'), { status: 503 }); };
    await assert.rejects(sweep.sweep({ now: NOW }), /down/, 'the job runner records the failure');
    media.listClips = listClips;

    console.log('auto-clip sweep: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
