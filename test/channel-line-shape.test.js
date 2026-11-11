'use strict';
// The home "Recently Online" card line has one shape (owner, 2026-11-10): one sentence, what they stream
// first, no name at the start (the card has the name), no colon, at most 90 characters, in the present
// tense — and the same fallback sentence shape where there is too little to go on. Ten transcripts, each
// with the stored overview the streamer-overview job wrote from it, all checked against CHANNEL_LINE_RE.
//   node test/channel-line-shape.test.js
const assert = require('assert');

const { shapeChannelLine, CHANNEL_LINE_RE, FALLBACK_CHANNEL_LINE } = require('../server/ai/channel-line');

// Each fixture: a transcript excerpt (what the streamer said), the stored overview the job wrote from it,
// and the card line. Present tense is pinned structurally: the shaper only ever opens with "Streams" and
// the test refuses a past-tense verb.
const FIXTURES = [
    {
        name: 'a ranked grinder, named and long',
        username: 'izor_one', displayName: 'iZoR_One',
        transcript: '… we go mid, we fight this — nice, clutch! … ranked grind continues …',
        overview: 'iZoR_One streams League of Legends, with a focus on ranked grind, clutch plays, funny moments, and chill vibes. A webcam is typically in the bottom-left.',
        line: 'Streams League of Legends, with a focus on ranked grind, clutch plays, funny moments.',
    },
    {
        name: 'a "Name: …" opener with the verb inside',
        username: 'amberfiera', displayName: 'AmberFieraGames37',
        transcript: '… welcome to the Zaibatsu Q&A, drop your stream ideas …',
        overview: 'AmberFieraGames37: Spicy and fiery, the flaming feline streams a wide range of Roblox and fantasy-adventure gameplay with a focus on immersive worlds.',
        line: 'Streams a wide range of Roblox and fantasy-adventure gameplay.',
    },
    {
        name: 'a copula sentence keeps its role',
        username: 'renyi1333', displayName: 'Renyi1333',
        transcript: '… driving downtown now, say hi to my friend … casual chats …',
        overview: 'Renyi1333 is a car-streamer who often sits in the front seat with a friend nearby, streaming casual chats and drive-time streams.',
        line: 'Streams as a car-streamer.',
    },
    {
        name: 'a bare "is a streamer who/whose" says nothing: fallback',
        username: 'ggvoorlarz', displayName: 'GGvoorLarz',
        transcript: '… [mostly silence, game sounds] …',
        overview: 'GGvoorLarz is a streamer whose broadcasts center around off-screen or minimal-visual sessions, with the live UI featuring chat.',
        line: FALLBACK_CHANNEL_LINE,
    },
    {
        name: 'no overview at all: fallback',
        username: 'jimenezjohary', displayName: 'jimenezjohary',
        transcript: '… sorteo entre amigos, cien boletos …',
        overview: '',
        line: FALLBACK_CHANNEL_LINE,
    },
    {
        name: 'the tried-and-empty sentinel: fallback',
        username: 'quietone', displayName: 'quietone',
        transcript: '',
        overview: ' ',
        line: FALLBACK_CHANNEL_LINE,
    },
    {
        name: 'multi-sentence: the first sentence only, whole phrases kept',
        username: 'maticus', displayName: 'Maticus',
        transcript: '… the robot arm is live, multi-cam is up, ask me about the setup …',
        overview: 'Maticus streams a multi-camera, tech-robot focus with live chats and overlays, often presenting and reacting to surveillance-style feeds. The current threads loop back to robotics discussions.',
        line: 'Streams a multi-camera, tech-robot focus with live chats and overlays.',
    },
    {
        name: 'a long line keeps whole comma-separated phrases',
        username: 'okayy', displayName: 'okayy',
        transcript: '… chilling outside with everyone, come say hi …',
        overview: 'okayy streams outdoors and indoors in relaxed, conversational IRL sessions, often with multiple people chatting on camera for hours.',
        line: 'Streams outdoors and indoors in relaxed, conversational IRL sessions.',
    },
    {
        name: 'a line near the cap stays whole',
        username: 'sh4olan', displayName: 'sh4olan',
        transcript: '… cozy room tour, chatting with you all …',
        overview: 'sh4olan streams as an irl creator who chats with viewers from a cozy, decor-filled room.',
        line: 'Streams as an irl creator who chats with viewers from a cozy, decor-filled room.',
    },
    {
        name: 'beyond the owner\u2019s rule (sex acts): fallback, never the line',
        username: 'badactor', displayName: 'badactor',
        transcript: '…',
        overview: 'badactor streams pornographic content every night with explicit adult videos.',
        line: FALLBACK_CHANNEL_LINE,
    },
];

assert.strictEqual(FIXTURES.length, 10, 'ten transcripts');
for (const f of FIXTURES) {
    const line = shapeChannelLine({ username: f.username, displayName: f.displayName, overview: f.overview });
    assert.strictEqual(line, f.line, f.name);
    assert.match(line, CHANNEL_LINE_RE, `${f.name}: ${line}`);
    assert.ok(line.length <= 90, `${f.name}: ${line.length} chars`);
    assert.ok(!line.includes(':'), `${f.name}: no colon`);
    assert.ok(!/\b(?:streamed|used to|was|were|had|played|hosted|presented)\b/i.test(line), `${f.name}: present tense`);
    assert.ok(!line.toLowerCase().startsWith(f.username.toLowerCase()), `${f.name}: no name at the start`);
    assert.ok(!line.toLowerCase().startsWith(String(f.displayName || '').toLowerCase()), `${f.name}: no display name at the start`);
}
// A comma inside one adjective list is not a sentence break: the line cuts at a whole joining phrase
// instead of ending on "blocky." or "dark." (the home card showed those on 2026-11-10).
const TRIM = [
    { overview: 'moosely streams with a casual, homey vibe centered around acoustic guitar sessions and laid-back chats.', line: 'Streams with a casual, homey vibe centered around acoustic guitar sessions.' },
    { overview: 'drbagelsmp streams Minecraft with bold purple lighting and blocky, imaginative builds that draw you into a colorful, creative world.', line: 'Streams Minecraft with bold purple lighting.' },
    { overview: 'mrcodygraves streams as an IRL creator, often centered in a dark, minimalist setup with a headset and a Champion shirt.', line: 'Streams as an IRL creator, often centered in a dark, minimalist setup.' },
    { overview: '1n1xx streams a mix of fast-paced first-person shooters and arcade-style Roblox-style obstacle courses, with on-screen chat.', line: 'Streams a mix of fast-paced first-person shooters.' },
    { overview: 'Bobdope streams as an irl content creator sharing underwater marine life footage, turtle and reef scenes, and other real-world aquatic views.', line: 'Streams as an irl content creator sharing underwater marine life footage.' },
    { overview: 'Telegram_a1z69 streams in a desktop-focused setup, often featuring a dim mobile screen and a dark, indistinct background.', line: 'Streams in a desktop-focused setup, often featuring a dim mobile screen.' },
];
for (const t of TRIM) {
    const line = shapeChannelLine({ username: 'x', displayName: 'x', overview: t.overview });
    assert.strictEqual(line, t.line, t.overview.slice(0, 40));
    assert.match(line, CHANNEL_LINE_RE);
    assert.ok(line.length <= 90);
}

assert.match(FALLBACK_CHANNEL_LINE, CHANNEL_LINE_RE, 'the fallback is the same shape');
assert.strictEqual(shapeChannelLine(), FALLBACK_CHANNEL_LINE, 'no arguments');
assert.strictEqual(shapeChannelLine({ overview: null }), FALLBACK_CHANNEL_LINE, 'null overview');
assert.strictEqual(shapeChannelLine({ username: 'Maticus', displayName: 'Maticus', overview: '{"overview":"Maticus streams chess and cooking."}' }), 'Streams chess and cooking.', 'JSON-wrapped model text');
// The AI's own card line (ask 363, 2026-11-11): kept when it reads as a person wrote it, else the shape above.
{
    const { humanLine, cardLine } = require('../server/ai/channel-line');
    const names = { username: 'Maticus', displayName: 'Maticus' };
    assert.strictEqual(humanLine('Robots, cameras and late-night tinkering, with chat riding along.', names), 'Robots, cameras and late-night tinkering, with chat riding along.');
    assert.strictEqual(humanLine('cozy acoustic sets and requests from a kitchen table', names), 'Cozy acoustic sets and requests from a kitchen table.', 'a capital and a full stop');
    assert.strictEqual(humanLine('Maticus builds robots in his kitchen.', names), null, 'the card shows the name already');
    assert.strictEqual(humanLine('Streams robots and cameras.', names), null, 'the reshaped shape is the fallback\'s own');
    assert.strictEqual(humanLine('A vibrant mix of tech content.', names), null, 'the stock words');
    assert.strictEqual(humanLine('Chess. Then cooking for everyone.', names), null, 'one sentence');
    assert.strictEqual(humanLine('Robots: built, broken, built again.', names), null, 'no colon');
    assert.strictEqual(humanLine('Short.', names), null, 'too short to say anything');
    assert.strictEqual(cardLine({ ...names, overview: 'Maticus streams chess and cooking.', line: 'A dynamic journey.' }), 'Streams chess and cooking.', 'a stock line falls back to the shape');
    assert.strictEqual(cardLine({ ...names, overview: 'Maticus streams chess.', line: 'Chess openings argued over with chat, one blunder at a time.' }), 'Chess openings argued over with chat, one blunder at a time.');
}
console.log('channel-line shape: all checks passed');
