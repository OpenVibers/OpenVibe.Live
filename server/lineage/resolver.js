'use strict';
/**
 * The canonical channel/owner resolver (roadmap §15.10, requirement D20): which channel, and whose,
 * a slug, slot, stream, VOD, clip, Media object, subject or legacy id belongs to.
 *
 * Contract: openvibe-contracts lineage.resolve-request@1 -> lineage.resolution@1 (v0.32.0), served at
 * GET|POST /internal/lineage/resolve (./routes.js, capability live.lineage.resolve).
 *
 * PRECEDENCE between inputs. Every input given is evaluated. The first one in this order that
 * resolves decides (resolved_by). Every other one that resolves must name the same owner, or the
 * answer is `conflict`. One whose source could not be read makes the answer `source_unavailable`,
 * because it might have disagreed. One that names nothing is `not_found` and does not block.
 *
 *   #  input               rule            how                                              confidence
 *   1  slug                explicit_slug   users.username, case-insensitive                 exact
 *   2  slug "a/b",         nested_slug     the channel a, then its slot b (slug or id)      exact
 *      parent_slug(+slug)
 *   3  channel_id          channel_id      channels.id -> channels.user_id                  exact
 *   4  stream_id           stream_lookup   streams.user_id                                  exact
 *      slot_id             stream_lookup   managed_streams.user_id                          exact
 *   5  clip_id             the clip's lineage, read from Media (below)                      derived
 *      vod_id              the VOD's lineage, read from Media (below)                       derived
 *   6  media_object_id     media_lineage   Media object -> the VOD/clip its legacy_ref names derived
 *                          legacy_map      a legacy:live:<kind>:<id> reference              legacy_map
 *   7  owner_subject       owner_subject   linked_accounts.subject_id (two accounts: ambiguous) exact
 *   8  legacy_ids          legacy_map      users.id, or the Network id on linked_accounts   legacy_map
 *
 * LINEAGE inside a record. The first link that answers wins; a link whose source cannot be read
 * stops the walk (a lower link must not answer for it):
 *   clip    its stream (stream_lookup) -> its VOD's lineage (vod_parent) -> clip.channel_user_id
 *           (legacy_metadata). Never clip.user_id: that is the clipper, not the channel.
 *   VOD     its stream (stream_lookup) -> its slot when the stream row is gone (stream_lookup) ->
 *           vod.user_id (legacy_metadata)
 *   object  the record its legacy_ref names (media_lineage) -> owner.subject (owner_subject) ->
 *           owner.user_id (legacy_metadata)
 * Confidence is the weakest hop: exact < derived (through a Media record) < legacy_map.
 *
 * DISPLAY NAMES are never read. A request holding only display_name is answered display_name_only;
 * next to other inputs it is ignored.
 *
 * resolveOwner() is the engine, in Live user ids, for Live's own call sites (it answers with the
 * owner a record names even when that account is gone, as the code it replaced did). resolve() is
 * the contract answer: the owner must still have an account and a `channels` row. Neither writes
 * anything, so an owner whose channel row Live has not created yet (the page creates it on first
 * view) is not_found for resolve().
 */
const db = require('../db/database');

const SLUG_PART = '[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}';
const SLUG_RE = new RegExp(`^@?(${SLUG_PART})(?:/(${SLUG_PART}))?$`);
const PARENT_RE = new RegExp(`^@?(${SLUG_PART})$`);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MEDIA_ID_RE = /^(med_[0-9A-HJKMNP-TV-Z]{26}|legacy:[a-z][a-z0-9-]{1,39}:(vod|clip|file|paste|thumbnail|avatar):[A-Za-z0-9._/-]{1,200})$/;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

const ID_INPUTS = ['channel_id', 'stream_id', 'slot_id', 'clip_id', 'vod_id'];
const LEGACY_KEYS = ['live_user_id', 'network_user_id'];
const FIELDS = new Set(['slug', 'parent_slug', ...ID_INPUTS, 'media_object_id', 'owner_subject', 'legacy_ids', 'display_name']);
const RULES = ['explicit_slug', 'nested_slug', 'channel_id', 'stream_lookup', 'vod_parent', 'media_lineage', 'owner_subject', 'legacy_metadata', 'legacy_map'];
const CONFIDENCE = ['exact', 'derived', 'legacy_map'];

const weaker = (a, b) => (CONFIDENCE.indexOf(a) >= CONFIDENCE.indexOf(b) ? a : b);
const str = (v) => (v == null || v === '' ? null : String(v));
function int(v) {
    const s = String(v == null ? '' : v);
    if (!/^\d{1,15}$/.test(s)) return null;
    const n = Number(s);
    return n > 0 ? n : null;
}

// ── Request ──────────────────────────────────────────────────

/**
 * A lineage.resolve-request@1 from a JSON body, or from a query string ({ flat: true }: legacy_ids
 * arrive as live_user_id / network_user_id). Ids may also be positive integers (Live's own callers).
 * Returns { input } or { error }.
 */
function normalizeRequest(raw, { flat = false } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the request must be an object' };
    const src = { ...raw };
    if (flat) {
        const legacy = {};
        for (const k of LEGACY_KEYS) if (src[k] !== undefined) { legacy[k] = src[k]; delete src[k]; }
        if (Object.keys(legacy).length) {
            if (src.legacy_ids !== undefined) return { error: 'give legacy_ids or live_user_id/network_user_id, not both' };
            src.legacy_ids = legacy;
        }
    }
    const input = {};
    for (const [k, v] of Object.entries(src)) {
        if (!FIELDS.has(k)) return { error: `unknown input ${k}` };
        if (v === undefined) continue;
        if (k === 'slug') {
            if (typeof v !== 'string' || !SLUG_RE.test(v)) return { error: 'slug must be a channel slug or <channel>/<slot>' };
            input.slug = v;
        } else if (k === 'parent_slug') {
            if (typeof v !== 'string' || !PARENT_RE.test(v)) return { error: 'parent_slug must be a channel slug' };
            input.parent_slug = v;
        } else if (ID_INPUTS.includes(k)) {
            const s = Number.isSafeInteger(v) && v > 0 ? String(v) : v;
            if (typeof s !== 'string' || !ID_RE.test(s)) return { error: `${k} must be an id` };
            input[k] = s;
        } else if (k === 'media_object_id') {
            if (typeof v !== 'string' || !MEDIA_ID_RE.test(v)) return { error: 'media_object_id must be med_<ULID> or legacy:<app>:<kind>:<id>' };
            input.media_object_id = v;
        } else if (k === 'owner_subject') {
            if (typeof v !== 'string' || !SUBJECT_RE.test(v)) return { error: 'owner_subject must be a usr_<ULID> subject id' };
            input.owner_subject = v;
        } else if (k === 'legacy_ids') {
            if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'legacy_ids must be an object' };
            const out = {};
            for (const [lk, lv] of Object.entries(v)) {
                if (!LEGACY_KEYS.includes(lk)) return { error: `unknown legacy id ${lk}` };
                const n = int(lv);
                if (!n) return { error: `legacy_ids.${lk} must be a positive integer` };
                out[lk] = n;
            }
            if (!Object.keys(out).length) return { error: 'legacy_ids is empty' };
            input.legacy_ids = out;
        } else if (k === 'display_name') {
            if (typeof v !== 'string' || v.length > 200) return { error: 'display_name must be a string of at most 200 characters' };
            input.display_name = v;
        }
    }
    return { input };
}

// ── Live rows ────────────────────────────────────────────────

const userById = (id) => db.get('SELECT id, username FROM users WHERE id = ?', [id]);
const userBySlug = (slug) => db.get('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE', [slug]);
const streamById = (id) => db.get(`SELECT s.id, s.user_id, s.managed_stream_id, ms.slug AS slot_slug
    FROM streams s LEFT JOIN managed_streams ms ON ms.id = s.managed_stream_id WHERE s.id = ?`, [id]);
const slotById = (id) => db.get('SELECT id, user_id, slug FROM managed_streams WHERE id = ?', [id]);
const streamRecord = (s) => ({ id: String(s.id), slot_id: str(s.managed_stream_id), slot_slug: s.slot_slug || null });
const slotRecord = (m) => ({ id: null, slot_id: String(m.id), slot_slug: m.slug || null });

function subjectOwners(subject) {
    return db.all("SELECT DISTINCT user_id FROM linked_accounts WHERE service = 'network' AND subject_id = ?", [subject]).map(r => r.user_id);
}

// ── Outcomes ─────────────────────────────────────────────────
// A link or input comes to one of:
//   { kind: 'owner', userId, rule, confidence, via, records }
//   { kind: 'not_found', detail } | { kind: 'unavailable', detail } | { kind: 'ambiguous', userIds, detail }

function owner(userId, rule, confidence, via, records = {}) {
    return { kind: 'owner', userId: Number(userId), rule, confidence, via: [...via, `user:${userId}`], records };
}
const notFound = (detail) => ({ kind: 'not_found', detail });
const unavailable = (detail) => ({ kind: 'unavailable', detail: detail || 'Media could not be read' });
const ALL = () => true;

/** One Media read per record per resolution. */
function cached(ctx, key, load) {
    if (!ctx.cache.has(key)) ctx.cache.set(key, Promise.resolve().then(load));
    return ctx.cache.get(key);
}
const readVod = (ctx, id) => (ctx.records.vod && String(ctx.records.vod.id) === String(id) ? Promise.resolve({ value: ctx.records.vod }) : cached(ctx, `vod:${id}`, () => (int(id) ? ctx.media.getVod(id) : { not_found: true })));
const readClip = (ctx, id) => (ctx.records.clip && String(ctx.records.clip.id) === String(id) ? Promise.resolve({ value: ctx.records.clip }) : cached(ctx, `clip:${id}`, () => (int(id) ? ctx.media.getClip(id) : { not_found: true })));
const readObject = (ctx, id) => cached(ctx, `object:${id}`, () => ctx.media.getObject(id));

function parseLegacyRef(ref) {
    const m = /^legacy:([a-z][a-z0-9-]{1,39}):([a-z]+):(.+)$/.exec(String(ref || ''));
    return m ? { app: m[1], kind: m[2], id: m[3] } : null;
}

/** A VOD's lineage: its stream, its slot when the stream row is gone, the owner recorded on it. */
function vodLineage(vod, allow = ALL) {
    const via = [`vod:${vod.id}`];
    const records = { vod: { id: String(vod.id), stream_id: str(vod.stream_id), slot_id: str(vod.managed_stream_id) } };
    if (vod.stream_id != null && allow('stream_lookup')) {
        const s = int(vod.stream_id) && streamById(int(vod.stream_id));
        if (s) return owner(s.user_id, 'stream_lookup', 'derived', [...via, `stream:${s.id}`], { ...records, stream: streamRecord(s) });
        records.stream = { id: String(vod.stream_id), slot_id: str(vod.managed_stream_id), slot_slug: null, missing: true };
    }
    if (vod.managed_stream_id != null && allow('stream_lookup')) {
        const m = int(vod.managed_stream_id) && slotById(int(vod.managed_stream_id));
        if (m) {
            records.stream = records.stream ? { ...records.stream, slot_slug: m.slug || null } : slotRecord(m);
            return owner(m.user_id, 'stream_lookup', 'derived', [...via, `slot:${m.id}`], records);
        }
    }
    if (int(vod.user_id) && allow('legacy_metadata')) return owner(int(vod.user_id), 'legacy_metadata', 'derived', via, records);
    return notFound(`VOD ${vod.id} names no stream, slot or owner Live has`);
}

/** A clip's lineage: its stream, its VOD's lineage, the channel recorded on it. Never the clipper. */
async function clipLineage(ctx, clip, allow = ALL) {
    const via = [`clip:${clip.id}`];
    const records = { clip: { id: String(clip.id), vod_id: str(clip.vod_id), stream_id: str(clip.stream_id) } };
    if (clip.stream_id != null && allow('stream_lookup')) {
        const s = int(clip.stream_id) && streamById(int(clip.stream_id));
        if (s) return owner(s.user_id, 'stream_lookup', 'derived', [...via, `stream:${s.id}`], { ...records, stream: streamRecord(s) });
        records.stream = { id: String(clip.stream_id), slot_id: null, slot_slug: null, missing: true };
    }
    if (clip.vod_id != null && allow('vod_parent')) {
        const v = await readVod(ctx, clip.vod_id);
        if (v.unavailable) return unavailable(v.detail);
        if (v.value) {
            const r = vodLineage(v.value);
            if (r.kind === 'owner') {
                return { ...r, rule: 'vod_parent', via: [...via, ...r.via], records: { ...records, ...r.records, stream: r.records.stream || records.stream } };
            }
        }
    }
    if (int(clip.channel_user_id) && allow('legacy_metadata')) return owner(int(clip.channel_user_id), 'legacy_metadata', 'derived', via, records);
    return notFound(`clip ${clip.id} names no stream, VOD or channel Live has`);
}

/** A Live-app VOD or clip named by a legacy reference or a Media object's legacy_ref. */
async function legacyRecordLineage(ctx, ref) {
    const read = ref.kind === 'vod' ? await readVod(ctx, ref.id) : await readClip(ctx, ref.id);
    if (read.unavailable) return unavailable(read.detail);
    if (!read.value) return notFound(`no ${ref.kind} ${ref.id}`);
    return ref.kind === 'vod' ? vodLineage(read.value) : clipLineage(ctx, read.value);
}

function subjectOutcome(subject, confidence, via) {
    const ids = subjectOwners(subject);
    if (!ids.length) return notFound(`no Live account is linked to ${subject}`);
    if (ids.length > 1) return { kind: 'ambiguous', userIds: ids, detail: `${subject} is linked to ${ids.length} Live accounts` };
    return owner(ids[0], 'owner_subject', confidence, via);
}

/** A Media object's lineage: the record its legacy_ref names, its owner subject, its owner user. */
async function objectLineage(ctx, id, allow = ALL) {
    const legacy = parseLegacyRef(id);
    if (legacy && legacy.app !== ctx.media.appId) return notFound(`${id} belongs to another app`);
    const via = [`media:${id}`];
    if (legacy && (legacy.kind === 'vod' || legacy.kind === 'clip')) {
        // A legacy reference is read as the record it names: the reference is the map.
        if (!allow('legacy_map')) return notFound('legacy references are not accepted here');
        const r = await legacyRecordLineage(ctx, legacy);
        const media_object = { id, kind: legacy.kind, legacy_ref: id };
        return r.kind === 'owner' ? { ...r, rule: 'legacy_map', confidence: 'legacy_map', via: [...via, ...r.via], records: { ...r.records, media_object } } : r;
    }
    const read = await readObject(ctx, id);
    if (read.unavailable) return unavailable(read.detail);
    if (!read.value) return notFound(`Media has no object ${id}`);
    const obj = read.value;
    const records = { media_object: { id: MEDIA_ID_RE.test(String(obj.id || '')) ? obj.id : id, kind: str(obj.kind), legacy_ref: str(obj.legacy_ref) } };
    const base = legacy ? 'legacy_map' : 'derived';
    const ref = parseLegacyRef(obj.legacy_ref);
    if (!legacy && ref && ref.app === ctx.media.appId && (ref.kind === 'vod' || ref.kind === 'clip') && allow('media_lineage')) {
        const r = await legacyRecordLineage(ctx, ref);
        if (r.kind === 'unavailable' || r.kind === 'ambiguous') return r;
        if (r.kind === 'owner') return { ...r, rule: 'media_lineage', confidence: weaker(r.confidence, 'derived'), via: [...via, ...r.via], records: { ...r.records, ...records } };
    }
    const subject = String((obj.owner && obj.owner.subject) || '').replace(/^user:/, '');
    if (SUBJECT_RE.test(subject) && allow('owner_subject')) {
        const r = subjectOutcome(subject, base, [...via, `subject:${subject}`]);
        if (r.kind !== 'not_found') return r.kind === 'owner' ? { ...r, records } : r;
    }
    const recorded = int(obj.owner && obj.owner.user_id);
    if (recorded && allow('legacy_metadata')) return owner(recorded, legacy ? 'legacy_map' : 'legacy_metadata', base, via, records);
    return notFound(`Media object ${id} names no record or owner Live has`);
}

// ── Inputs ───────────────────────────────────────────────────

/** The inputs of a request as evaluation units, in precedence order. */
function units(input) {
    const out = [];
    if (input.slug !== undefined) {
        const [, a, b] = SLUG_RE.exec(input.slug);
        if (!b && input.parent_slug !== undefined) out.push({ input: 'slug', rule: 'nested_slug', channel: PARENT_RE.exec(input.parent_slug)[1], slot: a, pairedParent: true });
        else out.push({ input: 'slug', rule: b ? 'nested_slug' : 'explicit_slug', channel: a, slot: b || null });
    }
    if (input.parent_slug !== undefined && !(out[0] && out[0].pairedParent)) out.push({ input: 'parent_slug', rule: 'nested_slug', channel: PARENT_RE.exec(input.parent_slug)[1], slot: null });
    for (const k of ['channel_id', 'stream_id', 'slot_id', 'clip_id', 'vod_id', 'media_object_id', 'owner_subject']) {
        if (input[k] !== undefined) out.push({ input: k, value: input[k] });
    }
    if (input.legacy_ids) for (const k of LEGACY_KEYS) if (input.legacy_ids[k]) out.push({ input: 'legacy_ids', legacy: k, value: input.legacy_ids[k] });
    return out;
}

async function evaluate(ctx, u, allow) {
    const gate = (rule, fn) => (allow(rule) ? fn() : notFound(`${rule} is not accepted here`));
    switch (u.input) {
        case 'slug':
        case 'parent_slug':
            return gate(u.rule, () => {
                const user = userBySlug(u.channel);
                if (!user) return notFound(`no channel @${u.channel}`);
                if (!u.slot) return owner(user.id, u.rule, 'exact', []);
                const m = db.getManagedStreamByIdOrSlug(user.id, u.slot);
                if (!m) return notFound(`@${u.channel} has no slot ${u.slot}`);
                return owner(user.id, u.rule, 'exact', [`slot:${m.id}`], { stream: slotRecord(m) });
            });
        case 'channel_id':
            return gate('channel_id', () => {
                const ch = int(u.value) && db.get('SELECT id, user_id FROM channels WHERE id = ?', [int(u.value)]);
                return ch ? owner(ch.user_id, 'channel_id', 'exact', [`channel:${ch.id}`]) : notFound(`no channel ${u.value}`);
            });
        case 'stream_id':
            return gate('stream_lookup', () => {
                const s = int(u.value) && streamById(int(u.value));
                return s ? owner(s.user_id, 'stream_lookup', 'exact', [`stream:${s.id}`], { stream: streamRecord(s) }) : notFound(`no stream ${u.value}`);
            });
        case 'slot_id':
            return gate('stream_lookup', () => {
                const m = int(u.value) && slotById(int(u.value));
                return m ? owner(m.user_id, 'stream_lookup', 'exact', [`slot:${m.id}`], { stream: slotRecord(m) }) : notFound(`no slot ${u.value}`);
            });
        case 'clip_id': {
            const read = await readClip(ctx, u.value);
            if (read.unavailable) return unavailable(read.detail);
            return read.value ? clipLineage(ctx, read.value, allow) : notFound(`Media has no clip ${u.value}`);
        }
        case 'vod_id': {
            const read = await readVod(ctx, u.value);
            if (read.unavailable) return unavailable(read.detail);
            return read.value ? vodLineage(read.value, allow) : notFound(`Media has no VOD ${u.value}`);
        }
        case 'media_object_id':
            return objectLineage(ctx, u.value, allow);
        case 'owner_subject':
            return gate('owner_subject', () => subjectOutcome(u.value, 'exact', [`subject:${u.value}`]));
        case 'legacy_ids':
            return gate('legacy_map', () => {
                if (u.legacy === 'live_user_id') {
                    return userById(u.value) ? owner(u.value, 'legacy_map', 'legacy_map', []) : notFound(`no Live user ${u.value}`);
                }
                const row = db.get("SELECT user_id FROM linked_accounts WHERE service = 'network' AND service_user_id = ?", [String(u.value)]);
                return row ? owner(row.user_id, 'legacy_map', 'legacy_map', [`network_user:${u.value}`]) : notFound(`no Live account for Network user ${u.value}`);
            });
        default:
            return notFound(`unknown input ${u.input}`);
    }
}

// ── Resolution ───────────────────────────────────────────────

/**
 * The engine, in Live user ids.
 *   opts.media    { appId, getVod, getClip, getObject } (default ./media-source)
 *   opts.records  { vod?, clip? } rows the caller already read from Media (saves a read)
 *   opts.rules    only these lineage rules may answer (default: all), for a call site that must
 *                 keep an older, narrower rule set
 * -> { status: 'resolved', userId, resolved_by, rule, confidence, via, records, checked }
 *  | { status: 'unresolved', reason, detail, checked }         checked: [{ input, outcome, userId? }]
 */
async function resolveOwner(raw, opts = {}) {
    const { input, error } = normalizeRequest(raw);
    if (error) throw Object.assign(new Error(error), { code: 'lineage.invalid_request' });
    const allow = Array.isArray(opts.rules) ? (rule) => opts.rules.includes(rule) : ALL;
    const ctx = { media: opts.media || require('./media-source'), records: opts.records || {}, cache: new Map() };
    const list = units(input);
    const checked = [];
    const ignoredName = input.display_name !== undefined ? [{ input: 'display_name', outcome: 'ignored' }] : [];

    if (!list.length) {
        return ignoredName.length
            ? { status: 'unresolved', reason: 'display_name_only', detail: 'a display name is never sufficient to establish a channel or its owner', checked: ignoredName }
            : { status: 'unresolved', reason: 'no_input', detail: 'the request names nothing', checked: [] };
    }

    const results = [];
    for (const u of list) results.push({ u, r: await evaluate(ctx, u, allow) });

    const decider = results.find(x => x.r.kind === 'owner');
    let conflict = false;
    for (const { u, r } of results) {
        const entry = { input: u.input };
        if (r.kind === 'owner') {
            entry.userId = r.userId;
            entry.outcome = r === decider.r ? 'decided' : (r.userId === decider.r.userId ? 'agrees' : 'conflict');
        } else if (r.kind === 'ambiguous') {
            entry.outcome = decider ? (r.userIds.includes(decider.r.userId) ? 'agrees' : 'conflict') : 'ambiguous';
            if (decider && entry.outcome === 'agrees') entry.userId = decider.r.userId;
        } else {
            entry.outcome = r.kind;                                   // not_found | unavailable
        }
        if (entry.outcome === 'conflict') conflict = true;
        checked.push(entry);
        if (u.pairedParent) checked.push({ ...entry, input: 'parent_slug' });
    }
    checked.push(...ignoredName);

    const failed = (reason, detail) => ({ status: 'unresolved', reason, detail, checked });
    const down = results.find(x => x.r.kind === 'unavailable');
    if (down) return failed('source_unavailable', `${down.u.input}: ${down.r.detail}`);
    if (conflict) {
        const other = checked.find(c => c.outcome === 'conflict');
        return failed('conflict', `${decider.u.input} and ${other.input} name different channels`);
    }
    if (!decider) {
        const amb = results.find(x => x.r.kind === 'ambiguous');
        if (amb) return failed('ambiguous', amb.r.detail);
        return failed('not_found', results.map(x => x.r.detail).filter(Boolean).join('; ').slice(0, 500) || 'nothing matched');
    }

    // The deciding input's records first, then those of the inputs that agree.
    const records = {};
    for (const { r } of results) {
        if (r.kind !== 'owner' || r.userId !== decider.r.userId) continue;
        for (const [k, v] of Object.entries(r.records || {})) if (!records[k]) records[k] = v;
    }
    return {
        status: 'resolved',
        userId: decider.r.userId,
        resolved_by: decider.u.input,
        rule: decider.r.rule,
        confidence: decider.r.confidence,
        via: decider.r.via.slice(0, 32),
        records,
        checked,
    };
}

/** The contract answer (lineage.resolution@1). Read-only. */
async function resolve(raw, opts = {}) {
    const r = await resolveOwner(raw, opts);
    const slugs = new Map();
    const slugOf = (id) => { if (!slugs.has(id)) slugs.set(id, (userById(id) || {}).username || null); return slugs.get(id); };
    const checked = r.checked.map(({ input, outcome, userId }) => {
        const c = { input, outcome };
        const slug = userId != null ? slugOf(userId) : null;
        if (slug) c.channel_slug = slug;
        return c;
    });
    const unresolved = (reason, detail) => ({ status: 'unresolved', reason, ...(detail ? { detail: String(detail).slice(0, 500) } : {}), checked });
    if (r.status !== 'resolved') return unresolved(r.reason, r.detail);

    const user = userById(r.userId);
    if (!user) return unresolved('not_found', `the owner ${r.resolved_by} names no longer has a Live account`);
    const ch = db.get('SELECT id FROM channels WHERE user_id = ?', [user.id]);
    if (!ch) return unresolved('not_found', `@${user.username} has no channel yet`);
    const link = db.get("SELECT subject_id, service_user_id FROM linked_accounts WHERE service = 'network' AND user_id = ?", [user.id]);
    const legacy_ids = { live_user_id: user.id };
    if (link && int(link.service_user_id)) legacy_ids.network_user_id = int(link.service_user_id);
    const out = {
        status: 'resolved',
        channel: {
            id: String(ch.id),
            slug: user.username,
            owner_subject: link && SUBJECT_RE.test(String(link.subject_id || '')) ? link.subject_id : null,
            legacy_ids,
        },
    };
    for (const k of ['stream', 'vod', 'clip', 'media_object']) if (r.records[k]) out[k] = r.records[k];
    Object.assign(out, { resolved_by: r.resolved_by, rule: r.rule, confidence: r.confidence, via: r.via, checked });
    return out;
}

module.exports = { resolve, resolveOwner, normalizeRequest, RULES };
