'use strict';
/**
 * D11: without a KEK the config store is not sealed and NOTHING in the legacy table is blanked. The reader still
 * gets the value (the store holds it, as today), so a service with no KEK keeps working unchanged.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/legacy-secrets-nokek.test.js
 */
const assert = require('assert');
process.env.NODE_ENV = 'test';
delete process.env.OV_CONFIG_KEKS;
delete process.env.OV_CONFIG_KEK_CURRENT;

const SECRET = 'sentinel-not-a-secret-no-kek';
const real = { log: console.log, error: console.error };
console.log = () => {}; console.warn = () => {}; console.error = () => {};

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    await db.setSetting('tts_google_api_key', SECRET);

    const siteConfig = require('../server/admin/site-config');
    const report = await siteConfig.init();
    const store = await siteConfig.getStore();
    assert.strictEqual(store.sealed, false, 'the store is not sealed without a KEK');
    assert.strictEqual(report.blanked, 0, 'nothing is blanked without a sealed store');

    const row = await db.get('SELECT value FROM site_settings WHERE key = ?', ['tts_google_api_key']);
    assert.strictEqual(row.value, SECRET, 'the only copy is still the legacy row');
    assert.strictEqual(await db.getSetting('tts_google_api_key'), SECRET, 'the reader still gets its value');
    const summary = JSON.stringify(await store.summary());
    assert.ok(!summary.includes(SECRET), 'the summary redacts it even unsealed');
    await assert.rejects(store.reseal(), /KEK/, 'reseal needs a KEK');

    real.log('legacy secrets (no KEK): all checks passed');
    process.exit(0);
})().catch((err) => { real.error(err); process.exit(1); });
