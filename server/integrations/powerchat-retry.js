/**
 * powerchat-retry.js — retry policy for PowerChat Developer API calls.
 *
 * PowerChat rate-limits per app with sliding windows (roughly 120/min reads + chat,
 * 60/min subs/currency/tips/view-count, 30/min alerts) and answers 429 with a
 * Retry-After header. Before this helper nothing honoured it: a chat burst or a
 * currency-earn flush that tripped the limit just failed every call for the rest
 * of the window (and, being best-effort, failed silently).
 *
 * Policy (deliberately small):
 *   - 429 → wait Retry-After when the server sends one, else exponential backoff
 *     with jitter (so a burst that got limited together doesn't retry together).
 *   - 5xx → same backoff, but ONLY when the caller says the call is idempotent
 *     (every intake POST carries an idempotency key — messageId / externalId — so
 *     a replay dedupes; display-only alert triggers have no key and must not be
 *     replayed into a double alert).
 *   - any other 4xx → never retried: a 400/401/403/404 fails identically forever.
 *   - capped attempts, and a Retry-After longer than we're willing to block on
 *     ends the call instead of parking a relay for a minute.
 *
 * Dependency-free on purpose: this file is unit-tested without the database.
 */
'use strict';

const DEFAULTS = Object.freeze({
    attempts: 3,        // total tries, including the first
    baseMs: 500,        // first backoff step
    capMs: 8000,        // longest computed backoff
    maxWaitMs: 30000,   // longest Retry-After we honour before giving up instead
});

/** Retry-After → milliseconds. Accepts delta-seconds or an HTTP-date; null if absent/garbage. */
function parseRetryAfter(value, now = Date.now()) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Math.round(Number(s) * 1000));
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/** Is this HTTP status worth another try? 429 always; 5xx only for idempotent calls. */
function isRetryable(status, { idempotent = true } = {}) {
    if (status === 429) return true;
    return idempotent && status >= 500 && status <= 599;
}

/**
 * Delay after the given (1-based) failed attempt. A server Retry-After always wins;
 * otherwise "equal jitter" backoff: uniformly inside [step/2, step] where
 * step = min(cap, base·2^(attempt-1)).
 */
function backoffDelay({ attempt, retryAfterMs = null, baseMs = DEFAULTS.baseMs, capMs = DEFAULTS.capMs, random = Math.random } = {}) {
    if (retryAfterMs != null && Number.isFinite(retryAfterMs)) return Math.max(0, Math.round(retryAfterMs));
    const step = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
    return Math.round(step / 2 + random() * (step / 2));
}

/**
 * Run `fn(attempt)` with the policy above. `fn` must throw an Error carrying
 * `.status` (HTTP status) and optionally `.retryAfterMs` for the policy to apply;
 * anything else (network failure without a status) is not retried — the callers
 * are best-effort relays and a dead network is not a rate limit.
 *
 * `sleep` / `random` / `now` are injectable for tests. `onRetry({attempt, status,
 * delay})` is called before each wait.
 */
async function withRetry(fn, opts = {}) {
    const attempts = Math.max(1, opts.attempts ?? DEFAULTS.attempts);
    const maxWaitMs = opts.maxWaitMs ?? DEFAULTS.maxWaitMs;
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastErr = err;
            const status = err && Number(err.status);
            if (!isRetryable(status, { idempotent: opts.idempotent !== false })) throw err;
            if (attempt === attempts) throw err;
            const delay = backoffDelay({
                attempt,
                retryAfterMs: err.retryAfterMs ?? null,
                baseMs: opts.baseMs, capMs: opts.capMs, random: opts.random,
            });
            if (delay > maxWaitMs) { err.gaveUp = `Retry-After ${Math.round(delay / 1000)}s exceeds the ${Math.round(maxWaitMs / 1000)}s wait budget`; throw err; }
            if (opts.onRetry) { try { opts.onRetry({ attempt, status, delay }); } catch { /* observer only */ } }
            await sleep(delay);
        }
    }
    throw lastErr;
}

module.exports = { DEFAULTS, parseRetryAfter, isRetryable, backoffDelay, withRetry };
