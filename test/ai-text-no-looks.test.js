'use strict';
// Public AI text never describes how a person looks: a frame note or an overview that names looks or an age
// ("A shirtless man sits…", "a young boy at a desk") is stored with that person as "the streamer"; a guessed gender
// ("a man", "two men", "a male or female host") becomes a person; "a black chair" stays as written; and rows stored
// before a rule changed are repaired by the AI cleanup pass.
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
        ['A man plays chess next to a black chair.', 'A person plays chess next to a black chair.'],
        ['The streamer, topless, laughs at chat.', 'The streamer laughs at chat.'],
        ['A man is shirtless and appears to be talking to chat.', 'A person appears to be talking to chat.'],
        ['A person watches TV while a child sits nearby.', 'A person watches TV while someone sits nearby.'],
        ['The girl waves at the camera.', 'The person waves at the camera.'],
        // Clothing, hair and face go; the rest of the sentence stays.
        ['The streamer wearing a red beanie speaks to the camera outdoors, seemingly addressing chat.', 'The streamer speaks to the camera outdoors, seemingly addressing chat.'],
        ['The view is close to the camera while wearing a black beanie and hoodie, with trees around.', 'The view is close to the camera, with trees around.'],
        ['A man in a gray tank top sits against a plain light background.', 'A person sits against a plain light background.'],
        ['A man with a long beard and plaid shirt examines a woven item.', 'A person examines a woven item.'],
        // Pose and expression are the person too (2026-10-17, the home page's "Right now").
        ['A live stream frame shows the streamer in a small window bottom-left, appearing to be reacting with a thoughtful pose while the main screen is black.',
            'A live stream frame shows the streamer in a small window bottom-left while the main screen is black.'],
        ['The streamer sits in a relaxed posture at the desk.', 'The streamer sits at the desk.'],
        ['A kitchen studio with a headset-wearing host, microphone, and on-screen graphics.', 'A kitchen studio with a host, microphone, and on-screen graphics.'],
        ['Panelists discuss while wearing headsets and microphones, with a trophy nearby.', 'Panelists discuss, with a trophy nearby.'],
        ['A man wearing sunglasses on his head looks down at the camera.', 'A person looks down at the camera.'],
        ['A collage of a man in a white shirt and tie wearing dark sunglasses in the left panel.', 'A collage of a person in the left panel.'],
        ['Behind him a green mat; he wears a blue jacket and is leaning to the left.', 'Behind him a green mat; he is leaning to the left.'],
        ['Two men lift weights, one shirtless and sweating.', 'Two people lift weights, one sweating.'],
        ['Two men stand in an alley, one and drinking from a bottle while the other wears a dusty t-shirt; both look tired.', 'Two people stand in an alley, one drinking from a bottle; both look tired.'],
        ['A man wearing a green bucket hat with frog-like eyes sits indoors.', 'A person sits indoors.'],
        ['A man in sunglasses reaches toward the camera inside a car.', 'A person reaches toward the camera inside a car.'],
        ['A live stream window shows a broadcaster with a headset on the left, a chat panel on the right.', 'A live stream window shows a broadcaster on the left, a chat panel on the right.'],
        ['A man with a red shirt sits in a room; a desk with a headset and keyboard.', 'A person sits in a room; a desk with a headset and keyboard.'],
        ['A gamer faces a casually dressed NPC in a grim interior.', 'A gamer faces a NPC in a grim interior.'],
        ['A cartoon streaming setup: wearing a headset with a microphone, rugged jacket, backpack with a mat.', 'A cartoon streaming setup: backpack with a mat.'],
        ['A partial view of a person wearing a gray zip-up jacket with a white zipper, seated indoors.', 'A partial view of a person, seated indoors.'],
        ['Close-up of a person wearing a yellow vest over a gray knit top, with a backpack visible.', 'Close-up of a person, with a backpack visible.'],
        ['A Minecraft player in a top-down view builds a house; the streamer reviews new headphones.', 'A Minecraft player in a top-down view builds a house; the streamer reviews new headphones.'],
        ['The streamer laughs — heard: "Put your headset on. I like your hair."', 'The streamer laughs — heard: "Put your headset on. I like your hair."'],
        // Clip overviews found public on 2026-10-22: a guessed gender, a slashed pattern before a shirt, a grooming sentence.
        ['The video features a man in a plaid/checkered shirt delivering a live-streamed explanation or discussion.', 'The video features a person delivering a live-streamed explanation or discussion.'],
        ['The video shows a man in a kitchen setting, appearing to stream live from a couch or kitchen area.', 'The video shows a person in a kitchen setting, appearing to stream live from a couch or kitchen area.'],
        ['The video centers on a live stream featuring a male or female host wearing headphones, visible in a small webcam window.', 'The video centers on a live stream featuring a host, visible in a small webcam window.'],
        ['A home kitchen where a person adjusts their hair or clothing near the counter. A pot of soup simmers on the stove.', 'A pot of soup simmers on the stove.'],
        ['A female streamer and two guys race karts; the other men cheer.', 'A streamer and two people race karts; the other people cheer.'],
        ['An Iron Man skin fights Pac-Man in a man-made arena while chat says "that man is cracked".', 'An Iron Man skin fights Pac-Man in a man-made arena while chat says "that man is cracked".'],
    ];
    let off = 0;
    // Public memory text is the observation alone: the raw transcript clause stays for the AI's context, never shown.
    assert.strictEqual(db.publicMemoryText('The main screen is black, suggesting a pause. — heard: "Δεν θα πούμε άλλο. Τώρα που κερδίζουμε."'), 'The main screen is black, suggesting a pause.');
    assert.strictEqual(db.publicMemoryText(null), '');
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
    await db.cleanupMalformedAiText({ force: true });
    assert.strictEqual((await db.get('SELECT description FROM stream_memories WHERE offset_seconds = 9120')).description, 'A person sits at a desk.');
    // The scan runs once per version of the rules: the next boot skips it (rows are scrubbed when written).
    await db.run('INSERT INTO stream_memories (stream_id, user_id, offset_seconds, description) VALUES (?, ?, ?, ?)', [sid, uid, 9180, 'A man wearing a hat waves.']);
    await db.cleanupMalformedAiText();
    assert.strictEqual((await db.get('SELECT description FROM stream_memories WHERE offset_seconds = 9180')).description, 'A man wearing a hat waves.', 'skipped: the rules have not changed');
    await db.setState('ai_looks_repair_rules', 'an older rule set');
    await db.cleanupMalformedAiText();
    assert.strictEqual((await db.get('SELECT description FROM stream_memories WHERE offset_seconds = 9180')).description, 'A person waves.', 'new rules: scanned again');
    // A plain guessed gender stored before this rule is repaired too (the scan's pattern names gendered words).
    await db.run('INSERT INTO stream_memories (stream_id, user_id, offset_seconds, description) VALUES (?, ?, ?, ?)', [sid, uid, 9240, 'A woman cooks pasta.']);
    await db.setState('ai_looks_repair_rules', 'an older rule set');
    await db.cleanupMalformedAiText();
    assert.strictEqual((await db.get('SELECT description FROM stream_memories WHERE offset_seconds = 9240')).description, 'A person cooks pasta.');
    // A card line stored without its full text (or derived from an older one) is repaired on its own.
    await db.run('INSERT INTO clip_ai_state (clip_id, ai_overview_short) VALUES (?, ?)', [990001, 'The video shows a man wearing a headset in a kitchen.']);
    await db.run('INSERT INTO clip_ai_state (clip_id, ai_overview_short) VALUES (?, ?)', [990002, 'A person adjusts their hair or clothing near the counter.']);
    await db.setState('ai_looks_repair_rules', 'an older rule set');
    await db.cleanupMalformedAiText();
    assert.strictEqual((await db.get('SELECT ai_overview_short FROM clip_ai_state WHERE clip_id = 990001')).ai_overview_short, 'The video shows a person in a kitchen.');
    assert.strictEqual((await db.get('SELECT ai_overview_short FROM clip_ai_state WHERE clip_id = 990002')).ai_overview_short, ' ', 'a line that is all looks becomes the nothing-to-say sentinel');
    assert.strictEqual((await db.get('SELECT description FROM stream_memories WHERE offset_seconds = 9000')).description, 'The streamer rests his chin on his hand.');
    assert.deepStrictEqual(Object.values(await db.get('SELECT ai_overview, ai_overview_short FROM streams WHERE id = ?', [sid])), ['The streamer plays Fortnite.', 'The streamer plays Fortnite.']);
    assert.strictEqual((await db.get('SELECT description FROM stream_memories WHERE offset_seconds = 9060')).description, 'An older version of the game loads.', 'looks words about things stay');

    // Tags shown with public AI items drop clothing, hair, face, age and gendered people.
    assert.deepStrictEqual(db.noLooksTags(['red-beanie', 'bearded', 'man', 'tanktop', 'hula hoop', 'laptop', 'minecraft', 'outdoors', 'jacket', 'selfie']), ['hula hoop', 'laptop', 'minecraft', 'outdoors']);

    // The chat popover and the profile's AI tab: every AI string in the answer, however nested.
    const { noLooksDeep } = require('../server/ai/chat-ai-routes')._internals;
    assert.deepStrictEqual(noLooksDeep({ overview_alltime: 'A shirtless host chats.', n: 3, jokes: ['the streamer wearing a hat dances'], sessions: [{ moments: [{ description: 'A man in a red shirt cooks.' }] }] }),
        { overview_alltime: 'A host chats.', n: 3, jokes: ['the streamer dances'], sessions: [{ moments: [{ description: 'A person cooks.' }] }] });

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
