/**
 * An AI clip is never more visible than its recording (server/ai/clip-publication.js; item 151, C16). Media makes a
 * clip public when no visibility is sent and does not look at the source, so every AI cut (live, VOD moments, Vibe's
 * voice clip) sends the one this decides; a protected recording (VOD 5709) is never cut; an unknown one is private.
 *
 *   node test/run.js clip-publication
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const media = require('../server/media-client');
const vods = { 1: { id: 1, visibility: 'public' }, 2: { id: 2, visibility: 'unlisted' }, 3: { id: 3, visibility: 'private' }, 4: { id: 4, is_public: false } };
media.getVod = async (id) => { if (String(id) === '99') throw new Error('Media down'); return vods[id] || null; };
const pub = require('../server/ai/clip-publication');

(async () => {
    // The lower of what the picker wants and what the recording allows.
    assert.strictEqual(pub.visibilityFor({ vodVisibility: 'public', wanted: 'public' }), 'public');
    assert.strictEqual(pub.visibilityFor({ vodVisibility: 'public', wanted: 'unlisted' }), 'unlisted');
    assert.strictEqual(pub.visibilityFor({ vodVisibility: 'unlisted', wanted: 'public' }), 'unlisted');
    assert.strictEqual(pub.visibilityFor({ vodVisibility: 'private', wanted: 'public' }), 'private');
    assert.strictEqual(pub.visibilityFor({ vodVisibility: undefined, wanted: 'public' }), 'private', 'unknown is private');
    assert.strictEqual(pub.visibilityFor({ vodVisibility: 'weird', wanted: 'public' }), 'private');

    // The recording's visibility: from the row, else from Media, else private.
    assert.strictEqual(await pub.vodVisibility({ id: 2, visibility: 'unlisted' }), 'unlisted');
    assert.strictEqual(await pub.vodVisibility({ id: 3 }), 'private');
    assert.strictEqual(await pub.vodVisibility({ id: 4 }), 'private', 'legacy is_public: false');
    assert.strictEqual(await pub.vodVisibility({ id: 1 }), 'public');
    assert.strictEqual(await pub.vodVisibility({ id: 99 }), 'private', 'Media down: private');
    assert.strictEqual(await pub.vodVisibility({ id: 777 }), 'private', 'no such recording: private');

    // A protected recording is never cut.
    assert.strictEqual(pub.mayCut(5709), false);
    assert.strictEqual(pub.mayCut('5709'), false);
    assert.strictEqual(pub.mayCut(1), true);

    // Every AI cut sends the decided visibility and asks mayCut first (live, VOD moments, Vibe's voice clip).
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', 'ai', f), 'utf8');
    const job = src('auto-clip-job.js');
    assert.strictEqual((job.match(/publication\.mayCut\(/g) || []).length, 2, 'both cutters ask mayCut');
    assert.strictEqual((job.match(/visibility,\n/g) || []).length >= 2, true, 'both cutters send the visibility');
    assert.doesNotMatch(job, /visibility: rated\.verdict === 'public' \? 'public' : 'unlisted',\n\s*\}\)/, 'the score alone no longer decides');
    const voice = src('vibe-voice.js');
    assert.match(voice, /publication\.mayCut\(rec\.vodId\)/);
    assert.match(voice, /auto_generated: false, description: '', visibility \}/);
    console.log('clip publication: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
