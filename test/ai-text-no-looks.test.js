'use strict';
// Public AI text never describes how a person looks: a frame note or an overview that names looks or an age
// ("A shirtless man sits…", "a young boy at a desk") is stored with that person as "the streamer", a plain "a man"
// or "a black chair" stays as written, and rows stored before the rule are repaired by the AI cleanup pass.
const assert = require('assert');
console.warn = () => {};

const db = require('../server/db/database');
(async () => {
    await db.initDb();
    await db.createUser({ username: 'lookee', email: 'lookee@x', password_hash: 'x', display_name: 'lookee', stream_key: 'lookee'.padEnd(32, '0') });
    const uid = (await db.get("SELECT id FROM users WHERE username = 'lookee'")).id;
    const sid = Number((await db.createStream({ user_id: uid, title: 't', category: 'irl', protocol: 'rtmp' })).lastInsertRowid);

    const cases = [
        ['A shirtless man sits in a room with framed pictures on the wall.', 'The streamer sits in a room with framed pictures on the wall.'],
        ['A livestream frame showing a shirtless streamer in a small inset while playing a MOBA.', 'A livestream frame showing the streamer in a small inset while playing a MOBA.'],
        ['Chat watches a young boy at a desk build a PC.', 'Chat watches the streamer at a desk build a PC.'],
        ['Young, bearded man plays chess.', 'Streamer plays chess.'],
        ['A man plays chess next to a black chair.', 'A man plays chess next to a black chair.'],
        ['The streamer, topless, laughs at chat.', 'The streamer laughs at chat.'],
        ['A man is shirtless and appears to be talking to chat.', 'A man appears to be talking to chat.'],
        ['A person watches TV while a child sits nearby.', 'A person watches TV while someone sits nearby.'],
        ['The girl waves at the camera.', 'The person waves at the camera.'],
    ];
    let off = 0;
    for (const [input, want] of cases) {
        await db.addStreamMemory({ stream_id: sid, user_id: uid, offset_seconds: (off += 60), description: input });
        const row = await db.get('SELECT description FROM stream_memories WHERE stream_id = ? AND offset_seconds = ?', [sid, off]);
        assert.strictEqual(row.description, want, input);
    }

    await db.updateStreamAiOverview(sid, 'A teenage girl streams Minecraft builds with a calm vibe.');
    const st = await db.get('SELECT ai_overview, ai_overview_short FROM streams WHERE id = ?', [sid]);
    assert.deepStrictEqual([st.ai_overview, st.ai_overview_short], ['The streamer streams Minecraft builds with a calm vibe.', 'The streamer streams Minecraft builds with a calm vibe.']);

    // Rows stored before the rule.
    await db.run('INSERT INTO stream_memories (stream_id, user_id, offset_seconds, description) VALUES (?, ?, ?, ?)', [sid, uid, 9000, 'A shirtless man rests his chin on his hand.']);
    await db.run('UPDATE streams SET ai_overview = ?, ai_overview_short = ? WHERE id = ?', ['A young boy plays Fortnite.', 'A young boy plays Fortnite.', sid]);
    await db.run('INSERT INTO stream_memories (stream_id, user_id, offset_seconds, description) VALUES (?, ?, ?, ?)', [sid, uid, 9060, 'An older version of the game loads.']);
    await db.cleanupMalformedAiText();
    assert.strictEqual((await db.get('SELECT description FROM stream_memories WHERE offset_seconds = 9000')).description, 'The streamer rests his chin on his hand.');
    assert.deepStrictEqual(Object.values(await db.get('SELECT ai_overview, ai_overview_short FROM streams WHERE id = ?', [sid])), ['The streamer plays Fortnite.', 'The streamer plays Fortnite.']);
    assert.strictEqual((await db.get('SELECT description FROM stream_memories WHERE offset_seconds = 9060')).description, 'An older version of the game loads.', 'looks words about things stay');

    // The home hero's AI copy: a line about someone's looks is never served, even from a batch stored before.
    const words = ['crouton connoisseurs', 'van-dwelling coders', 'ara007 shirtless thoughts', 'goosely fans', 'late-night tinkerers', 'young gamers'];
    await db.setState('home_hero_slogans', JSON.stringify({ audiences: words, quips: ['chat is cooking', 'a shirtless take', 'goosely did it again', 'rust compiles eventually', 'one more build'], updated_at: Date.now(), v: 4 }));
    const hero = await require('../server/home/routes').heroSlogans();
    assert.ok(hero.ai && !hero.audiences.some((a) => /shirtless|young/.test(a)) && !hero.quips.some((q) => /shirtless/.test(q)), JSON.stringify(hero));
    assert.strictEqual(hero.audiences.length, 4);

    console.log('ai-text-no-looks: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
