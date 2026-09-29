'use strict';
/**
 * Chat translation without waste: public/js/lang-detect.js (shared by the browser and server/i18n/translate.js) says
 * which lines are in another language without a model call, and translateMany (the batch behind auto-translate)
 * answers same-language and cached lines itself and sends the rest to the model in one call.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-lang-'));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, 'live.db');

const L = require('../public/js/lang-detect');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

(async () => {
    await check('detection: scripts, Latin-script languages by their words and letters; slang and one short word stay unknown', async () => {
        const lang = (s) => L.detect(s).lang;
        assert.strictEqual(lang('こんにちは、元気ですか'), 'ja');
        assert.strictEqual(lang('안녕하세요'), 'ko');
        assert.strictEqual(lang('Привет как дела'), 'ru');
        assert.strictEqual(lang('Hola, ¿cómo estás? Muy bien gracias'), 'es');
        assert.strictEqual(lang('Olá, tudo bem com você?'), 'pt');
        assert.strictEqual(lang('Bonjour, comment ça va ?'), 'fr');
        assert.strictEqual(lang('Guten Tag, wie geht es dir? Danke'), 'de');
        assert.strictEqual(lang('hello everyone how are you doing'), 'en');
        for (const s of ['gg', 'lol', 'pog', 'no', 'te amo', 'ok', ':Kappa:', 'https://example.com/x', '!sr song']) assert.strictEqual(lang(s), null, s);
    });

    await check('foreignFor: only lines confidently in another language than the viewer\'s get a button', async () => {
        assert.strictEqual(L.foreignFor('Hola, ¿cómo estás? Muy bien gracias', 'en'), 'es');
        assert.strictEqual(L.foreignFor('Hola, ¿cómo estás? Muy bien gracias', 'es'), null);
        assert.strictEqual(L.foreignFor('this stream is so good', 'en'), null);
        assert.strictEqual(L.foreignFor('this stream is so good', 'ja'), 'en');
        assert.strictEqual(L.foreignFor('gg', 'ja'), null, 'nothing to translate');
    });

    const llm = require('../server/ai/llm');
    const ai = require('../server/ai/ai-service');
    const i18n = require('../server/i18n/translate');
    llm.isEnabled = () => true;
    const calls = [];
    ai.structured = async (wf, input) => { calls.push(input); return { text: String(input.text).split('\n').map((l) => `[${input.to}] ${l}`).join('\n') }; };

    await check('server detection agrees: Spanish is Spanish now (it used to read as English and could not be translated)', async () => {
        assert.strictEqual(i18n.detectLang('Hola, ¿cómo estás? Muy bien gracias'), 'es');
        assert.strictEqual(i18n.detectLang('gg'), 'en', 'Latin text it cannot place stays English, as before');
        assert.strictEqual(i18n.detectLang('日本語'), 'zh');
    });

    await check('translateMany: same-language lines cost nothing, the rest go in ONE model call, and the next ask is cached', async () => {
        const texts = ['Hola, ¿cómo estás? Muy bien gracias', 'hello everyone how are you doing', 'Guten Tag, wie geht es dir? Danke', 'gg'];
        const r1 = await i18n.translateMany(texts, { to: 'en' });
        assert.strictEqual(calls.length, 1, 'one call for both foreign lines');
        assert.deepStrictEqual(r1.map((r) => r && (r.same ? 'same' : r.text)), ['[en] Hola, ¿cómo estás? Muy bien gracias', 'same', '[en] Guten Tag, wie geht es dir? Danke', null]);
        const r2 = await i18n.translateMany(texts.slice(0, 3), { to: 'en' });
        assert.strictEqual(calls.length, 1, 'answered from the cache');
        assert.strictEqual(r2[2].text, '[en] Guten Tag, wie geht es dir? Danke');
    });

    await check('auto-translation for everyone only when detection is sure', async () => {
        const n = calls.length;
        assert.strictEqual(await i18n.translateChatMessage('de nada', null), null, 'two words: left to the viewer\'s button');
        assert.strictEqual(calls.length, n);
        const t = await i18n.translateChatMessage('Hola, ¿cómo estás? Muy bien gracias amigo', null);
        assert.strictEqual(t.from, 'es'); assert.strictEqual(t.to, 'en');
    });

    console.log(`lang-detect: ${passed} checks passed`);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
