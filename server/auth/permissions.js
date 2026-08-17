/**
 * OpenVibe.Live — Capability & Scope Permission Layer
 *
 * Roles answer "who are you globally?"
 *   user, streamer, global_mod, admin
 *
 * Scope answers "where do you have power?"
 *   channel_moderators table for per-channel assignments
 *
 * Capability answers "what can you do?"
 *   This module exports every check so routes/WS never do raw role comparisons.
 *
 * UI never decides authority — the server does.
 */

const db = require('../db/database');

// ── Role hierarchy (higher = more power) ─────────────────────
const ROLE_RANK = {
    user: 0,
    streamer: 1,
    global_mod: 2,
    admin: 3,
};

function roleRank(role) {
    return ROLE_RANK[role] ?? 0;
}

// ── Core role checks ─────────────────────────────────────────

function isAdmin(user) {
    return user?.role === 'admin';
}

/**
 * Owner = an admin with the local is_owner flag. Owners are the ONLY users who may
 * view/change API keys, touch money/payment settings, or grant admin. Regular admins
 * keep all moderation powers but are walled off from those. is_owner is a local column
 * (not synced from SSO), so it's stable across logins.
 */
function isOwner(user) {
    return !!(user && user.is_owner && (user.role === 'admin' || roleRank(user.role) >= ROLE_RANK.admin));
}

/**
 * Can `actor` edit/delete content (VOD/clip/paste) OWNED BY `contentOwner`?
 * This is for MODERATING SOMEONE ELSE'S content — callers still allow a user to
 * manage their own content separately (self-ownership check).
 *   - Owners may moderate anything.
 *   - Admins may moderate anyone EXCEPT an owner-rank user's content (an admin
 *     must not delete/edit the owner's VODs/clips/pastes).
 *   - Everyone else: no (only their own, handled by the caller).
 * `contentOwner` is the user record of the content's owner (may be null/anon).
 */
function canModerateContentOwner(actor, contentOwner) {
    if (!actor) return false;
    if (isOwner(actor)) return true;                      // network owner: anything
    if (isAdmin(actor) || isGlobalMod(actor)) {           // staff moderators…
        return !(contentOwner && contentOwner.is_owner);  // …but never an owner's content
    }
    return false;
}

// Settings whose values are secrets or control money/AI spend — owner-only to view/edit.
const SENSITIVE_KEY_RE = /(api[_-]?key|secret|token|password|client_id|client_secret|service_account|private[_-]?key)/i;
const SENSITIVE_KEY_PREFIXES = ['ai_', 'stripe_', 'ccbill_', 'crypto_', 'tts_google_'];
const SENSITIVE_KEY_EXACT = new Set(['youtube_api_key']);
function isSensitiveSettingKey(key) {
    if (!key) return false;
    const k = String(key).toLowerCase();
    if (SENSITIVE_KEY_EXACT.has(k)) return true;
    if (SENSITIVE_KEY_RE.test(k)) return true;
    return SENSITIVE_KEY_PREFIXES.some(p => k.startsWith(p));
}
/** Owners see real values; everyone else gets sensitive settings redacted/hidden. */
function redactSettingsForUser(settings, user, { drop = false } = {}) {
    if (isOwner(user)) return settings;
    if (!Array.isArray(settings)) return settings;
    const out = [];
    for (const s of settings) {
        if (isSensitiveSettingKey(s.key)) {
            if (drop) continue;
            out.push({ ...s, value: (s.value ? '••••••••' : ''), redacted: true });
        } else {
            out.push(s);
        }
    }
    return out;
}

function isGlobalMod(user) {
    return user?.role === 'global_mod';
}

function isGlobalModOrAbove(user) {
    return roleRank(user?.role) >= ROLE_RANK.global_mod;
}

/**
 * Alias for isGlobalModOrAbove — "staff" means admin or global_mod.
 * Used by canvas and other systems that need a simple staff check.
 */
const isStaff = isGlobalModOrAbove;

function isStreamer(user) {
    return roleRank(user?.role) >= ROLE_RANK.streamer;
}

// ── Channel mod checks ──────────────────────────────────────

/**
 * Is this user a channel moderator for the given channel?
 */
function isChannelMod(user, channelId) {
    if (!user?.id || !channelId) return false;
    return !!db.isChannelModerator(user.id, channelId);
}

/**
 * Is this user the owner of the given channel?
 */
function isChannelOwner(user, channelId) {
    if (!user?.id || !channelId) return false;
    const channel = db.getChannelById(channelId);
    return channel?.user_id === user.id;
}

/**
 * Does a stream belong to this user?
 */
function isStreamOwner(user, streamId) {
    if (!user?.id || !streamId) return false;
    const stream = db.getStreamById(streamId);
    return stream?.user_id === user.id;
}

/**
 * Get the channel_id for a given stream.
 */
function getChannelIdForStream(streamId) {
    if (!streamId) return null;
    const stream = db.getStreamById(streamId);
    return stream?.channel_id || null;
}

// ── Capability checks ────────────────────────────────────────

/**
 * Can this user access the admin panel? (admin + global_mod)
 * Global mods see a subset of tabs (chat logs, bans).
 */
function canAccessAdminPanel(user) {
    return isGlobalModOrAbove(user);
}

/**
 * Can this user manage users (role changes, bans, etc.)? (admin only)
 */
function canManageUsers(user) {
    return isAdmin(user);
}

/**
 * Can this user manage (promote/demote) global mods? (admin only)
 */
function canManageGlobalMods(user) {
    return isAdmin(user);
}

/**
 * Can this user manage site settings? (admin only)
 */
function canManageSiteSettings(user) {
    return isAdmin(user);
}

/** Can this user view/change API keys + other secret settings? (owner only) */
function canManageSecrets(user) {
    return isOwner(user);
}
/** Can this user manage money — payments config, cashouts/payouts, funds? (owner only) */
function canManageMoney(user) {
    return isOwner(user);
}
/** Can this user grant/revoke the ADMIN role? (owner only) */
function canGrantAdmin(user) {
    return isOwner(user);
}

/**
 * Can this user review cashouts? Cashouts move real money out — owner only.
 */
function canReviewCashouts(user) {
    return isOwner(user);
}

/**
 * Can this user review VPN queue? (admin only)
 */
function canReviewVpn(user) {
    return isAdmin(user);
}

/**
 * Can this user manage site-wide bans? (admin + global_mod)
 */
function canManageSiteBans(user) {
    return isGlobalModOrAbove(user);
}

/**
 * Can this user moderate a specific channel's chat?
 *
 * True for: admin, global_mod, channel owner, channel mod
 */
function canModerateChannel(user, channelId) {
    if (!user) return false;
    if (isGlobalModOrAbove(user)) return true;
    if (isChannelOwner(user, channelId)) return true;
    return isChannelMod(user, channelId);
}

/**
 * Can this user moderate a specific stream's chat?
 *
 * Resolves stream → channel, then checks channel moderation.
 */
function canModerateStream(user, streamId) {
    if (!user) return false;
    if (isGlobalModOrAbove(user)) return true;
    if (isStreamOwner(user, streamId)) return true;
    const channelId = getChannelIdForStream(streamId);
    if (channelId && isChannelMod(user, channelId)) return true;
    return false;
}

/**
 * Can this user moderate a call on a specific stream?
 * Same rules as chat moderation.
 */
function canModerateCall(user, streamId) {
    return canModerateStream(user, streamId);
}

/**
 * Can this user view chat logs?
 *
 * - admin / global_mod: all logs
 * - channel_mod: logs for their channels only (handled at route level)
 * - user: own logs only
 */
function canViewChatLogs(user, scope = 'own') {
    if (!user) return false;
    if (isGlobalModOrAbove(user)) return true;
    return scope === 'own';
}

/**
 * Can this user view another user's chat logs?
 */
function canViewOtherUserLogs(user) {
    return isGlobalModOrAbove(user);
}

/**
 * Can this user assign channel mods?
 *
 * Channel owner or admin.
 */
function canAssignChannelMods(user, channelId) {
    if (!user) return false;
    if (isAdmin(user)) return true;
    return isChannelOwner(user, channelId);
}

/**
 * Can this user manage their own stream/channel?
 */
function canManageOwnChannel(user) {
    return isStreamer(user);
}

/**
 * Can this user force-end any stream? (admin only)
 */
function canForceEndStreams(user) {
    return isAdmin(user);
}

// ── Capability map (returned to frontend via /api/auth/me) ───

/**
 * Build a capabilities object to send to the client.
 * The frontend gates UI based on this, never raw roles.
 */
function getCapabilities(user) {
    if (!user) {
        return {
            admin_panel: false,
            moderate_global: false,
            manage_users: false,
            manage_global_mods: false,
            manage_site_settings: false,
            manage_site_bans: false,
            review_cashouts: false,
            review_vpn: false,
            view_all_logs: false,
            manage_own_channel: false,
            force_end_streams: false,
            manage_canvas: false,
            manage_canvas_settings: false,
            can_access_staff_console: false,
            can_manage_channels: false,
            can_moderate_site_chat: false,
            view_ip_info: false,
            owned_channel_id: null,
            moderated_channel_ids: [],
        };
    }

    const ownedChannel = db.getChannelByUserId(user.id);
    const moderatedChannels = db.getChannelsByModerator(user.id) || [];
    const isStaffUser = isGlobalModOrAbove(user);
    const owner = isOwner(user);

    return {
        admin_panel: canAccessAdminPanel(user),
        moderate_global: isStaffUser,
        manage_users: canManageUsers(user),
        manage_global_mods: canManageGlobalMods(user),
        manage_site_settings: canManageSiteSettings(user),
        manage_site_bans: canManageSiteBans(user),
        review_cashouts: canReviewCashouts(user),
        review_vpn: canReviewVpn(user),
        view_all_logs: canViewOtherUserLogs(user),
        manage_own_channel: canManageOwnChannel(user),
        force_end_streams: canForceEndStreams(user),
        manage_canvas: isStaffUser,
        manage_canvas_settings: isAdmin(user),
        can_access_staff_console: isStaffUser,
        can_manage_channels: !!ownedChannel || moderatedChannels.length > 0 || isStaffUser,
        can_moderate_site_chat: isStaffUser,
        view_ip_info: isStaffUser,
        // Owner-only powers (keys / money / granting admin).
        is_owner: owner,
        manage_secrets: canManageSecrets(user),
        manage_money: canManageMoney(user),
        grant_admin: canGrantAdmin(user),
        // Staff badge tier for the UI: 'owner' | 'admin' | 'mod' | null.
        staff_tier: owner ? 'owner' : (isAdmin(user) ? 'admin' : (isGlobalMod(user) ? 'mod' : null)),
        owned_channel_id: ownedChannel?.id || null,
        moderated_channel_ids: moderatedChannels.map(ch => ch.id),
    };
}

// ── Express middleware factories ─────────────────────────────

/**
 * Middleware: require admin role.
 */
function requireAdmin(req, res, next) {
    if (!isAdmin(req.user)) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

/**
 * Middleware: require global_mod or admin role.
 */
function requireGlobalMod(req, res, next) {
    if (!isGlobalModOrAbove(req.user)) {
        return res.status(403).json({ error: 'Moderator access required' });
    }
    next();
}

/** Alias for requireGlobalMod — used by canvas and other systems. */
const requireStaff = requireGlobalMod;

/** Middleware: require the OWNER (keys / money / grant-admin). */
function requireOwner(req, res, next) {
    if (!isOwner(req.user)) {
        return res.status(403).json({ error: 'Owner access required' });
    }
    next();
}

/**
 * Middleware: require streamer or above.
 */
function requireStreamer(req, res, next) {
    if (!isStreamer(req.user)) {
        return res.status(403).json({ error: 'Streamer access required' });
    }
    next();
}

module.exports = {
    // Role checks
    isAdmin,
    isOwner,
    isGlobalMod,
    isGlobalModOrAbove,
    isStaff,
    isStreamer,
    isSensitiveSettingKey,
    redactSettingsForUser,
    canManageSecrets,
    canManageMoney,
    canGrantAdmin,
    canModerateContentOwner,
    requireOwner,
    isChannelMod,
    isChannelOwner,
    isStreamOwner,
    roleRank,

    // Capability checks
    canAccessAdminPanel,
    canManageUsers,
    canManageGlobalMods,
    canManageSiteSettings,
    canReviewCashouts,
    canReviewVpn,
    canManageSiteBans,
    canModerateChannel,
    canModerateStream,
    canModerateCall,
    canViewChatLogs,
    canViewOtherUserLogs,
    canAssignChannelMods,
    canManageOwnChannel,
    canForceEndStreams,
    getCapabilities,

    // Middleware
    requireAdmin,
    requireGlobalMod,
    requireStaff,
    requireStreamer,
};
