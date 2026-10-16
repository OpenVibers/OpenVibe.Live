'use strict';
// A streamer's AI overview is public text (home cards, the channel page's description): a model answer written as a
// list ("- Streamer handle: x (@x).") is stored as one paragraph of prose with a card line that starts with words, and
// rows stored as lists before that are repaired by the AI cleanup pass. The "nothing to say" sentinel still survives.
const assert = require('assert');
console.warn = () => {};

const db = require('../server/db/database');
(async () => {
    await db.initDb();
    const mk = async (username) => { await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username, stream_key: username.padEnd(32, '0') }); return (await db.get('SELECT id FROM users WHERE username = ?', [username])).id; };
    const fixer = await mk('finditfixit'), old = await mk('oldlist'), plain = await mk('plainann');

    await db.upsertStreamerOverview(fixer, { overview: '## Overview\n- Streamer handle: finditfixit (@finditfixit).\n- **Content:** repairs old TVs and radios on stream\n- Tone: calm, patient' });
    const a = await db.getStreamerOverview(fixer);
    assert.strictEqual(a.overview, 'finditfixit (@finditfixit). repairs old TVs and radios on stream. calm, patient.');
    assert.ok(!/^[-*#\s]/.test(a.overview_short) && !a.overview_short.includes('**'), a.overview_short);

    const prose = 'plainann streams Rust and talks through every build. Tone: chill.\nThe chat is small and friendly.';
    await db.upsertStreamerOverview(plain, { overview: prose });
    assert.strictEqual((await db.getStreamerOverview(plain)).overview, prose, 'prose is stored as written');

    // A row stored as a list before the prompt asked for prose.
    await db.run("INSERT INTO streamer_overviews (user_id, overview, overview_short, model, sources, generated_at) VALUES (?, ?, ?, 'x', '{}', ov_now())",
        [old, '- Streamer handle: oldlist (@oldlist).\n- Streams Minecraft builds most nights.', '- Streamer handle: oldlist (@oldlist).']);
    await db.cleanupMalformedAiText();
    const b = await db.getStreamerOverview(old);
    assert.strictEqual(b.overview, 'oldlist (@oldlist). Streams Minecraft builds most nights.');
    assert.strictEqual(b.overview_short, 'oldlist (@oldlist). Streams Minecraft builds most nights.');
    assert.strictEqual((await db.getStreamerOverview(plain)).overview, prose, 'the repair leaves prose alone');

    await db.upsertStreamerOverview(plain, { overview: ' ' });
    assert.strictEqual((await db.getStreamerOverview(plain)).overview_short, ' ', 'the tried-and-empty sentinel round-trips');

    console.log('streamer-overview-prose: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
