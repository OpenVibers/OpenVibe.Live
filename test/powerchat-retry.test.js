// Unit tests for the PowerChat 429 / Retry-After policy (no DB, no network).
const assert = require('assert');
const { parseRetryAfter, isRetryable, backoffDelay, withRetry } = require('../server/integrations/powerchat-retry');

const httpErr = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

(async () => {
    // ── parseRetryAfter ────────────────────────────────────────────
    assert.strictEqual(parseRetryAfter('2'), 2000);
    assert.strictEqual(parseRetryAfter(' 0.5 '), 500);
    assert.strictEqual(parseRetryAfter('0'), 0);
    const now = Date.parse('2026-08-27T10:00:00Z');
    assert.strictEqual(parseRetryAfter('Thu, 27 Aug 2026 10:00:07 GMT', now), 7000);
    assert.strictEqual(parseRetryAfter('Thu, 27 Aug 2026 09:59:00 GMT', now), 0, 'past date clamps to 0');
    assert.strictEqual(parseRetryAfter(undefined), null);
    assert.strictEqual(parseRetryAfter(''), null);
    assert.strictEqual(parseRetryAfter('soon'), null);

    // ── isRetryable ────────────────────────────────────────────────
    assert.strictEqual(isRetryable(429), true);
    assert.strictEqual(isRetryable(503), true);
    assert.strictEqual(isRetryable(503, { idempotent: false }), false, '5xx is not replayed for non-idempotent calls');
    assert.strictEqual(isRetryable(429, { idempotent: false }), true, '429 is always safe: nothing was processed');
    for (const s of [400, 401, 403, 404, 409, 422]) assert.strictEqual(isRetryable(s), false, `${s} must never retry`);
    assert.strictEqual(isRetryable(undefined), false);

    // ── backoffDelay ───────────────────────────────────────────────
    assert.strictEqual(backoffDelay({ attempt: 1, retryAfterMs: 1234, random: () => 0 }), 1234, 'Retry-After wins');
    assert.strictEqual(backoffDelay({ attempt: 1, baseMs: 500, random: () => 0 }), 250, 'lower jitter bound is step/2');
    assert.strictEqual(backoffDelay({ attempt: 1, baseMs: 500, random: () => 0.999999 }), 500);
    assert.strictEqual(backoffDelay({ attempt: 3, baseMs: 500, random: () => 1 }), 2000, 'doubles per attempt');
    assert.strictEqual(backoffDelay({ attempt: 10, baseMs: 500, capMs: 8000, random: () => 1 }), 8000, 'capped');
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 200; i++) { const d = backoffDelay({ attempt: 2 }); lo = Math.min(lo, d); hi = Math.max(hi, d); }
    assert.ok(lo >= 500 && hi <= 1000, `jitter stays inside [500,1000] (got ${lo}..${hi})`);

    // ── withRetry ──────────────────────────────────────────────────
    const sleeps = [];
    const sleep = async (ms) => { sleeps.push(ms); };

    // 429 with Retry-After: waits exactly what the server said, then succeeds.
    let calls = 0;
    const r1 = await withRetry(async () => { calls++; if (calls < 3) throw httpErr(429, { retryAfterMs: 1500 }); return 'ok'; }, { sleep, attempts: 3 });
    assert.strictEqual(r1, 'ok');
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(sleeps, [1500, 1500]);

    // 429 without Retry-After: exponential backoff with jitter (deterministic random here).
    sleeps.length = 0; calls = 0;
    await withRetry(async () => { calls++; if (calls < 3) throw httpErr(429); return 1; }, { sleep, attempts: 3, baseMs: 100, random: () => 1 });
    assert.deepStrictEqual(sleeps, [100, 200]);

    // Attempts are capped: the last failure propagates unchanged.
    sleeps.length = 0; calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw httpErr(429); }, { sleep, attempts: 3, random: () => 0 }), (e) => e.status === 429);
    assert.strictEqual(calls, 3);
    assert.strictEqual(sleeps.length, 2, 'no sleep after the final attempt');

    // A non-429 4xx is never retried.
    for (const s of [400, 401, 403, 404]) {
        sleeps.length = 0; calls = 0;
        await assert.rejects(withRetry(async () => { calls++; throw httpErr(s); }, { sleep }), (e) => e.status === s);
        assert.strictEqual(calls, 1, `${s} tried once`);
        assert.strictEqual(sleeps.length, 0);
    }

    // 5xx: retried for idempotent calls, not for non-idempotent ones.
    calls = 0;
    assert.strictEqual(await withRetry(async () => { calls++; if (calls === 1) throw httpErr(502); return 'up'; }, { sleep, random: () => 0 }), 'up');
    assert.strictEqual(calls, 2);
    calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw httpErr(502); }, { sleep, idempotent: false }), (e) => e.status === 502);
    assert.strictEqual(calls, 1, 'non-idempotent 5xx is not replayed');

    // A Retry-After beyond the wait budget ends the call instead of parking it.
    sleeps.length = 0; calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw httpErr(429, { retryAfterMs: 120000 }); }, { sleep, maxWaitMs: 30000 }), (e) => /wait budget/.test(e.gaveUp));
    assert.strictEqual(calls, 1);
    assert.strictEqual(sleeps.length, 0);

    // Errors without an HTTP status (network) are not retried.
    calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw new Error('ECONNRESET'); }, { sleep }), /ECONNRESET/);
    assert.strictEqual(calls, 1);

    // onRetry observer sees attempt/status/delay and cannot break the loop.
    const seen = [];
    await withRetry(async (a) => { if (a < 2) throw httpErr(429, { retryAfterMs: 5 }); return a; }, { sleep, onRetry: (i) => { seen.push(i); throw new Error('observer bug'); } });
    assert.deepStrictEqual(seen, [{ attempt: 1, status: 429, delay: 5 }]);

    console.log('✅ powerchat retry policy tests passed');
})().catch((e) => { console.error('❌', e); process.exit(1); });
