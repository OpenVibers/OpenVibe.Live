/**
 * A donation is sent once (public/js/vibes.js doDonate): a second click while the first is on its way does nothing,
 * and every request carries an Idempotency-Key, reused when the same donation is tried again after an unanswered
 * request (OpenVibe.Billing replays a known key instead of moving the Vibes twice). The SPA's api() helper
 * (public/js/app.js) adds caller headers to its defaults; it used to replace them, dropping Authorization.
 *
 *   node test/donate-idempotency.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
const fnSource = (src, name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    // A top-level function ends at the first line that is only a closing brace.
    return src.slice(src.lastIndexOf('\n', start) + 1, src.indexOf('\n}\n', start) + 2);
};

(async () => {
    // api(): caller headers join the defaults.
    const appSrc = read('app.js');
    const fetched = [];
    // eslint-disable-next-line no-new-func
    const api = new Function('fetch', 'API', 'authHeaders', 'tryRefreshToken', `${fnSource(appSrc, 'api')}; return api;`)(
        async (url, init) => { fetched.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
        '', () => ({ Authorization: 'Bearer t' }), async () => false);
    await api('/funds/donate', { method: 'POST', headers: { 'Idempotency-Key': 'k1' }, body: { a: 1 } });
    assert.deepStrictEqual(fetched[0].init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer t', 'Idempotency-Key': 'k1' });
    assert.strictEqual(fetched[0].init.method, 'POST');
    assert.strictEqual(fetched[0].init.body, '{"a":1}');
    assert.ok(!('_retried' in fetched[0].init), 'internal flags stay out of fetch');

    // doDonate(): one in flight, one key per donation.
    const vibesSrc = read('vibes.js');
    const start = vibesSrc.indexOf('async function doDonate(');
    const end = vibesSrc.indexOf('\n}\n', vibesSrc.indexOf('function _newRequestKey(')) + 3;
    const fields = { 'modal-donate-amount': { value: '250' }, 'modal-donate-message': { value: 'gg' }, 'modal-donate-goal': { value: '' }, 'modal-donate-send': { disabled: false } };
    const calls = [];
    let answer = null;
    const toasts = [];
    const env = {
        currentUser: { id: 1 },
        document: { getElementById: (id) => fields[id] || null },
        window: { crypto: { randomUUID: (() => { let n = 0; return () => `uuid-${++n}`; })() } },
        crypto: null,
        api: (p, o) => { calls.push({ p, o, disabled: fields['modal-donate-send'].disabled }); return answer(); },
        toast: (m, k) => toasts.push(k),
        showModal: () => {}, closeModal: () => {}, loadBalance: () => {},
        _donateStreamerId: () => 7,
    };
    env.crypto = env.window.crypto;
    // eslint-disable-next-line no-new-func
    const doDonate = new Function(...Object.keys(env), `${vibesSrc.slice(start, end)}; return doDonate;`)(...Object.values(env));

    let release;
    answer = () => new Promise((resolve) => { release = resolve; });
    const first = doDonate();
    await doDonate();
    assert.strictEqual(calls.length, 1, 'a second click while the first is on its way sends nothing');
    assert.strictEqual(calls[0].disabled, true, 'the button is disabled while it is on its way');
    release({ success: true });
    await first;
    assert.strictEqual(fields['modal-donate-send'].disabled, false);
    const k1 = calls[0].o.headers['Idempotency-Key'];
    assert.match(k1, /^donate-uuid-/);

    answer = async () => { throw new TypeError('Failed to fetch'); };
    await doDonate();
    const k2 = calls[1].o.headers['Idempotency-Key'];
    assert.notStrictEqual(k2, k1, 'a new donation after a sent one: a new key');
    answer = async () => { throw { status: 502, message: 'Bad gateway' }; };
    await doDonate();
    assert.strictEqual(calls[2].o.headers['Idempotency-Key'], k2, 'no answer, then a 502: trying again reuses the key');
    answer = async () => ({ success: true });
    await doDonate();
    assert.strictEqual(calls[3].o.headers['Idempotency-Key'], k2, 'and the retry that lands still uses it');

    answer = async () => { throw { status: 400, message: 'Insufficient Vibes' }; };
    await doDonate();
    const k3 = calls[4].o.headers['Idempotency-Key'];
    answer = async () => ({ success: true });
    await doDonate();
    assert.notStrictEqual(calls[5].o.headers['Idempotency-Key'], k3, 'a refused donation is over: trying again is a new request');

    answer = async () => { throw new TypeError('Failed to fetch'); };
    await doDonate();
    fields['modal-donate-amount'].value = '300';
    answer = async () => ({ success: true });
    await doDonate();
    assert.notStrictEqual(calls[7].o.headers['Idempotency-Key'], calls[6].o.headers['Idempotency-Key'], 'a different amount is a different donation');
    assert.strictEqual(calls[7].o.body.amount, 300);
    console.log('donate idempotency: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
