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
        // Clothing, hair and face go; the rest of the sentence stays.
        ['The streamer wearing a red beanie speaks to the camera outdoors, seemingly addressing chat.', 'The streamer speaks to the camera outdoors, seemingly addressing chat.'],
        ['The view is close to the camera while wearing a black beanie and hoodie, with trees around.', 'The view is close to the camera, with trees around.'],
        ['A man in a gray tank top sits against a plain light background.', 'A man sits against a plain light background.'],
        ['A man with a long beard and plaid shirt examines a woven item.', 'A man examines a woven item.'],
        ['A kitchen studio with a headset-wearing host, microphone, and on-screen graphics.', 'A kitchen studio with a host, microphone, and on-screen graphics.'],
        ['Panelists discuss while wearing headsets and microphones, with a trophy nearby.', 'Panelists discuss, with a trophy nearby.'],
        ['A man wearing sunglasses on his head looks down at the camera.', 'A man looks down at the camera.'],
        ['A collage of a man in a white shirt and tie wearing dark sunglasses in the left panel.', 'A collage of a man in the left panel.'],
        ['A cartoon streaming setup: wearing a headset with a microphone, rugged jacket, backpack with a mat.', 'A cartoon streaming setup: backpack with a mat.'],
        ['A partial view of a person wearing a gray zip-up jacket with a white zipper, seated indoors.', 'A partial view of a person, seated indoors.'],
        ['Close-up of a person wearing a yellow vest over a gray knit top, with a backpack visible.', 'Close-up of a person, with a backpack visible.'],
        ['A Minecraft player in a top-down view builds a house; the streamer reviews new headphones.', 'A Minecraft player in a top-down view builds a house; the streamer reviews new headphones.'],
        ['The streamer laughs — heard: "Put your headset on. I like your hair."', 'The streamer laughs — heard: "Put your headset on. I like your hair."'],
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
    await db.run('INSERT INTO stream_memories (stream_id, user_id, offset_seconds, description) VALUES (?, ?, ?, ?)', [sid, uid, 9120, 'A man wearing headphones sits at a desk.']);
    await db.cleanupMalformedAiText();
    assert.strictEqual((await db.get('SELECT description FROM stream_memories WHERE offset_seconds = 9120')).description, 'A man sits at a desk.');
    assert.strictEqual((await db.get('SELECT description FROM stream_memories WHERE offset_seconds = 9000')).description, 'The streamer rests his chin on his hand.');
    assert.deepStrictEqual(Object.values(await db.get('SELECT ai_overview, ai_overview_short FROM streams WHERE id = ?', [sid])), ['The streamer plays Fortnite.', 'The streamer plays Fortnite.']);
    assert.strictEqual((await db.get('SELECT description FROM stream_memories WHERE offset_seconds = 9060')).description, 'An older version of the game loads.', 'looks words about things stay');

    // Tags shown with public AI items drop clothing, hair, face, age and gendered people.
    assert.deepStrictEqual(db.noLooksTags(['red-beanie', 'bearded', 'man', 'tanktop', 'hula hoop', 'laptop', 'minecraft', 'outdoors', 'jacket', 'selfie']), ['hula hoop', 'laptop', 'minecraft', 'outdoors']);

    // The chat popover and the profile's AI tab: every AI string in the answer, however nested.
    const { noLooksDeep } = require('../server/ai/chat-ai-routes')._internals;
    assert.deepStrictEqual(noLooksDeep({ overview_alltime: 'A shirtless host chats.', n: 3, jokes: ['the streamer wearing a hat dances'], sessions: [{ moments: [{ description: 'A man in a red shirt cooks.' }] }] }),
        { overview_alltime: 'A host chats.', n: 3, jokes: ['the streamer dances'], sessions: [{ moments: [{ description: 'A man cooks.' }] }] });

    // A session's AI title about looks is not used: the stream's own title is stored instead.
    await db.setStreamAiTitle(sid, 'Orange Shirt Kitchen Chat');
    assert.strictEqual((await db.get('SELECT ai_title FROM streams WHERE id = ?', [sid])).ai_title, 't');
    await db.setStreamAiTitle(sid, 'Minecraft Castle Marathon');
    assert.strictEqual((await db.get('SELECT ai_title FROM streams WHERE id = ?', [sid])).ai_title, 'Minecraft Castle Marathon');

    // The home hero's AI copy: a line about someone's looks is never served, even from a batch stored before.
    const words = ['crouton connoisseurs', 'van-dwelling coders', 'ara007 shirtless thoughts', 'goosely fans', 'late-night tinkerers', 'young gamers'];
    await db.setState('home_hero_slogans', JSON.stringify({ audiences: words, quips: ['chat is cooking', 'a shirtless take', 'goosely did it again', 'rust compiles eventually', 'one more build'], updated_at: Date.now(), v: 4 }));
    const hero = await require('../server/home/routes').heroSlogans();
    assert.ok(hero.ai && !hero.audiences.some((a) => /shirtless|young/.test(a)) && !hero.quips.some((q) => /shirtless/.test(q)), JSON.stringify(hero));
    assert.strictEqual(hero.audiences.length, 4);

    console.log('ai-text-no-looks: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
