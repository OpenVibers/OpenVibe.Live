'use strict';
/**
 * The Rundown's episodes in the sharing system (openvibe-sdk/share, share.v1), kind 'rundown-episode'.
 *
 * Who sees a streamer's Rundown is one setting, not four, and it is the sharing system's own setting: the same one the
 * Share sheet offers everywhere on the network (Everyone / Anyone with the link / Specific people / Only me). An
 * episode registers itself when the desk writes it up, with the streamer's default audience, and the sheet changes it
 * afterwards. A segment follows its episode: the pages read the episode's share row, never a second setting.
 *
 * The SDK module is optional at runtime: Live must boot and serve its other pages on a release whose pinned
 * openvibe-sdk predates `share`. Without it, only Everyone items are published and nobody can open a private episode —
 * fail closed. The tables (share_*) are created by Live's migration 0027 from the SDK's own expand-only schema; this
 * module never creates one at runtime.
 */
const db = require('../db/database');

const SERVICE = 'live';
const KIND = 'rundown-episode';

let store = null;
let loaded = false;
let networkOverride = null;

/** Tests: answer Network's name lookups locally. */
function _setNetwork(client) { networkOverride = client || null; store = undefined; loaded = false; }

/** Events go through Live's own outbox, inside the sharing transaction (the SDK outbox refuses otherwise). */
const events = {
    async publish(envelope) {
        try {
            const outbox = require('../events/stream-events');
            outbox.init();
            if (await outbox.enqueue(envelope)) outbox.kick();
        } catch (err) {
            // The sharing transaction must not fail because the outbox is unhappy: the setting is the streamer's, not
            // the outbox's.
            console.warn(`[Rundown] share event not queued: ${err.message}`);
        }
    },
};

function sdk() {
    if (loaded) return store;
    loaded = true;
    let mod;
    try { mod = require('openvibe-sdk/share'); } catch { mod = null; }
    if (!mod || typeof mod.createShares !== 'function') return (store = null);
    try {
        store = mod.createShares({
            db: db.getDb(),
            network: networkOverride || require('../net/network-json').client(),
            events,
            // Nobody is told about a Rundown episode yet: the streamer shares it deliberately, and the pages
            // themselves are the notice.
            notify: async () => {},
        });
    } catch (err) {
        console.warn(`[Rundown] sharing unavailable: ${err.message}`);
        store = null;
    }
    return store;
}

/** Whether the sharing system is installed in this release. */
function available() { try { return !!sdk(); } catch { return false; } }

/**
 * Register an episode the desk has just written up, with the streamer's default audience. An episode that is already
 * registered keeps the audience its owner chose: the default is a default, not a setting that overrules the sheet.
 */
async function register(streamId, ownerSubject, audience = 'public') {
    const shares = sdk();
    if (!shares || !ownerSubject) return false;
    const id = String(streamId);
    try {
        const row = await db.get("SELECT audience FROM shares WHERE service = ? AND kind = ? AND resource_id = ?", [SERVICE, KIND, id]);
        if (row) return false;
        await shares.register({ service: SERVICE, kind: KIND, id }, {
            owner_subject: { type: 'user', id: ownerSubject },
            audience: ['public', 'link', 'people', 'private'].includes(audience) ? audience : 'public',
        });
        return true;
    } catch (err) {
        console.warn(`[Rundown] share registration for ${id} failed: ${err.message}`);
        return false;
    }
}

/**
 * Apply one audience to the streamer's existing episodes (VISIBILITY-EVERYWHERE rule 2, "My Rundown").
 * Each episode goes through the SDK's own update, so the share row, the log and the pages move together.
 * Specific people needs a list per episode, so it is not applied in bulk; the sheet remains the place
 * for that. Only the episodes the caller owns are passed in by settings.applyToEpisodes.
 */
async function applyAudience(ownerSubject, streamIds, audience) {
    const shares = sdk();
    if (!shares || !ownerSubject || !streamIds || !streamIds.length) return 0;
    if (!['public', 'link', 'private'].includes(audience)) {
        throw Object.assign(new Error('Specific people is chosen per episode'), { status: 400 });
    }
    let changed = 0;
    for (const streamId of streamIds) {
        await shares.update({ subject: { type: 'user', id: ownerSubject } }, { service: SERVICE, kind: KIND, id: String(streamId) }, { audience, members: [] });
        changed++;
    }
    return changed;
}

/** The episode's own setting, read straight from the share row (the pages read it for every item). */
async function audienceOf(streamId) {
    const row = await db.get('SELECT audience FROM shares WHERE service = ? AND kind = ? AND resource_id = ?', [SERVICE, KIND, String(streamId)]);
    return row ? row.audience : null;
}

/** The people an episode is shared with, as subject ids. */
async function memberSubjects(streamId) {
    const rows = await db.all(`SELECT subject->>'id' AS id FROM share_members
        WHERE service = ? AND kind = ? AND resource_id = ? AND (expires_at IS NULL OR expires_at > NOW())`, [SERVICE, KIND, String(streamId)]);
    return rows.map((r) => r.id).filter(Boolean);
}

/**
 * May this reader open the episode? "Anyone with the link" is the episode's own address, so anybody may; "Specific
 * people" is the people on the list; "Only me" is the streamer.
 */
function maySee(eff, { ownerUserId = null, viewer = null } = {}) {
    if (!eff) return false;
    if (eff.audience === 'public' || eff.audience === 'link') return true;
    if (!viewer) return false;
    if (ownerUserId != null && viewer.userId != null && Number(viewer.userId) === Number(ownerUserId)) return true;
    if (eff.audience === 'people' && viewer.subject && (eff.members || []).includes(viewer.subject)) return true;
    return false;
}

/** The Share sheet's description of an episode: its title and where it lives. */
async function describe(ref) {
    const id = Number(ref && ref.id);
    if (!Number.isSafeInteger(id) || id <= 0) return {};
    const ep = await db.get('SELECT title FROM rundown_episodes WHERE stream_id = ?', [id]);
    let base = 'https://openvibe.live';
    try { base = String(require('../config').baseUrl || base).replace(/\/+$/, ''); } catch { /* */ }
    return {
        title: ep && ep.title ? ep.title : 'Episode',
        link: `${base}/rundown/e/${id}`,
        roles: ['viewer'],
        transferable: false,
    };
}

/** The share router, mounted at /api/v1 (the Share sheet's access part). Null when the SDK has no sharing. */
function router(options) {
    const shares = sdk();
    if (!shares) return null;
    return shares.router({ service: SERVICE, ...options });
}

/** Send the sharing system's queued deliveries. Called by the housekeeping loop, never inline. */
async function flushDeliveries() {
    const shares = sdk();
    if (!shares) return 0;
    return await shares.flush();
}

module.exports = { SERVICE, KIND, available, register, applyAudience, audienceOf, memberSubjects, maySee, describe, router, flushDeliveries, _setNetwork, _reset() { store = undefined; loaded = false; networkOverride = null; } };
