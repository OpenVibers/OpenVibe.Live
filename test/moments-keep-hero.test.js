'use strict';
// The home hero never goes empty because one run found little (11-03: a run where the AI declined every VOD replaced
// the set with nothing for six hours), and the job's own command line opens the database (it had silently done nothing
// since the move to PostgreSQL: every query failed with "the database is not open").
const assert = require('assert');
const fs = require('fs');
const path = require('path');
console.warn = () => {};

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const { keepHeroFull } = require('../server/ai/ai-moments-job')._internals;
    const m = (vodId, offset = 10) => ({ vodId, offset, title: `t${vodId}`, pasteSlug: `p-${vodId}` });

    // Nothing new: the last set stays.
    assert.deepStrictEqual(keepHeroFull([], [m(1), m(2), m(3)], 6).map((x) => x.vodId), [1, 2, 3]);
    // New moments first, then the last set's, never the same VOD twice, up to the target.
    assert.deepStrictEqual(keepHeroFull([m(5), m(2, 99)], [m(1), m(2), m(3), m(4)], 4).map((x) => x.vodId), [5, 2, 1, 3]);
    assert.strictEqual(keepHeroFull([m(5), m(2, 99)], [m(2)], 4)[1].offset, 99, 'the fresh moment wins over the old one of that VOD');
    // A full fresh set is left alone.
    assert.deepStrictEqual(keepHeroFull([m(7), m(8)], [m(1)], 2).map((x) => x.vodId), [7, 8]);
    // Missing or odd previous sets.
    assert.deepStrictEqual(keepHeroFull([m(7)], undefined, 4).map((x) => x.vodId), [7]);
    assert.deepStrictEqual(keepHeroFull([], [null, m(1)], 4).map((x) => x.vodId), [1]);

    // The save goes through it.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'ai', 'ai-moments-job.js'), 'utf8');
    assert.match(src, /const shown = keepHeroFull\(moments, prev\.moments, TARGET_N\);\s*await db\.setState\(SETTING, JSON\.stringify\(\{ moments: shown,/);

    // Every job's command line opens the database first, as a script: the serving pool, no migrations, no boot recovery.
    for (const f of ['ai-moments-job.js', 'auto-clip-job.js', 'easter-egg-job.js']) {
        const s = fs.readFileSync(path.join(__dirname, '..', 'server', 'ai', f), 'utf8');
        const cli = s.slice(s.indexOf('if (require.main === module)'));
        assert.match(cli, /initDb\(\{ script: true \}\)\.then\(/, `${f}: its command line opens the database`);
    }
    const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'database.js'), 'utf8');
    const init = /async function initDb\([\s\S]*?\n\}/.exec(dbSrc)[0];
    const scriptBranch = /if \(script && url\) \{([\s\S]*?)\n    \}/.exec(init);
    assert.ok(scriptBranch, 'initDb has a script branch');
    assert.ok(!/migrate|bootRecovery|setTimeout/.test(scriptBranch[1]), 'a script runs no migrations, recovery or timers');
    assert.ok(init.indexOf('if (script && url)') < init.indexOf('owner.migrate'), 'the script branch returns before the migrations');

    console.log('moments keep the hero: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
