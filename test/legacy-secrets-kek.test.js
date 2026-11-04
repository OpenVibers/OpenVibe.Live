'use strict';
/**
 * D11: a secret-class value copied into site_settings is blanked at boot once the sealed config store holds it.
 * With a KEK the store's copy is an envelope; the row is blank, no summary/log carries the value, and every
 * reader (db.getSetting, the TTS settings) still gets it.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/legacy-secrets-kek.test.js
 */
const assert = require('assert');
process.env.NODE_ENV = 'test';
process.env.OV_CONFIG_KEKS = `k1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.OV_CONFIG_KEK_CURRENT = 'k1';

const SECRET = 'sentinel-not-a-secret-tts-key';
const logs = [];
const capture = (level) => (...a) => { logs.push(a.map(String).join(' ')); };
const real = { log: console.log, warn: console.warn, error: console.error };
console.log = capture('log'); console.warn = capture('warn'); console.error = capture('error');

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    await db.setSetting('tts_google_api_key', SECRET);
    await db.setSetting('tts_enabled', '1');
    await db.setSetting('motd', 'hello');

    const siteConfig = require('../server/admin/site-config');
    const report = await siteConfig.init();
    const store = await siteConfig.getStore();
    assert.strictEqual(store.sealed, true, 'the store is sealed under the KEK');
    assert.strictEqual(report.blanked, 1, 'the legacy secret value was blanked');
    assert.strictEqual(report.differs, 0, 'an equal value is not counted as differing');

    const row = await db.get('SELECT value, type FROM site_settings WHERE key = ?', ['tts_google_api_key']);
    assert.ok(row, 'the key keeps its typed slot');
    assert.strictEqual(row.value, '', 'no secret-class value remains in site_settings');
    assert.strictEqual((await db.get('SELECT value FROM site_settings WHERE key = ?', ['motd'])).value, 'hello', 'a non-secret row is untouched');

    const summary = JSON.stringify(await store.summary());
    const snapshot = JSON.stringify(await store.snapshot(store.revision()));
    assert.ok(!summary.includes(SECRET) && !snapshot.includes(SECRET), 'no summary or snapshot carries the value');
    const stored = await db.get("SELECT values_json FROM config_snapshots WHERE namespace = 'live.site_settings' AND state = 'active'");
    assert.ok(!stored.values_json.includes(SECRET), 'values_json holds no plaintext');
    assert.ok(stored.values_json.includes('"v1:'), 'the secret is stored as an envelope');
    assert.strictEqual((await store.summary()).values.tts_google_api_key.redacted, true);

    assert.strictEqual(await db.getSetting('tts_google_api_key'), SECRET, 'db.getSetting reads the store');
    const tts = await require('../server/chat/tts-engine').getTTSSettings();
    assert.strictEqual(tts.googleApiKey, SECRET, 'the TTS reader still gets its value');
    assert.ok(!logs.join('\n').includes(SECRET), 'no log line carries the value');

    // A change through the journal writes the non-secret rows and keeps the secret write-only in the store.
    await siteConfig.change({ set: { tts_google_api_key: 'sentinel-rotated', motd: 'welcome' } }, { reason: 'rotate' });
    assert.strictEqual((await db.get('SELECT value FROM site_settings WHERE key = ?', ['tts_google_api_key'])).value, '', 'a new secret is not written to the legacy row');
    assert.strictEqual(await db.getSetting('tts_google_api_key'), 'sentinel-rotated', 'the rotated value is read from the store');
    assert.ok(!JSON.stringify(await store.summary()).includes('sentinel-rotated'));

    // A legacy row newer than the store is kept, not blanked: the store does not hold this value.
    await siteConfig.change({ set: { tts_aws_secret_access_key: 'store-side-secret' } }, { reason: 'store side' });
    await db.setSetting('tts_aws_secret_access_key', 'legacy-side-secret');
    // A secret row the store does not hold at all is kept too.
    await db.setSetting('tts_aws_access_key_id', 'legacy-only-secret');
    const kept = await siteConfig.migrateLegacySecrets(store);
    assert.strictEqual(kept.blanked, 0, 'a differing value is never blanked');
    assert.strictEqual(kept.differs, 2, 'one unequal value and one the store does not hold');
    assert.strictEqual((await db.get('SELECT value FROM site_settings WHERE key = ?', ['tts_aws_secret_access_key'])).value, 'legacy-side-secret', 'the newer legacy value is kept');
    assert.strictEqual((await db.get('SELECT value FROM site_settings WHERE key = ?', ['tts_aws_access_key_id'])).value, 'legacy-only-secret', 'the only copy is kept');
    assert.strictEqual(await db.getSetting('tts_aws_secret_access_key'), 'store-side-secret', 'the reader keeps the store value');
    assert.ok(!logs.join('\n').includes('store-side-secret') && !logs.join('\n').includes('legacy-side-secret') && !logs.join('\n').includes('legacy-only-secret'), 'no log line carries either side');

    real.log('legacy secrets (KEK): all checks passed');
    process.exit(0);
})().catch((err) => { real.error(err); process.exit(1); });
