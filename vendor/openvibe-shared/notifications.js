'use strict';

// ═══════════════════════════════════════════════════════════════
// OpenVibe — Universal Notification System
// Types, priorities, categories, and helpers shared across all
// services. Both server-side (Node) and client-side (browser).
// ═══════════════════════════════════════════════════════════════

// ── Priority Levels ──────────────────────────────────────────
// Determines toast style, sound, persistence, and email eligibility.
const PRIORITY = Object.freeze({
    LOW:      'low',       // Silent, no toast, inbox only
    NORMAL:   'normal',    // Toast + badge, default sound
    HIGH:     'high',      // Sticky toast, alert sound, badge pulse
    CRITICAL: 'critical',  // Sticky + email-eligible, alarm sound, cannot dismiss silently
});

// ── Categories ───────────────────────────────────────────────
// Users can configure per-category mute/sound/email preferences.
const CATEGORY = Object.freeze({
    SOCIAL:       'social',        // Follows, friend requests, mentions, kisses
    CHAT:         'chat',          // DMs, @mentions, whispers
    GAME:         'game',          // Level-ups, loot, dungeon invites, canvas events
    STREAM:       'stream',        // Stream went live, raid, host, clip created
    ECONOMY:      'economy',       // Coins received, shop sales, trade offers
    ACHIEVEMENT:  'achievement',   // Badges, milestones, unlocks
    MODERATION:   'moderation',    // Warnings, bans, mutes, reports
    SYSTEM:       'system',        // Password changed, new login, security alerts
    SERVICE:      'service',       // Cross-service: linked accounts, SSO events
    ADMIN:        'admin',         // Admin broadcasts, maintenance notices
});

// ── Notification Types (expandable per-service) ──────────────
// Each type maps to a category + default priority + template.
const TYPES = Object.freeze({
    // Social
    FOLLOW:              { category: 'social',      priority: 'normal',   icon: '👤',  title: 'New Follower' },
    MENTION:             { category: 'social',      priority: 'normal',   icon: '@',   title: 'Mentioned You' },
    FRIEND_REQUEST:      { category: 'social',      priority: 'normal',   icon: '🤝',  title: 'Friend Request' },

    // Chat
    DIRECT_MESSAGE:      { category: 'chat',        priority: 'normal',   icon: '💬',  title: 'New Message' },
    WHISPER:             { category: 'chat',        priority: 'normal',   icon: '🔇',  title: 'Whisper' },

    // Game
    LEVEL_UP:            { category: 'game',        priority: 'normal',   icon: '⬆️',  title: 'Level Up!' },
    LOOT_DROP:           { category: 'game',        priority: 'normal',   icon: '🎁',  title: 'Loot Drop' },
    DUNGEON_INVITE:      { category: 'game',        priority: 'high',     icon: '🏰',  title: 'Dungeon Invite' },
    BATTLE_CHALLENGE:    { category: 'game',        priority: 'high',     icon: '⚔️',  title: 'Battle Challenge' },
    CANVAS_OVERWRITE:    { category: 'game',        priority: 'low',      icon: '🎨',  title: 'Pixel Overwritten' },
    ACHIEVEMENT_UNLOCK:  { category: 'achievement', priority: 'normal',   icon: '🏆',  title: 'Achievement Unlocked' },

    // Stream
    STREAM_LIVE:         { category: 'stream',      priority: 'high',     icon: '🔴',  title: 'Stream Live' },
    RAID:                { category: 'stream',      priority: 'high',     icon: '🚀',  title: 'Incoming Raid' },
    CLIP_CREATED:        { category: 'stream',      priority: 'normal',   icon: '🎬',  title: 'Clip Created' },

    // Economy
    COINS_RECEIVED:      { category: 'economy',     priority: 'normal',   icon: '🪙',  title: 'Coins Received' },
    TRADE_OFFER:         { category: 'economy',     priority: 'normal',   icon: '🤝',  title: 'Trade Offer' },

    // Moderation
    WARNING:             { category: 'moderation',  priority: 'high',     icon: '⚠️',  title: 'Warning' },
    TIMEOUT:             { category: 'moderation',  priority: 'high',     icon: '⏰',  title: 'Timeout' },
    BAN:                 { category: 'moderation',  priority: 'critical', icon: '🚫',  title: 'Account Banned' },

    // System / Security
    PASSWORD_CHANGED:    { category: 'system',      priority: 'critical', icon: '🔒',  title: 'Password Changed' },
    NEW_LOGIN:           { category: 'system',      priority: 'high',     icon: '🔐',  title: 'New Login Detected' },
    EMAIL_VERIFIED:      { category: 'system',      priority: 'normal',   icon: '✅',  title: 'Email Verified' },
    ACCOUNT_LINKED:      { category: 'system',      priority: 'normal',   icon: '🔗',  title: 'Account Linked' },

    // Service / Cross-platform
    WELCOME:             { category: 'service',     priority: 'normal',   icon: '🔥',  title: 'Welcome to OpenVibe' },
    SERVICE_ANNOUNCEMENT:{ category: 'admin',       priority: 'high',     icon: '📢',  title: 'Announcement' },
    MAINTENANCE:         { category: 'admin',       priority: 'critical', icon: '🛠️',  title: 'Scheduled Maintenance' },
});

// ── Sound Map ────────────────────────────────────────────────
// Priority → sound file (relative to /assets/sounds/ on each service).
const SOUNDS = Object.freeze({
    low:      null,
    normal:   'notification.mp3',
    high:     'notification-high.mp3',
    critical: 'notification-alarm.mp3',
});

// ── Email Eligibility ────────────────────────────────────────
// Categories that are email-worthy by default when the user has not
// explicitly enabled email for a category-specific preference.
const EMAIL_ELIGIBLE_CATEGORIES = new Set([
    'system', 'moderation', 'admin',
]);

function isEmailEligible(notification) {
    return notification.priority === PRIORITY.CRITICAL
        && EMAIL_ELIGIBLE_CATEGORIES.has(notification.category);
}

// ── Rich Content Schema ──────────────────────────────────────
// Notifications can carry optional rich payloads.
//
// richContent: {
//   image?: string,           // URL to preview image
//   thumbnail?: string,       // Small avatar/icon URL
//   body?: string,            // Markdown-safe extended body
//   url?: string,             // Click-through URL
//   service?: string,         // Origin service ID
//   actions?: [               // Interactive buttons/inputs
//     { id: string, label: string, style: 'primary'|'secondary'|'danger', url?: string },
//     { id: string, type: 'input', placeholder: string, submitLabel: string },
//   ],
//   user?: {                  // Linked user display info
//     id: number, username: string, display_name: string,
//     avatar_url: string, profile_color: string, role: string,
//     name_effect?: string, particle_effect?: string,
//   },
//   context?: object,         // Arbitrary service-specific data
// }

// ── Notification Object Shape ────────────────────────────────
// {
//   id:          string,       // UUID
//   type:        string,       // Key from TYPES
//   category:    string,       // From CATEGORY
//   priority:    string,       // From PRIORITY
//   title:       string,       // Short headline
//   message:     string,       // Plain-text body
//   icon:        string,       // Emoji or icon class
//   user_id:     number,       // Recipient
//   sender_id?:  number,       // Who triggered it (nullable)
//   service:     string,       // Origin service ('live', 'games', 'network')
//   richContent?: object,      // See schema above
//   read:        boolean,
//   dismissed:   boolean,
//   emailed:     boolean,
//   created_at:  string,       // ISO 8601
//   expires_at?: string,       // Optional auto-expire
// }

function createNotification({ type, message, userId, senderId, service, richContent, expiresAt }) {
    const typeDef = TYPES[type];
    if (!typeDef) throw new Error(`Unknown notification type: ${type}`);

    return {
        type,
        category:    typeDef.category,
        priority:    typeDef.priority,
        title:       typeDef.title,
        icon:        typeDef.icon,
        message:     message || '',
        user_id:     userId,
        sender_id:   senderId || null,
        service:     service || 'network',
        richContent: richContent || null,
        read:        false,
        dismissed:   false,
        emailed:     false,
        expires_at:  expiresAt || null,
    };
}

// ── User Preferences Defaults ────────────────────────────────
const DEFAULT_NOTIFICATION_PREFS = Object.freeze({
    enabled: true,
    sound: true,
    toasts: true,
    email_critical: true,    // Email for CRITICAL only
    muted_categories: [],    // Categories the user has silenced
    do_not_disturb: false,
    dnd_schedule: null,      // { start: '22:00', end: '08:00', timezone: 'America/Los_Angeles' }
});

module.exports = {
    PRIORITY,
    CATEGORY,
    TYPES,
    SOUNDS,
    EMAIL_ELIGIBLE_CATEGORIES,
    isEmailEligible,
    createNotification,
    DEFAULT_NOTIFICATION_PREFS,
};
