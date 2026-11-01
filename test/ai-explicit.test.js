'use strict';
/**
 * AI text that says a scene shows sex acts or porn never becomes a public moment or auto-clip, and an AI-made clip whose
 * overview turns out explicit goes private (server/ai/explicit.js). 2026-10-23: clip 483, cut by the AI from a stream
 * that showed sexual acts, went public on openvibe.media and Live's home with a description of them. Nudity is not
 * explicit (owner, 2026-10-31: "dick is art… titties is art").
 *
 *   node test/ai-explicit.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Media, stubbed before explicit.js loads it.
const calls = [];
const clips = new Map();
const stub = {
    getClip: async (id) => { calls.push(['get', id]); return clips.get(id) || null; },
    updateClip: async (id, fields) => { calls.push(['update', id, fields]); return { id, ...fields }; },
};
const mediaPath = require.resolve('../server/media-client');
require.cache[mediaPath] = { id: mediaPath, filename: mediaPath, loaded: true, exports: stub };
const { isExplicit, guardAutoClip } = require('../server/ai/explicit');

let pass = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };

(async () => {
    // Sex acts and porn: what the AI wrote about clip 483's stream, and the like.
    for (const t of [
        'The video shows the streamer engaging in explicit adult content, with close-up footage of sexual acts on a couch',
        'Pornographic footage plays on the second monitor', 'masturbating on camera', 'Two people having sex on a bed',
    ]) assert.ok(isExplicit(t), `explicit: ${t}`);
    // Nudity and bodies are art, not explicit.
    for (const t of [
        'A naked man lying on their back on a bed', 'The scene contains nudity', 'A topless painter works on a canvas',
        'The streamer shows their genitals as part of a body-art piece', 'A nude figure drawing session',
    ]) assert.ok(!isExplicit(t), `not explicit: ${t}`);
    for (const t of [
        'A player in Fortnite is sprinting along a pink-purple sunset map', 'The streamer smokes a cigarette and smiles at the camera',
        'They read the news from Essex and talk about the weather', 'A boss fight in a dark purple-lit arena', '', null, undefined,
        'A sextant and a map on the desk', 'The chat spams PogChamp during the clutch',
    ]) assert.ok(!isExplicit(t), `not explicit: ${t}`);
    assert.ok(isExplicit('a fine title', null, 'the frame shows sexual activity'), 'any of several texts');
    // The hard line nudity being art never moves: a child and a bare body in one text is treated as explicit.
    for (const t of [
        'A naked child runs across the frame', 'Two kids appear nude in the background', 'a teen undressing on camera',
        'The toddler is topless in the bath',
    ]) assert.ok(isExplicit(t), `a child and nudity: ${t}`);
    for (const t of [
        'Kids in swimsuits splash in the pool', 'A girl plays guitar on the porch', 'The boys argue about the boss fight',
        'A naked man lying on their back on a bed',
    ]) assert.ok(!isExplicit(t), `not explicit: ${t}`);
    ok('the detector: sex acts and porn, and a child with nudity; not nudity alone and not ordinary streams');

    // An AI clip with an explicit overview goes private and loses its description.
    clips.set(1, { id: 1, auto_generated: true, visibility: 'public' });
    assert.strictEqual(await guardAutoClip({ id: 1, auto_generated: true, visibility: 'public' }, 'close-up footage of sexual acts'), true);
    assert.deepStrictEqual(calls.pop(), ['update', 1, { visibility: 'private', description: '' }]);
    // A person's own clip is theirs: nothing changes.
    calls.length = 0;
    assert.strictEqual(await guardAutoClip({ id: 2, auto_generated: false, visibility: 'public' }, 'close-up footage of sexual acts'), false);
    assert.strictEqual(calls.length, 0, 'no Media call for a person\'s clip');
    // An ordinary overview: nothing, not even a lookup.
    assert.strictEqual(await guardAutoClip({ id: 3 }, 'A clutch round in Fortnite'), false);
    assert.strictEqual(calls.length, 0, 'no Media call for an ordinary overview');
    // An event's clip object may not say who made it: Media is asked (only for an explicit overview).
    clips.set(4, { id: 4, auto_generated: true, visibility: 'unlisted' });
    assert.strictEqual(await guardAutoClip({ id: 4 }, 'the streamer is having sex on camera'), true);
    assert.deepStrictEqual(calls.map((c) => c[0]), ['get', 'update']);
    // Already private: left alone.
    calls.length = 0;
    clips.set(5, { id: 5, auto_generated: true, visibility: 'private' });
    assert.strictEqual(await guardAutoClip({ id: 5 }, 'explicit adult content'), false);
    assert.deepStrictEqual(calls.map((c) => c[0]), ['get']);
    ok('an AI-made clip with an explicit overview goes private; people\'s clips and ordinary overviews are untouched');

    // The writers use it.
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    const moments = read('server/ai/ai-moments-job.js');
    assert.ok(moments.includes("const explicit = require('./explicit');"));
    assert.ok(/explicit\.isExplicit\(j\.desc, j\.title, near && near\.description, result\.desc\)\) \{[^\n]*return null; \}/.test(moments), 'the AI pick is dropped');
    assert.ok(moments.includes('if (near && explicit.isExplicit(near.description)) return null;'), 'the signal pick is dropped');
    assert.ok(moments.includes("if (vis && explicit.isExplicit(vis.description, (vis.tags || []).join(' '))) sexual = true;") && /if \(sexual\) \{[\s\S]{0,400}continue;/.test(moments), 'a frame the vision pass calls sexual is neither posted nor clipped');
    const auto = read('server/ai/auto-clip-job.js');
    assert.ok(auto.includes("if (require('./explicit').isExplicit(verdict.desc, verdict.title))"), 'the live auto-clip skips it');
    assert.ok(auto.includes("if (require('./explicit').isExplicit(desc, title)) {"), 'a finished recording\'s auto-clip skips it');
    assert.ok(read('server/ai/ai-analysis.js').includes("await require('./explicit').guardAutoClip(clip, overview);"), 'the clip overview pass guards');
    assert.ok(read('server/ai/ai-media-analyze.js').includes("await require('./explicit').guardAutoClip(item, overview);"), 'the OpenVibe.AI overview pass guards');
    ok('the moments job, both auto-clip paths and both clip overview passes use it');

    console.log(`ai explicit: ${pass} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
