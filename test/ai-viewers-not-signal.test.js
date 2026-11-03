'use strict';
// Live's own AI viewers are not evidence that a moment landed (item 151, C07): they never count as "a crowd reacted"
// (recentChatters) and their lines never reach the AI's clip confirmation (recentChatText). Chat's timeline leaves them
// out of the spike counts on its side (Chat #338).
const assert = require('assert');
console.warn = () => {};

const client = require('../server/chat/chat-client');
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
client.available = () => true;
client.readMessages = async () => ({ messages: [
    { user_id: 1, username: 'ann', message: 'NO WAY', source_platform: null, timestamp: now() },
    { user_id: 2, username: 'bob', message: 'clip it', source_platform: null, timestamp: now() },
    { user_id: null, username: 'Sora (AI)', message: 'what a play!', source_platform: 'ai', timestamp: now() },
    { user_id: null, username: 'Kai (AI)', message: 'insane', source_platform: 'ai', timestamp: now() },
    { user_id: null, username: 'twitchfan', message: 'LUL', source_platform: 'twitch', timestamp: now() },
] });
const chatReads = require('../server/chat/chat-reads');

(async () => {
    assert.strictEqual(await chatReads.recentChatters(9001, 60), 3, 'ann, bob and the Twitch viewer; never the AI viewers');
    const text = await chatReads.recentChatText(9002, 120);
    assert.ok(!text.includes('what a play!') && !text.includes('insane'), 'the AI viewers\' lines never reach the confirm step');
    assert.ok(text.includes('NO WAY') && text.includes('LUL'), 'people, relayed ones included, do');
    console.log('ai viewers are not a signal: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
