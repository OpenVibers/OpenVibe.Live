'use strict';
/**
 * N-1 harness (roadmap WS-P task 11, ADR-016's mixed-version window): the previous release's client
 * against this release's server, and the previous release's SQL against this release's schema.
 * The same file in Live, Chat, Media and Community; each repository's test/n-1/service.js says what
 * its clients are, how to boot and seed it, and where its SQL lives.
 *
 *   scripts/n-1-record.js <ref>   at release time: checks out <ref> (the release in production, which
 *                                 is N-1 for the next deploy) into a temporary worktree, boots it, and
 *                                 writes test/fixtures/n-1/{client,worker}.json
 *   test/n-1.test.js              in npm test and CI: boots this checkout on a database created with
 *                                 N-1's schema and replays the fixture; no git history, no network
 *
 * Client calls are found statically in the N-1 client code (the call sites of `api(...)`, `fetch(...)`
 * and the service's other wrappers, with a literal or template path), made concrete with sample values,
 * and replayed against the booted N-1 server: every call anonymously, reads again signed in. What the
 * fixture keeps per call is what an old client depends on: the status, whether the answer is JSON,
 * and the response fields it reads (the JSON key paths whose every key the N-1 client code names, with
 * their types).
 *
 * SQL is every statement N-1 prepared while it served those calls, plus every literal SQL string in its
 * server code that prepares on its own schema. The N-1 schema is its sqlite_master after the replay.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ── Client calls: static extraction ──────────────────────────

/** Reads a JS string/template literal at src[i] (a quote). → { end, parts: [{ text } | { expr }] } or null. */
function readLiteral(src, i) {
    const q = src[i];
    if (q !== '\'' && q !== '"' && q !== '`') return null;
    const parts = [];
    let text = '';
    let j = i + 1;
    while (j < src.length) {
        const c = src[j];
        if (c === '\\') { text += unescapeChar(src[j + 1]); j += 2; continue; }
        if (c === q) { if (text) parts.push({ text }); return { end: j + 1, parts }; }
        if (q !== '`' && c === '\n') return null;
        if (q === '`' && c === '$' && src[j + 1] === '{') {
            if (text) parts.push({ text });
            text = '';
            const close = skipBalanced(src, j + 1, '{', '}');
            if (close < 0) return null;
            parts.push({ expr: src.slice(j + 2, close).trim() });
            j = close + 1;
            continue;
        }
        text += c;
        j++;
    }
    return null;
}

function unescapeChar(c) {
    return { n: '\n', t: '\t', r: '\r', '0': '\0' }[c] ?? c ?? '';
}

/** Index of the bracket closing the one at src[i] (open), skipping strings and templates; -1 if none. */
function skipBalanced(src, i, open, close) {
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        const c = src[j];
        if (c === '\'' || c === '"' || c === '`') {
            const lit = readLiteral(src, j);
            if (lit) { j = lit.end - 1; continue; }
        }
        if (c === open) depth++;
        else if (c === close) { depth--; if (depth === 0) return j; }
    }
    return -1;
}

/** Top-level comma-separated arguments of a call whose '(' is at src[i]. */
function callArgs(src, i) {
    const end = skipBalanced(src, i, '(', ')');
    if (end < 0) return null;
    const args = [];
    let depth = 0; let start = i + 1;
    for (let j = i + 1; j < end; j++) {
        const c = src[j];
        if (c === '\'' || c === '"' || c === '`') { const lit = readLiteral(src, j); if (lit) { j = lit.end - 1; continue; } }
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        else if (c === ',' && depth === 0) { args.push(src.slice(start, j).trim()); start = j + 1; }
    }
    const last = src.slice(start, end).trim();
    if (last) args.push(last);
    return args;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** src split at every top-level `sep` (outside strings and brackets). */
function splitTop(src, sep) {
    const out = [];
    let depth = 0; let start = 0;
    for (let j = 0; j < src.length; j++) {
        const c = src[j];
        if (c === '\'' || c === '"' || c === '`') { const lit = readLiteral(src, j); if (lit) { j = lit.end - 1; continue; } }
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        else if (c === sep && depth === 0) { out.push(src.slice(start, j)); start = j + 1; }
    }
    out.push(src.slice(start));
    return out.map((x) => x.trim());
}

/**
 * The parts of a path expression: a literal, a template, or literals, templates and names joined with
 * `+` ('/api/x/' + id + '?a=1'); a name in `vars` stands for the path it was assigned. → parts or null
 */
function pathParts(expr, vars = new Map()) {
    const parts = [];
    for (const piece of splitTop(expr, '+')) {
        if (!piece) return null;
        const lit = /^['"`]/.test(piece) ? readLiteral(piece, 0) : null;
        if (lit && lit.end === piece.length) parts.push(...lit.parts.flatMap((x) => (x.expr && vars.has(unwrap(x.expr)) ? vars.get(unwrap(x.expr)) : [x])));
        else if (vars.has(piece)) parts.push(...vars.get(piece));
        else parts.push({ expr: piece });
    }
    const merged = [];
    for (const p of parts) {
        const last = merged[merged.length - 1];
        if (p.text != null && last && last.text != null) last.text += p.text; else merged.push({ ...p });
    }
    return merged;
}

/** `esc(base)`, `encodeURIComponent(base)`: the name inside one escaping call. */
function unwrap(expr) {
    const m = /^(?:esc|enc|encodeURI|encodeURIComponent|String|escapeHtml|escHtml)\(\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(String(expr).trim());
    return m ? m[1] : String(expr).trim();
}

/** `var|let|const name = <path expression>` in a file, for names later calls use as a path base. */
function pathVars(src) {
    const vars = new Map();
    for (const m of src.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?=['"`])/g)) {
        let depth = 0; let end = src.length;
        for (let j = m.index + m[0].length; j < src.length; j++) {
            const c = src[j];
            if (c === '\'' || c === '"' || c === '`') { const lit = readLiteral(src, j); if (lit) { j = lit.end - 1; continue; } }
            if (c === '(' || c === '{' || c === '[') depth++;
            else if (c === ')' || c === '}' || c === ']') { if (depth === 0) { end = j; break; } depth--; } else if (depth === 0 && (c === ';' || c === '\n' || c === ',')) { end = j; break; }
        }
        const parts = pathParts(src.slice(m.index + m[0].length, end).trim(), vars);
        if (parts && parts[0] && parts[0].text && parts[0].text.startsWith('/') && !parts[0].text.startsWith('//')) vars.set(m[1], parts);
    }
    return vars;
}

/**
 * Every call site of the service's request functions whose path is a literal, a template or a
 * concatenation starting with one (or with a variable assigned one).
 * callers: [{ name: 'api', prefix: '/api', method?: 'POST', methodArg?: 1 }]
 * strip: template expressions dropped when a path starts with them (e.g. 'API', 'location.origin')
 * keep(pathname, method, file): whether a call is this server's
 * → { calls: [{ method, template, parts, from: [file] }], dynamic: calls with a computed path }
 */
function extractCalls({ files, callers, strip = [], keep = (p) => true, forms = false }) {
    const found = new Map();
    let dynamic = 0;
    for (const { name: file, text: src } of files) {
        const vars = pathVars(src);
        for (const caller of callers) {
            const re = new RegExp(`(?<![\\w$.])${esc(caller.name)}\\s*\\(`, 'g');
            let m;
            while ((m = re.exec(src))) {
                const open = m.index + m[0].length - 1;
                const args = callArgs(src, open);
                if (!args || !args.length) continue;
                // An SDK-style call: call({ method: 'POST', path: `/api/x/${id}`, … }).
                let pathExpr = args[0];
                let objMethod = null;
                if (caller.object) {
                    if (!/^\{[\s\S]*\}$/.test(args[0])) continue;   // some other function of that name
                    const entries = splitTop(args[0].slice(1, -1), ',');
                    const entry = (k) => { const e = entries.find((x) => new RegExp(`^${k}\\s*:`).test(x)); return e ? e.replace(new RegExp(`^${k}\\s*:\\s*`), '') : null; };
                    pathExpr = entry('path');
                    const me = entry('method');
                    const ml = me && /^['"`]/.test(me) ? readLiteral(me, 0) : null;
                    if (ml && ml.parts.length === 1 && ml.parts[0].text) objMethod = ml.parts[0].text;
                    if (!pathExpr) continue;
                }
                let parts = pathParts(pathExpr, vars);
                if (!parts) { dynamic++; continue; }
                while (parts.length && parts[0].expr && strip.includes(parts[0].expr)) parts.shift();
                if (!parts.length || !parts[0].text || !parts[0].text.startsWith('/') || parts[0].text.startsWith('//')) {
                    if (parts.length && parts[0].expr) dynamic++;
                    continue;
                }
                parts = caller.prefix ? [{ text: caller.prefix }, ...parts] : parts;
                if (parts[1] && parts[0].text != null && parts[1].text != null) parts = [{ text: parts[0].text + parts[1].text }, ...parts.slice(2)];
                // `/api${path}`: a wrapper passing a path through, not a call.
                if (parts.some((p, k) => p.expr && k > 0 && parts[k - 1].text != null && !parts.slice(0, k).some((x) => x.text && x.text.includes('?')) && /[A-Za-z0-9]$/.test(parts[k - 1].text))) { dynamic++; continue; }
                const template = parts.map((p) => (p.text != null ? p.text : `{${p.expr}}`)).join('').replace(/^([^?#]*)\/\//, '$1/');
                let method = objMethod || caller.method || 'GET';
                if (caller.object) { /* the method was in the object */ } else if (caller.methodArg != null) {
                    const a = args[caller.methodArg];
                    const ml = a && /^['"`]/.test(a) ? readLiteral(a, 0) : null;
                    if (ml && ml.parts.length === 1 && ml.parts[0].text) method = ml.parts[0].text;
                } else {
                    const opts = args.slice(1).join(',');
                    const mm = /\bmethod\s*:\s*['"`]([A-Za-z]+)['"`]/.exec(opts);
                    if (mm) method = mm[1];
                }
                method = method.toUpperCase();
                if (!keep(template.split('?')[0], method, file)) continue;
                const key = `${method} ${template}`;
                if (!found.has(key)) found.set(key, { method, template, parts, from: new Set() });
                found.get(key).from.add(file);
            }
        }
    }
    // Forms the pages post (or get) to: <form action="/x/${id}" method="post"> in markup or a template.
    if (forms) {
        for (const { name: file, text: src } of files) {
            const vars = pathVars(src);
            for (const m of src.matchAll(/<form\b/gi)) {
                const end = tagEnd(src, m.index);
                if (end < 0) continue;
                const tag = src.slice(m.index, end);
                const action = attr(tag, 'action');
                if (!action || action.startsWith('//') || /^[a-z]+:/i.test(action)) continue;
                const parts = templateParts(action).flatMap((x) => (x.expr && vars.has(unwrap(x.expr)) ? vars.get(unwrap(x.expr)) : [x]));
                if (!parts.length || parts[0].text == null || !parts[0].text.startsWith('/')) continue;
                const methodAttr = attr(tag, 'method');
                const method = /^post$/i.test(methodAttr || '') ? 'POST' : 'GET';
                const template = parts.map((p) => (p.text != null ? p.text : `{${p.expr}}`)).join('');
                if (!keep(template.split('?')[0], method, file)) continue;
                const key = `${method} ${template}`;
                if (!found.has(key)) found.set(key, { method, template, parts, from: new Set() });
                found.get(key).from.add(file);
            }
        }
    }
    const calls = [...found.values()].map((c) => ({ ...c, from: [...c.from].sort() }))
        .sort((a, b) => (a.template < b.template ? -1 : a.template > b.template ? 1 : a.method < b.method ? -1 : 1));
    return { calls, dynamic };
}

/** Where an HTML tag that starts at src[i] ends ('>' outside quotes and ${…}); -1 if it does not. */
function tagEnd(src, i) {
    let q = null;
    for (let j = i; j < src.length; j++) {
        const c = src[j];
        if (c === '$' && src[j + 1] === '{') { const close = skipBalanced(src, j + 1, '{', '}'); if (close < 0) return -1; j = close; continue; }
        if (q) { if (c === q) q = null; continue; }
        if (c === '"' || c === '\'') q = c;
        else if (c === '>') return j + 1;
    }
    return -1;
}

/** An attribute's raw value in a tag (quoted, may hold ${…}). */
function attr(tag, name) {
    const m = new RegExp(`\\s${name}\\s*=\\s*(["'])`, 'i').exec(tag);
    if (!m) return null;
    const q = m[1];
    let out = '';
    for (let j = m.index + m[0].length; j < tag.length; j++) {
        const c = tag[j];
        if (c === '$' && tag[j + 1] === '{') { const close = skipBalanced(tag, j + 1, '{', '}'); if (close < 0) return null; out += tag.slice(j, close + 1); j = close; continue; }
        if (c === q) return out;
        out += c;
    }
    return null;
}

/** Text with ${expr} holes → parts. */
function templateParts(text) {
    const parts = [];
    let buf = '';
    for (let j = 0; j < text.length; j++) {
        if (text[j] === '$' && text[j + 1] === '{') {
            const close = skipBalanced(text, j + 1, '{', '}');
            if (close < 0) break;
            if (buf) parts.push({ text: buf });
            buf = '';
            parts.push({ expr: text.slice(j + 2, close).trim() });
            j = close;
            continue;
        }
        buf += text[j];
    }
    if (buf) parts.push({ text: buf.replace(/&amp;/g, '&') });
    return parts;
}

/**
 * A concrete path for a template: each ${expr} becomes the first sample whose pattern matches the
 * expression text, else '1' in the path and '' in the query.
 */
function concretePath(parts, samples = []) {
    let out = '';
    for (const p of parts) {
        if (p.text != null) { out += p.text; continue; }
        const inQuery = out.includes('?');
        // `${on ? 'mute' : 'unmute'}`: the first branch.
        const branch = /\?\s*(['"`])([^'"`]*)\1\s*:/.exec(p.expr);
        if (branch) { out += branch[2]; continue; }
        const hit = samples.find(([re]) => re.test(p.expr));
        let v = hit ? hit[1] : (inQuery ? '' : '1');
        if (typeof v === 'function') v = v(p.expr, inQuery);
        // '@name': a value the booted server seeded (a random slug); filled in when the call is sent.
        if (/^@\w+$/.test(String(v))) { out += `{${v}}`; continue; }
        out += inQuery ? String(v) : encodeURIComponent(String(v)).replace(/%2F/gi, '/');
    }
    out = out.replace(/^([^?#]*)\/\/+/, '$1/').replace(/[?&]+$/, '').replace(/\?&+/, '?');
    return out;
}

/**
 * The same-origin URLs a served page makes the browser fetch or offers to follow: src, href, poster,
 * data-src and form actions (with their method). `origins` are absolute origins that count as this
 * site (e.g. its public URL). → [{ method, path }]
 */
function pageLinks(html, origins = []) {
    const out = new Map();
    const add = (method, raw) => {
        let u = String(raw || '').trim().replace(/&amp;/g, '&');
        if (!u || /^(#|mailto:|javascript:|data:|tel:|blob:)/i.test(u)) return;
        const o = origins.find((x) => u.startsWith(`${x}/`) || u === x);
        if (o) u = u.slice(o.length) || '/';
        if (!u.startsWith('/') || u.startsWith('//')) return;
        u = u.split('#')[0];
        out.set(`${method} ${u}`, { method, path: u });
    };
    for (const m of String(html).matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
        const tag = m[1].toLowerCase(); const attrs = m[2];
        const get = (n) => { const a = new RegExp(`\\s${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs); return a ? (a[1] != null ? a[1] : a[2]) : null; };
        if (tag === 'form') { const a = get('action'); if (a != null) add(/^post$/i.test(get('method') || '') ? 'POST' : 'GET', a); continue; }
        for (const n of ['src', 'href', 'poster', 'data-src']) { const v = get(n); if (v != null) add('GET', v); }
    }
    return [...out.values()];
}

/** A path with the seeded ids that differ per run (random slugs, keys) put back as {@name} slots. */
function unfillPath(p, ids = {}) {
    let out = String(p);
    for (const [name, v] of Object.entries(ids || {})) {
        const s = v == null ? '' : String(v);
        if (s.length < 6 || /^\d+$/.test(s)) continue;
        out = out.split(encodeURIComponent(s)).join(`{@${name}}`).split(s).join(`{@${name}}`);
    }
    return out;
}

/** A recorded path with its {@name} slots filled from the booted server's seeded ids. */
function fillPath(p, ids = {}) {
    return String(p).replace(/\{@(\w+)\}/g, (m, name) => encodeURIComponent(ids[name] == null ? '0' : String(ids[name])));
}

/** Property names the client code reads: `.name`, `?.name`, `['name']`, 'name' literals, destructured names. */
function clientIdentifiers(texts) {
    const ids = new Set();
    for (const t of texts) {
        for (const m of t.matchAll(/\??\.\s*([A-Za-z_$][\w$]*)/g)) ids.add(m[1]);
        for (const m of t.matchAll(/['"`]([A-Za-z_$][\w$]*)['"`]/g)) ids.add(m[1]);
        for (const m of t.matchAll(/\{([^{}()]*)\}\s*(?:=[^=>]|\)\s*=>|\s*\))/g)) {
            for (const part of m[1].split(',')) {
                const id = /^\s*(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)/.exec(part);
                if (id) ids.add(id[1]);
            }
        }
    }
    return ids;
}

// ── Response shapes ──────────────────────────────────────────

function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

/**
 * The key paths of a JSON value → { 'a': 'object', 'a.b': 'string', 'list[]': 'object', 'list[].x': 'number' }.
 * Array elements are merged: a path is present when any element has it; its types are all it takes.
 */
function flatten(value, maxDepth = 5) {
    const out = {};
    const add = (p, t) => { if (!out[p]) out[p] = new Set(); out[p].add(t); };
    const walk = (v, prefix, depth) => {
        if (depth > maxDepth) return;
        if (Array.isArray(v)) {
            for (const el of v) { add(`${prefix}[]`, typeOf(el)); walk(el, `${prefix}[]`, depth + 1); }
        } else if (v && typeof v === 'object') {
            for (const [k, x] of Object.entries(v)) {
                const p = prefix ? `${prefix}.${k}` : k;
                add(p, typeOf(x));
                walk(x, p, depth + 1);
            }
        }
    };
    walk(value, '', 0);
    return out;
}

/** The key paths of `value` an old client reads: every key along the path is one the client names. */
function readsOf(value, ids) {
    const flat = flatten(value);
    const reads = {};
    for (const [p, types] of Object.entries(flat)) {
        const keys = p.split('.').map((k) => k.replace(/\[\]$/g, '')).filter(Boolean);
        if (!keys.length || !keys.every((k) => ids.has(k))) continue;
        const t = [...types].filter((x) => x !== 'null').sort();
        reads[p] = t.length ? t.join('|') : 'null';
    }
    return reads;
}

/** What `reads` (recorded from N-1) finds missing or retyped in `value` (from N). */
function readProblems(reads, value) {
    const flat = flatten(value);
    const problems = [];
    // A path under an array N answers empty (or null) cannot be read by the old client either.
    const emptyArray = (p) => {
        const segs = p.split('.');
        for (let i = 1; i <= segs.length; i++) {
            const head = segs.slice(0, i).join('.');
            if (!head.endsWith('[]')) continue;
            const arr = head.slice(0, -2);
            if (!flat[head] && (arr === '' ? Array.isArray(value) : flat[arr] && !flat[arr].has('object'))) return true;
        }
        return false;
    };
    const nullParent = (p) => {
        const segs = p.split('.');
        for (let i = 1; i < segs.length; i++) {
            const head = segs.slice(0, i).join('.').replace(/\[\]$/, '');
            if (flat[head] && [...flat[head]].every((t) => t === 'null')) return true;
        }
        return false;
    };
    for (const [p, want] of Object.entries(reads)) {
        if (emptyArray(p) || nullParent(p)) continue;
        const have = flat[p];
        if (!have) { problems.push(`${p} is gone`); continue; }
        if (want === 'null') continue;
        const now = [...have].filter((t) => t !== 'null');
        if (!now.length) continue;
        const was = want.split('|');
        if (!now.some((t) => was.includes(t))) problems.push(`${p} was ${want}, now ${now.join('|')}`);
    }
    return problems;
}

/** Whether N's status keeps N-1's promise: any 2xx for a 2xx, the same code otherwise; a 5xx only needs the route. */
function statusCompatible(was, now) {
    if (was >= 200 && was < 300) return now >= 200 && now < 300;
    if (was >= 500) return now !== 404 && now !== 405;
    return was === now;
}

// ── Replaying calls ──────────────────────────────────────────

function kindOf(contentType, text) {
    const ct = String(contentType || '').toLowerCase();
    if (ct.includes('text/event-stream')) return 'sse';
    if (ct.includes('json')) return 'json';
    if (ct.includes('html')) return 'html';
    if (!text) return 'empty';
    if (ct.startsWith('text/')) return 'text';
    return 'other';
}

/**
 * Sends one call. → { status, kind, json, location }. Redirects are not followed (they may leave the
 * sandbox); an event stream is not read past its headers.
 */
async function send(baseUrl, { method, path: p, headers = {}, body }, { timeoutMs = 8000 } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
        const res = await fetch(new URL(p, baseUrl), {
            method,
            redirect: 'manual',
            signal: ac.signal,
            headers: { accept: 'application/json', ...(hasBody ? { 'content-type': 'application/json' } : {}), ...headers },
            body: hasBody ? JSON.stringify(body) : undefined,
        });
        const ct = res.headers.get('content-type');
        if (/event-stream/i.test(ct || '')) { ac.abort(); return { status: res.status, kind: 'sse', json: null }; }
        const text = await res.text();
        const kind = kindOf(ct, text);
        let json = null;
        if (kind === 'json') { try { json = JSON.parse(text); } catch { json = null; } }
        const html = kind === 'html' ? text.slice(0, 1 << 20) : null;
        const loc = res.headers.get('location');
        // Where a redirect goes, without its query (a sign-in `next` or `state` differs every run).
        return { status: res.status, kind, json, html, location: loc ? loc.replace(/^https?:\/\/[^/]+/, '').split('?')[0] : null };
    } catch (err) {
        return { status: 0, kind: 'error', json: null, error: err.name === 'AbortError' ? 'timeout' : err.message };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The request list for a set of extracted calls: every call anonymously, GETs also signed in.
 * Reads first, then writes (with an empty JSON body), so a write cannot change what a read sees.
 */
function requestsFor(calls, samples, { signedIn = true } = {}) {
    const seen = new Set();
    const reqs = [];
    for (const c of calls) {
        const p = concretePath(c.parts, samples);
        for (const auth of c.method === 'GET' && signedIn ? ['anon', 'user'] : ['anon']) {
            const key = `${c.method} ${p} ${auth}`;
            if (seen.has(key)) continue;
            seen.add(key);
            reqs.push({ method: c.method, path: p, auth, from: c.from });
        }
    }
    const rank = (r) => (r.method === 'GET' ? 0 : 1);
    return reqs.sort((a, b) => rank(a) - rank(b));
}

/**
 * What the server answers a path nobody routes (per method): an HTML 404 is always "no route"; a
 * JSON catch-all 404 (`{ error: 'Not found' }`) is recognised by its body. → [{ method, status, kind, json }]
 */
async function notFoundProbe(baseUrl, headers = {}) {
    const out = [];
    for (const method of ['GET', 'POST']) {
        for (const p of ['/api/n-1-no-such-route', '/n-1-no-such-page']) {
            const got = await send(baseUrl, { method, path: p, headers, body: method === 'GET' ? undefined : {} });
            if (got.status === 404) out.push({ method, status: got.status, kind: got.kind, json: got.json });
        }
    }
    return out;
}

/** Whether an answer is the server's unknown-path 404 rather than a route's own. */
function isNoRoute(got, probe = []) {
    if (got.status !== 404) return false;
    if (got.kind !== 'json') return true;
    return probe.some((fp) => fp.kind === 'json' && JSON.stringify(fp.json) === JSON.stringify(got.json));
}

/** The failures of one replayed call against its recorded outcome (probe: N's unknown-path answers). */
function callProblems(rec, got, probe = []) {
    const problems = [];
    if (got.status === 0) return [`no answer (${got.error})`];
    if (isNoRoute(got, probe)) return ['the route is gone (it answers as an unknown path)'];
    if (!statusCompatible(rec.status, got.status)) problems.push(`answered ${got.status}, N-1 answered ${rec.status}`);
    else if (rec.kind === 'json' && got.kind !== 'json' && rec.status < 500) problems.push(`answered ${got.kind}, N-1 answered JSON`);
    if (rec.location && got.location && rec.status >= 300 && rec.status < 400 && got.location.split('?')[0] !== rec.location.split('?')[0]) problems.push(`redirects to ${got.location}, N-1 to ${rec.location}`);
    if (rec.reads && got.json != null && got.status >= 200 && got.status < 300) problems.push(...readProblems(rec.reads, got.json));
    return problems;
}

// ── WebSockets ───────────────────────────────────────────────

/**
 * The messages a client sends over its sockets: `x.send(JSON.stringify({ type: 'join', … }))` and
 * `helper({ type: … })` for each helper name. → [{ type, keys: [...] }] (keys merged per type)
 */
function wsSends(files, helpers = []) {
    const byType = new Map();
    const add = (obj) => {
        const t = obj.trim();
        if (!t.startsWith('{') || !t.endsWith('}')) return;
        let type = null; const keys = [];
        for (const entry of splitTop(t.slice(1, -1), ',')) {
            if (!entry || entry.startsWith('...')) continue;
            const kv = /^(?:['"]?)([A-Za-z_$][\w$-]*)(?:['"]?)\s*(?::\s*([\s\S]*))?$/.exec(entry);
            if (!kv) continue;
            if (kv[1] === 'type') {
                const lit = kv[2] && /^['"`]/.test(kv[2].trim()) ? readLiteral(kv[2].trim(), 0) : null;
                if (lit && lit.parts.length === 1 && lit.parts[0].text) type = lit.parts[0].text;
            } else keys.push(kv[1]);
        }
        if (!type) return;
        if (!byType.has(type)) byType.set(type, new Set());
        for (const k of keys) byType.get(type).add(k);
    };
    for (const { text } of files) {
        for (const m of text.matchAll(/\.send\(\s*JSON\.stringify\(/g)) {
            const args = callArgs(text, m.index + m[0].length - 1);
            if (args && args[0]) add(args[0]);
        }
        for (const name of helpers) {
            for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${esc(name)}\\s*\\(\\s*(?=\\{)`, 'g'))) {
                const args = callArgs(text, m.index + m[0].indexOf('('));
                if (args && args[0]) add(args[0]);
            }
        }
    }
    return [...byType].map(([type, keys]) => ({ type, keys: [...keys].sort() })).sort((a, b) => (a.type < b.type ? -1 : 1));
}

/** The message types a client acts on: `case 'x':` and `.type === 'x'`. */
function wsHandled(files) {
    const types = new Set();
    for (const { text } of files) {
        for (const m of text.matchAll(/\bcase\s+['"]([\w:.-]+)['"]\s*:/g)) types.add(m[1]);
        for (const m of text.matchAll(/\.type\s*[!=]==?\s*['"]([\w:.-]+)['"]/g)) types.add(m[1]);
    }
    return types;
}

/**
 * One scripted socket session: connect to `url`, send each message in turn and wait until the server
 * has been quiet for `quietMs`. → every message received (parsed JSON objects)
 */
async function wsSession({ url, headers = {}, messages, quietMs = 250, maxMs = 3000 }) {
    const WebSocket = require('ws');
    const ws = new WebSocket(url, { headers });
    const got = [];
    let last = Date.now();
    ws.on('message', (d) => { try { const m = JSON.parse(String(d)); if (m && typeof m === 'object') got.push(m); } catch { /* not JSON */ } last = Date.now(); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('unexpected-response', (req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`))); });
    const settle = async () => {
        const start = Date.now();
        last = Date.now();
        while (Date.now() - last < quietMs && Date.now() - start < maxMs) await new Promise((r) => setTimeout(r, 25));
    };
    await settle();
    for (const m of messages) {
        if (ws.readyState !== 1) break;
        ws.send(JSON.stringify(m));
        await settle();
    }
    await new Promise((resolve) => { ws.once('close', resolve); ws.close(); setTimeout(resolve, 500); });
    return got;
}

/** The messages to send for a client's sends, in `order` (then the rest), with keys filled from `values`. */
function wsMessages(sends, { order = [], values = {} } = {}) {
    const rank = (t) => { const i = order.indexOf(t); return i < 0 ? order.length : i; };
    return sends.slice().sort((a, b) => rank(a.type) - rank(b.type) || (a.type < b.type ? -1 : 1))
        .map((s) => {
            const m = { type: s.type };
            for (const k of s.keys) if (values[k] !== undefined) m[k] = values[k];
            return m;
        });
}

/** Received messages grouped by type, for the types the client handles → { type: reads } */
function wsReads(received, handled, ids) {
    const byType = new Map();
    for (const m of received) {
        if (typeof m.type !== 'string' || !handled.has(m.type)) continue;
        if (!byType.has(m.type)) byType.set(m.type, []);
        byType.get(m.type).push(m);
    }
    const out = {};
    for (const [t, list] of [...byType].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out[t] = readsOf(list, ids);
    return out;
}

/** What `recorded` ({ type: reads }) finds missing in the messages N sent. */
function wsProblems(recorded, received) {
    const problems = [];
    for (const [type, reads] of Object.entries(recorded)) {
        const list = received.filter((m) => m.type === type);
        if (!list.length) { problems.push(`no '${type}' message any more`); continue; }
        problems.push(...readProblems(reads, list).map((p) => `'${type}': ${p.replace(/^\[\]\.?/, '')}`));
    }
    return problems;
}

// ── SQL ──────────────────────────────────────────────────────

const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i;

/** Every plain JS string literal in the files (a template only without ${}), comments skipped. */
function stringLiterals(files) {
    const out = [];
    for (const { text } of files) {
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
            if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; continue; }
            if (c !== '\'' && c !== '"' && c !== '`') continue;
            const lit = readLiteral(text, i);
            if (!lit) continue;
            i = lit.end - 1;
            if (lit.parts.length === 1 && lit.parts[0].text != null) out.push(lit.parts[0].text);
        }
    }
    return out;
}

/** The literals that read like one SQL statement (DML). */
function sqlLiterals(files) {
    const out = new Set();
    for (const t of stringLiterals(files)) {
        const sql = normalizeSql(t);
        if (SQL_START.test(sql) && /\b(FROM|INTO|SET|VALUES)\b/i.test(sql)) out.add(sql);
    }
    return [...out];
}

/** SQL without its comments (-- to the end of a line, and block comments), outside quoted text. */
function stripSqlComments(sql) {
    let out = '';
    const s = String(sql);
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '\'' || c === '"') {
            const j = s.indexOf(c, i + 1);
            const end = j < 0 ? s.length : j + 1;
            out += s.slice(i, end); i = end - 1; continue;
        }
        if (c === '-' && s[i + 1] === '-') { const nl = s.indexOf('\n', i); i = nl < 0 ? s.length : nl - 1; continue; }
        if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 1; out += ' '; continue; }
        out += c;
    }
    return out;
}

function normalizeSql(sql) {
    return stripSqlComments(sql).replace(/\s+/g, ' ').trim();
}

/**
 * The DDL N-1 runs itself when it first needs a table or column (a module's CREATE TABLE IF NOT EXISTS,
 * a boot-time ALTER TABLE … ADD COLUMN) that `db` does not have yet. Each statement is applied to `db`
 * as it is found to apply; → the applied statements, tables first, in order.
 */
function lazyDDL(files, db) {
    const tables = () => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const columns = (t) => { try { return new Set(db.prepare(`PRAGMA table_xinfo("${t}")`).all().map((c) => c.name.toLowerCase())); } catch { return new Set(); } };
    const lits = stringLiterals(files).map(stripSqlComments);
    const applied = [];
    const apply = (ddl) => { try { db.exec(ddl); applied.push(ddl); return true; } catch { return false; } };
    for (const text of lits) {
        for (const m of text.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+["`]?(\w+)["`]?\s*\(/gi)) {
            // A rebuild's scratch table (x_new) is the migration's own business, not a table N-1 uses.
            if (tables().has(m[1]) || /_(new|old|tmp|backup)$/i.test(m[1])) continue;
            const end = skipBalanced(text, m.index + m[0].length - 1, '(', ')');
            if (end >= 0) apply(normalizeSql(text.slice(m.index, end + 1)));
        }
    }
    for (const text of lits) {
        const m = /^\s*ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+(?:COLUMN\s+)?["`]?(\w+)["`]?[^;]*$/i.exec(text.trim().replace(/;$/, ''));
        if (!m || !tables().has(m[1]) || columns(m[1]).has(m[2].toLowerCase())) continue;
        apply(normalizeSql(text).replace(/;$/, ''));
    }
    return applied;
}

/** Every file under dir with one of the extensions, as { name (relative to root), text }. */
function readTree(root, dirs, exts = ['.js']) {
    const out = [];
    const walk = (d) => {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p); } else if (exts.some((x) => e.name.endsWith(x))) out.push({ name: path.relative(root, p), text: fs.readFileSync(p, 'utf8') });
        }
    };
    for (const d of dirs) {
        const abs = path.join(root, d);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out.push({ name: d, text: fs.readFileSync(abs, 'utf8') });
        else walk(abs);
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The schema as DDL, tables first (no internal or FTS shadow tables), then indexes, triggers and views. */
function schemaDDL(db) {
    const shadow = new Set(db.prepare('PRAGMA table_list').all().filter((t) => t.type === 'shadow').map((t) => t.name));
    const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all()
        .filter((r) => !shadow.has(r.name));
    const order = { table: 0, index: 1, view: 2, trigger: 3 };
    return rows.sort((a, b) => order[a.type] - order[b.type] || (a.name < b.name ? -1 : 1)).map((r) => r.sql);
}

/** Prepares every statement on db (a missing table or column fails the prepare). → [{ sql, error }] */
function prepareProblems(db, statements) {
    const problems = [];
    for (const sql of statements) {
        try { db.prepare(sql); } catch (e) { problems.push({ sql, error: e.message }); }
    }
    return problems;
}

/**
 * INSERTs of N-1 that N would refuse: a column N made NOT NULL without a default that the INSERT does
 * not name. → [{ sql, error }]
 */
function insertProblems(db, statements) {
    const problems = [];
    const cols = new Map();
    const required = (table) => {
        if (!cols.has(table)) {
            let info = [];
            try { info = db.prepare(`PRAGMA table_xinfo("${table.replace(/"/g, '""')}")`).all(); } catch { info = []; }
            const pkInt = info.filter((c) => c.pk).length === 1 && info.find((c) => c.pk && /^INTEGER$/i.test(c.type));
            cols.set(table, info.filter((c) => c.notnull && c.dflt_value == null && !c.hidden && !(pkInt && c.pk)).map((c) => c.name));
        }
        return cols.get(table);
    };
    for (const sql of statements) {
        const m = /^\s*(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO\s+["`]?(\w+)["`]?\s*\(([^)]*)\)\s*(VALUES|SELECT)/i.exec(sql);
        if (!m) continue;
        const named = new Set(m[2].split(',').map((c) => c.trim().replace(/^["`]|["`]$/g, '').toLowerCase()));
        const missing = required(m[1]).filter((c) => !named.has(c.toLowerCase()));
        if (missing.length) problems.push({ sql, error: `${m[1]}.${missing.join(', ')} is NOT NULL without a default, and N-1 does not set it` });
    }
    return problems;
}

// ── Git ──────────────────────────────────────────────────────

/** A detached worktree of `ref` in a temp directory sharing root's node_modules → { dir, sha, remove() }. */
function worktree(root, ref) {
    const sha = execFileSync('git', ['-C', root, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-n-1-'));
    const dir = path.join(tmp, 'release');
    execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', dir, sha], { stdio: 'ignore' });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    return {
        dir, sha,
        remove() {
            try { execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' }); } catch { /* */ }
            fs.rmSync(tmp, { recursive: true, force: true });
        },
    };
}

/** Files of another repository at a commit (git show), e.g. Live's chat widget for Chat. → [{ name, text }] */
function gitFiles(repo, ref, dirs, exts = ['.js']) {
    const names = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', ref, '--', ...dirs], { encoding: 'utf8', maxBuffer: 64 << 20 })
        .split('\n').filter((n) => n && exts.some((x) => n.endsWith(x)) && !n.includes('node_modules/'));
    return names.sort().map((n) => ({ name: `${path.basename(repo)}:${n}`, text: execFileSync('git', ['-C', repo, 'show', `${ref}:${n}`], { encoding: 'utf8', maxBuffer: 64 << 20 }) }));
}

// ── Reporting ────────────────────────────────────────────────

function summarize(problems, max = 40) {
    const lines = problems.slice(0, max);
    if (problems.length > max) lines.push(`… and ${problems.length - max} more`);
    return lines.join('\n');
}

module.exports = {
    readLiteral, callArgs, splitTop, pathParts, extractCalls, concretePath, fillPath, unfillPath, pageLinks, clientIdentifiers,
    flatten, readsOf, readProblems, statusCompatible,
    send, requestsFor, notFoundProbe, isNoRoute, callProblems,
    wsSends, wsHandled, wsSession, wsMessages, wsReads, wsProblems,
    stringLiterals, sqlLiterals, stripSqlComments, normalizeSql, lazyDDL, readTree, schemaDDL, prepareProblems, insertProblems,
    worktree, gitFiles, summarize,
};
