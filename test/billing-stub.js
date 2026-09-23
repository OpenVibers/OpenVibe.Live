'use strict';
/**
 * Stand-ins for OpenVibe.Network and OpenVibe.Billing, used by the BILLING_AUTHORITY tests.
 * Not a test file itself (run.js only picks *.test.js).
 *
 *   startNetwork()  /oauth/token (client_credentials; caps per audience, `grants` editable) and
 *                   /internal/identity/resolve-batch (live user id -> subject, `legacy` editable)
 *   startBilling()  the parts of Billing's /api/v1 that Live calls, with Billing's own rules for
 *                   what matters here: RS256 service token for audience openvibe.billing, ONE
 *                   capability per route, Idempotency-Key on every POST (replay returns the stored
 *                   answer with Idempotent-Replayed: true), problem+json errors, funds checks,
 *                   self-dealing refused by subject. Every call is recorded in `calls`.
 *                   state: { delayMs, fail500, closed } to simulate trouble.
 */
const http = require('http');
const crypto = require('crypto');
const { serviceAuth, http: ovHttp, ids } = require('openvibe-contracts');

const read = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
const send = (res, status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const problem = (res, status, code, detail, extra) => { res.writeHead(status, { 'Content-Type': 'application/problem+json' }); res.end(JSON.stringify(ovHttp.problem(status, code, { detail, extra }))); };
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

const LIVE_BILLING_GRANTS = ['billing.intent.create', 'billing.transfer.create', 'billing.balance.read', 'billing.cashout.request', 'billing.subscription.manage', 'billing.entitlement.check'];

async function startNetwork() {
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const grants = { 'openvibe.billing': [...LIVE_BILLING_GRANTS], 'openvibe.network': ['identity.subject.resolve'] };
    const legacy = {};          // live user id -> usr_
    const tokens = [];
    const server = http.createServer(async (req, res) => {
        const raw = await read(req);
        if (req.url === '/oauth/token') {
            const body = new URLSearchParams(raw);
            const aud = body.get('audience');
            tokens.push({ aud, client: body.get('client_id') });
            const now = Math.floor(Date.now() / 1000);
            const claims = { iss: 'https://openvibe.network', sub: `svc:${body.get('client_id')}`, actor_type: 'service', aud: [aud], cap: grants[aud] || [], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` };
            return send(res, 200, { access_token: serviceAuth.signServiceToken(claims, keys.privateKey), expires_in: 300 });
        }
        if (req.url === '/internal/identity/resolve-batch') {
            const { ids: want } = JSON.parse(raw || '{}');
            return send(res, 200, { results: Object.fromEntries((want || []).map((id) => [id, legacy[id] ? { subject: { type: 'user', id: legacy[id] } } : null])) });
        }
        send(res, 404, {});
    });
    const url = await listen(server);
    return { url, publicKey: keys.publicKey, grants, legacy, tokens, close: () => new Promise((r) => server.close(r)) };
}

const CAP = [
    ['POST', /^\/intents$/, 'billing.intent.create'], ['GET', /^\/intents\/[^/]+$/, 'billing.intent.create'], ['POST', /^\/intents\/[^/]+\/capture$/, 'billing.intent.create'],
    ['POST', /^\/transfers$/, 'billing.transfer.create'], ['POST', /^\/transfers\/[^/]+\/refund$/, 'billing.transfer.create'],
    ['POST', /^\/recycle$/, 'billing.cashout.request'], ['POST', /^\/cashouts$/, 'billing.cashout.request'],
    ['POST', /^\/subscriptions$/, 'billing.subscription.manage'], ['POST', /^\/subscriptions\/[^/]+\/cancel$/, 'billing.subscription.manage'],
    ['GET', /^\/subscriptions$/, 'billing.entitlement.check'], ['GET', /^\/entitlements\/[^/]+$/, 'billing.entitlement.check'],
    ['GET', /^\/balances\/[^/]+$/, 'billing.balance.read'], ['GET', /^\/transactions$/, 'billing.balance.read'],
    ['GET', /^\/rates$/, null],
];

async function startBilling({ network }) {
    const calls = [];
    const state = { delayMs: 0, fail500: false };
    const credit = {};
    const payable = {};
    const txns = [];
    const subs = [];
    const intents = [];
    const idem = new Map();
    const newId = (p) => `${p}_${ids.ulid()}`;
    const bal = (m, s) => m[s] || 0;
    const txn = (t) => { const x = { id: newId('txn'), status: 'settled', test: false, created_at: new Date().toISOString(), entries: [], metadata: {}, ...t }; txns.push(x); return x; };
    const subject = (v) => (v && typeof v === 'object' ? v.id : v);

    function route(method, path, q, b, res) {
        let m;
        if (method === 'GET' && path === '/rates') {
            return send(res, 200, { bits_per_usd: 100, min_purchase_bits: 100, subscription: { price_cents: 499, streamer_share_pct: 70, site_route_fee_pct: 10 }, cashout: { min_bits: 500, escrow_days: 14 }, providers: { powerchat: true, stripe: true } });
        }
        if (method === 'POST' && path === '/intents') {
            const kind = b.kind;
            const i = { id: newId('pi'), provider: b.provider, provider_ref: b.provider === 'powerchat' ? null : `prov_${intents.length + 1}`, kind, subject: { type: 'user', id: subject(b.subject) }, streamer: b.streamer ? { type: 'user', id: subject(b.streamer) } : null, bits: kind === 'purchase' ? b.bits : 0, route: kind === 'subscription' ? (b.route === 'direct' ? 'direct' : (b.provider === 'powerchat' ? 'site' : null)) : null, auto_renew: !!b.auto_renew, status: 'created' };
            if (i.streamer && i.streamer.id === i.subject.id) return problem(res, 422, 'billing.self_dealing', 'you cannot subscribe to yourself');
            i.fee_cents = i.route === 'site' ? 50 : 0;
            i.amount_cents = kind === 'purchase' ? Math.round(b.bits * 1.5) : 499 + i.fee_cents;
            if (b.provider === 'powerchat') i.checkout_ref = `${kind === 'purchase' ? 'pcorder' : 'pcsub'}:${i.id}`;
            intents.push(i);
            return send(res, 201, { intent: i, checkout_url: b.provider === 'powerchat' ? null : `https://checkout.test/${i.id}` });
        }
        if (method === 'POST' && (m = path.match(/^\/intents\/([^/]+)\/capture$/))) {
            const i = intents.find((x) => x.id === m[1]);
            if (!i) return problem(res, 404, 'billing.intent_not_found', `no intent ${m[1]}`);
            i.status = 'settled';
            return send(res, 200, { result: { effect: 'purchase' }, intent: i });
        }
        if (method === 'POST' && path === '/transfers') {
            const from = subject(b.from); const to = subject(b.to);
            if (from === to) return problem(res, 422, 'billing.self_dealing', 'a transfer to yourself would turn bought credit into withdrawable money');
            if (bal(credit, from) < b.amount) return problem(res, 409, 'billing.insufficient_funds', `insufficient credit: ${bal(credit, from)} < ${b.amount} vibes-bits`, { details: { available: bal(credit, from), required: b.amount } });
            credit[from] = bal(credit, from) - b.amount; payable[to] = bal(payable, to) + b.amount;
            const t = txn({ type: 'donation', from_subject: from, to_subject: to, metadata: { kind: b.kind, amount_bits: b.amount, target: b.target || null, message: b.message || null } });
            return send(res, 201, { transaction: t, balance: { credit: credit[from] } });
        }
        if (method === 'POST' && (m = path.match(/^\/transfers\/([^/]+)\/refund$/))) {
            const orig = txns.find((x) => x.id === m[1]);
            if (!orig) return problem(res, 404, 'billing.transaction_not_found', `no donation ${m[1]}`);
            const amount = b.amount || orig.metadata.amount_bits;
            if (bal(payable, orig.to_subject) < amount) return problem(res, 409, 'billing.insufficient_funds', "insufficient recipient's payable", { details: { available: bal(payable, orig.to_subject), required: amount } });
            payable[orig.to_subject] -= amount; credit[orig.from_subject] = bal(credit, orig.from_subject) + amount;
            return send(res, 201, { transaction: txn({ type: 'refund', reverses_txn: orig.id, from_subject: orig.to_subject, to_subject: orig.from_subject, metadata: { amount_bits: amount, reason: b.reason || null } }) });
        }
        if (method === 'POST' && path === '/recycle') {
            const s = subject(b.subject);
            if (bal(payable, s) < b.amount) return problem(res, 409, 'billing.insufficient_funds', 'insufficient creator payable', { details: { available: bal(payable, s), required: b.amount } });
            payable[s] -= b.amount; credit[s] = bal(credit, s) + b.amount;
            return send(res, 201, { transaction: txn({ type: 'recycle', from_subject: s, to_subject: s, metadata: { amount_bits: b.amount } }), balance: { credit: credit[s], payable: payable[s] } });
        }
        if (method === 'POST' && path === '/cashouts') {
            const s = subject(b.subject);
            if (b.amount < 500) return problem(res, 422, 'billing.amount_too_small', 'the minimum cashout is 500 bits');
            if (bal(payable, s) < b.amount) return problem(res, 409, 'billing.insufficient_funds', 'insufficient creator payable', { details: { available: bal(payable, s), required: b.amount } });
            payable[s] -= b.amount;
            const t = txn({ type: 'cashout_request', from_subject: s, metadata: { amount_bits: b.amount } });
            return send(res, 201, { cashout: { id: newId('co'), subject: { type: 'user', id: s }, amount_bits: b.amount, value_cents: b.amount, status: 'requested', payout_method: b.payout_method, escrow_until: new Date(Date.now() + 14 * 86_400_000).toISOString(), request_txn: t.id } });
        }
        if (method === 'POST' && path === '/subscriptions') {
            const sub = subject(b.subscriber); const str = subject(b.streamer);
            if (sub === str) return problem(res, 422, 'billing.self_dealing', 'you cannot subscribe to yourself');
            if (bal(credit, sub) < 499) return problem(res, 409, 'billing.insufficient_funds', `insufficient credit: ${bal(credit, sub)} < 499 vibes-bits`, { details: { available: bal(credit, sub), required: 499 } });
            credit[sub] -= 499; payable[str] = bal(payable, str) + 349;
            let s = subs.find((x) => x.subscriber.id === sub && x.streamer.id === str);
            const end = new Date(Date.now() + 30 * 86_400_000).toISOString();
            if (!s) { s = { id: newId('sub'), subscriber: { type: 'user', id: sub }, streamer: { type: 'user', id: str }, tier: 1, provider: 'credit', status: 'active', auto_renew: !!b.auto_renew, cancel_at_period_end: false, price_cents: 499, created_at: new Date().toISOString() }; subs.push(s); }
            Object.assign(s, { status: 'active', current_period_end: end, auto_renew: !!b.auto_renew });
            const t = txn({ type: 'subscription', from_subject: sub, to_subject: str, metadata: { cost_bits: 499, share_bits: 349, renewal: false } });
            return send(res, 201, { subscription: s, entitlement: { active: true, expires_at: end }, transaction: t });
        }
        if (method === 'POST' && (m = path.match(/^\/subscriptions\/([^/]+)\/cancel$/))) {
            const s = subs.find((x) => x.id === m[1]);
            if (!s) return problem(res, 404, 'billing.subscription_not_found', `no subscription ${m[1]}`);
            Object.assign(s, { cancel_at_period_end: true, auto_renew: false });
            return send(res, 200, { subscription: s, provider_sync: 'not_needed' });
        }
        if (method === 'GET' && path === '/subscriptions') {
            return send(res, 200, { subscriptions: subs.filter((s) => (!q.get('subscriber') || s.subscriber.id === q.get('subscriber')) && (!q.get('streamer') || s.streamer.id === q.get('streamer')) && (!q.get('status') || s.status === q.get('status'))) });
        }
        if (method === 'GET' && (m = path.match(/^\/entitlements\/([^/]+)$/))) {
            const s = subs.find((x) => x.subscriber.id === m[1] && x.streamer.id === q.get('streamer') && x.status === 'active' && Date.parse(x.current_period_end) > Date.now());
            return send(res, 200, { subject: { type: 'user', id: m[1] }, streamer: { type: 'user', id: q.get('streamer') }, active: !!s, expires_at: s ? s.current_period_end : null });
        }
        if (method === 'GET' && (m = path.match(/^\/balances\/([^/]+)$/))) {
            return send(res, 200, { subject: { type: 'user', id: m[1] }, currency: 'vibes-bits', credit: bal(credit, m[1]), payable: bal(payable, m[1]), pending_payouts: 0, payable_value_cents: bal(payable, m[1]), bits_per_usd: 100 });
        }
        if (method === 'GET' && path === '/transactions') {
            const s = q.get('subject');
            return send(res, 200, { transactions: txns.filter((t) => t.from_subject === s || t.to_subject === s).reverse(), next_cursor: null });
        }
        return problem(res, 404, 'not_found', `${method} ${path}`);
    }

    const server = http.createServer(async (req, res) => {
        const raw = await read(req);
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/ready') return send(res, 200, { ready: true });
        if (!u.pathname.startsWith('/api/v1/')) return send(res, 404, {});
        const path = u.pathname.slice('/api/v1'.length);
        const body = raw ? JSON.parse(raw) : {};
        const auth = String(req.headers.authorization || '');
        const v = serviceAuth.verifyServiceToken(auth.slice(7), { publicKey: network.publicKey, audience: 'openvibe.billing' });
        const rule = CAP.find(([m, re]) => m === req.method && re.test(path));
        const call = { method: req.method, path, query: Object.fromEntries(u.searchParams), key: req.headers['idempotency-key'] || null, body, cap: rule ? rule[2] : undefined, principal: v.ok ? v.claims.sub : null, traceparent: req.headers.traceparent || null };
        calls.push(call);
        if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
        if (!v.ok) return problem(res, 401, v.code, v.reason);
        if (!rule) return problem(res, 404, 'not_found', path);
        if (rule[2] && !(v.claims.cap || []).includes(rule[2])) return problem(res, 403, 'capability.denied', `${rule[2]} not granted`);
        if (state.fail500) return problem(res, 500, 'billing.internal', 'internal error');
        if (req.method === 'POST') {
            if (!/^[A-Za-z0-9._:-]{8,200}$/.test(call.key || '')) return problem(res, 400, 'idempotency.key_required', 'mutating calls need an Idempotency-Key header');
            const hash = crypto.createHash('sha256').update(`${req.method} ${path}\n${raw}`).digest('hex');
            const prior = idem.get(call.key);
            if (prior) {
                if (prior.hash !== hash) return problem(res, 422, 'idempotency.key_reused', 'this Idempotency-Key was used for a different request');
                call.replayed = true;
                return send(res, prior.status, prior.body, { 'Idempotent-Replayed': 'true' });
            }
            const json = res.end.bind(res);
            res.end = (chunk) => {
                if (res.statusCode >= 200 && res.statusCode < 300) idem.set(call.key, { hash, status: res.statusCode, body: JSON.parse(chunk) });
                return json(chunk);
            };
        }
        return route(req.method, path, u.searchParams, body, res);
    });
    const url = await listen(server);
    return {
        url, calls, state, credit, payable, txns, subs, intents,
        fund: (s, bits) => { credit[s] = bal(credit, s) + bits; },
        close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }),
    };
}

module.exports = { startNetwork, startBilling, LIVE_BILLING_GRANTS };
