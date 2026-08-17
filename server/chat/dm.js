/**
 * OpenVibe.Live — Direct Message System
 *
 * Facebook Messenger-style DMs: 1-on-1 and group conversations,
 * persisted to SQLite, real-time delivery via WebSocket, with
 * read receipts and unread counts.
 *
 * Tables:
 *   dm_conversations  — conversation metadata
 *   dm_participants   — who's in each conversation
 *   dm_messages       — individual messages
 */
const db = require('../db/database');

// ── Schema & Migrations ──────────────────────────────────────

function ensureTables() {
    const database = db.getDb();
    try {
        database.exec(`
            CREATE TABLE IF NOT EXISTS dm_conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                is_group INTEGER DEFAULT 0,
                created_by INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS dm_participants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                last_read_at DATETIME DEFAULT '1970-01-01 00:00:00',
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(conversation_id, user_id),
                FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS dm_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                sender_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
                FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_dm_participants_conv ON dm_participants(conversation_id);
            CREATE INDEX IF NOT EXISTS idx_dm_participants_user ON dm_participants(user_id);
            CREATE INDEX IF NOT EXISTS idx_dm_messages_conv ON dm_messages(conversation_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_dm_messages_sender ON dm_messages(sender_id);

            CREATE TABLE IF NOT EXISTS dm_blocks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                blocker_id INTEGER NOT NULL,
                blocked_id INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(blocker_id, blocked_id),
                FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_dm_blocks_blocker ON dm_blocks(blocker_id);
            CREATE INDEX IF NOT EXISTS idx_dm_blocks_blocked ON dm_blocks(blocked_id);
        `);
        console.log('[DM] Tables ready');
    } catch (e) {
        console.warn('[DM] Table migration:', e.message);
    }
}

// ── Conversation helpers ─────────────────────────────────────

/**
 * Find an existing 1-on-1 conversation between two users.
 * Returns conversation row or null.
 */
function findDirectConversation(userIdA, userIdB) {
    return db.get(`
        SELECT c.* FROM dm_conversations c
        JOIN dm_participants p1 ON p1.conversation_id = c.id AND p1.user_id = ?
        JOIN dm_participants p2 ON p2.conversation_id = c.id AND p2.user_id = ?
        WHERE c.is_group = 0
    `, [userIdA, userIdB]) || null;
}

/**
 * Create a new conversation. Returns the new conversation id.
 * participantIds should include the creator.
 */
function createConversation(createdBy, participantIds, name = null) {
    const isGroup = participantIds.length > 2 ? 1 : 0;
    const result = db.run(
        `INSERT INTO dm_conversations (name, is_group, created_by) VALUES (?, ?, ?)`,
        [isGroup ? (name || null) : null, isGroup, createdBy]
    );
    const convId = result.lastInsertRowid;
    const insert = db.getDb().prepare(
        `INSERT OR IGNORE INTO dm_participants (conversation_id, user_id) VALUES (?, ?)`
    );
    for (const uid of participantIds) {
        insert.run(convId, uid);
    }
    return convId;
}

/**
 * Get or create a 1-on-1 conversation between two users.
 */
function getOrCreateDirect(userIdA, userIdB) {
    const existing = findDirectConversation(userIdA, userIdB);
    if (existing) return existing.id;
    return createConversation(userIdA, [userIdA, userIdB]);
}

/**
 * Add a participant to an existing group conversation.
 */
function addParticipant(conversationId, userId) {
    db.run(
        `INSERT OR IGNORE INTO dm_participants (conversation_id, user_id) VALUES (?, ?)`,
        [conversationId, userId]
    );
    // Mark as group if > 2 participants
    const count = db.get(
        `SELECT COUNT(*) as c FROM dm_participants WHERE conversation_id = ?`,
        [conversationId]
    )?.c || 0;
    if (count > 2) {
        db.run(`UPDATE dm_conversations SET is_group = 1 WHERE id = ?`, [conversationId]);
    }
}

/**
 * Remove a participant from a group conversation.
 */
function removeParticipant(conversationId, userId) {
    db.run(
        `DELETE FROM dm_participants WHERE conversation_id = ? AND user_id = ?`,
        [conversationId, userId]
    );
}

/**
 * Check if a user is a participant in a conversation.
 */
function isParticipant(conversationId, userId) {
    return !!db.get(
        `SELECT 1 FROM dm_participants WHERE conversation_id = ? AND user_id = ?`,
        [conversationId, userId]
    );
}

/**
 * Rename a group conversation.
 */
function renameConversation(conversationId, name) {
    db.run(`UPDATE dm_conversations SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [name, conversationId]);
}

/**
 * Get all conversations for a user with last message preview and unread count.
 */
function getConversations(userId) {
    return db.all(`
        SELECT
            c.id,
            c.name,
            c.is_group,
            c.updated_at,
            (SELECT dm.message FROM dm_messages dm WHERE dm.conversation_id = c.id ORDER BY dm.created_at DESC LIMIT 1) AS last_message,
            (SELECT dm.sender_id FROM dm_messages dm WHERE dm.conversation_id = c.id ORDER BY dm.created_at DESC LIMIT 1) AS last_sender_id,
            (SELECT dm.created_at FROM dm_messages dm WHERE dm.conversation_id = c.id ORDER BY dm.created_at DESC LIMIT 1) AS last_message_at,
            (SELECT COUNT(*) FROM dm_messages dm WHERE dm.conversation_id = c.id AND dm.created_at > p.last_read_at AND dm.sender_id != ?) AS unread_count
        FROM dm_conversations c
        JOIN dm_participants p ON p.conversation_id = c.id AND p.user_id = ?
        ORDER BY
            COALESCE((SELECT dm.created_at FROM dm_messages dm WHERE dm.conversation_id = c.id ORDER BY dm.created_at DESC LIMIT 1), c.created_at) DESC
    `, [userId, userId]);
}

/**
 * Get participants of a conversation (with user profile info).
 */
function getParticipants(conversationId) {
    return db.all(`
        SELECT u.id, u.username, u.display_name, u.avatar_url, u.profile_color
        FROM dm_participants p
        JOIN users u ON u.id = p.user_id
        WHERE p.conversation_id = ?
    `, [conversationId]);
}

/**
 * Get a single conversation by id (with participant info for the requesting user).
 */
function getConversation(conversationId) {
    return db.get(`SELECT * FROM dm_conversations WHERE id = ?`, [conversationId]) || null;
}

// ── Message helpers ──────────────────────────────────────────

/**
 * Send a message in a conversation. Returns the message row.
 */
function sendMessage(conversationId, senderId, text) {
    if (!text || !text.trim()) return null;
    const trimmed = text.trim().slice(0, 2000); // max 2000 chars
    const result = db.run(
        `INSERT INTO dm_messages (conversation_id, sender_id, message) VALUES (?, ?, ?)`,
        [conversationId, senderId, trimmed]
    );
    // Touch conversation updated_at
    db.run(`UPDATE dm_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [conversationId]);
    // Auto-mark read for sender
    markRead(conversationId, senderId);
    return db.get(`SELECT * FROM dm_messages WHERE id = ?`, [result.lastInsertRowid]);
}

/**
 * Get messages in a conversation (paginated, newest first).
 */
function getMessages(conversationId, limit = 50, before = null, after = null) {
    if (after) {
        // Fetch messages newer than `after` id (for live polling)
        return db.all(`
            SELECT m.*, u.username, u.display_name, u.avatar_url, u.profile_color
            FROM dm_messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.conversation_id = ? AND m.id > ?
            ORDER BY m.created_at ASC
            LIMIT ?
        `, [conversationId, after, limit]);
    }
    if (before) {
        return db.all(`
            SELECT m.*, u.username, u.display_name, u.avatar_url, u.profile_color
            FROM dm_messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.conversation_id = ? AND m.id < ?
            ORDER BY m.created_at DESC
            LIMIT ?
        `, [conversationId, before, limit]);
    }
    return db.all(`
        SELECT m.*, u.username, u.display_name, u.avatar_url, u.profile_color
        FROM dm_messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ?
        ORDER BY m.created_at DESC
        LIMIT ?
    `, [conversationId, limit]);
}

/**
 * Mark a conversation as read for a user (set last_read_at to now).
 */
function markRead(conversationId, userId) {
    db.run(
        `UPDATE dm_participants SET last_read_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND user_id = ?`,
        [conversationId, userId]
    );
}

/**
 * Get total unread message count across all conversations for a user.
 */
function getTotalUnread(userId) {
    const row = db.get(`
        SELECT COALESCE(SUM(unread), 0) as total FROM (
            SELECT COUNT(*) as unread
            FROM dm_messages m
            JOIN dm_participants p ON p.conversation_id = m.conversation_id AND p.user_id = ?
            WHERE m.created_at > p.last_read_at AND m.sender_id != ?
        )
    `, [userId, userId]);
    return row?.total || 0;
}

/**
 * Search users by username/display_name for the "new message" user picker.
 * Excludes the requesting user.
 */
function searchUsers(query, excludeUserId, limit = 10) {
    if (!query || query.length < 2) return [];
    return db.all(`
        SELECT id, username, display_name, avatar_url, profile_color
        FROM users
        WHERE id != ? AND is_banned = 0
          AND id NOT IN (SELECT blocked_id FROM dm_blocks WHERE blocker_id = ?)
          AND id NOT IN (SELECT blocker_id FROM dm_blocks WHERE blocked_id = ?)
          AND (username LIKE ? COLLATE NOCASE OR display_name LIKE ? COLLATE NOCASE)
        LIMIT ?
    `, [excludeUserId, excludeUserId, excludeUserId, `%${query}%`, `%${query}%`, limit]);
}

// ── Block helpers ────────────────────────────────────────────

/**
 * Check if either user has blocked the other (bidirectional).
 */
function isBlockedEither(userIdA, userIdB) {
    return !!db.get(
        `SELECT 1 FROM dm_blocks
         WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
        [userIdA, userIdB, userIdB, userIdA]
    );
}

/**
 * Check if blocker has blocked blocked (one-directional).
 */
function hasBlocked(blockerId, blockedId) {
    return !!db.get(
        `SELECT 1 FROM dm_blocks WHERE blocker_id = ? AND blocked_id = ?`,
        [blockerId, blockedId]
    );
}

/**
 * Block a user.
 */
function blockUser(blockerId, blockedId) {
    db.run(
        `INSERT OR IGNORE INTO dm_blocks (blocker_id, blocked_id) VALUES (?, ?)`,
        [blockerId, blockedId]
    );
}

/**
 * Unblock a user.
 */
function unblockUser(blockerId, blockedId) {
    db.run(
        `DELETE FROM dm_blocks WHERE blocker_id = ? AND blocked_id = ?`,
        [blockerId, blockedId]
    );
}

/**
 * Get all users blocked by blockerId.
 */
function getBlockedUsers(blockerId) {
    return db.all(`
        SELECT u.id, u.username, u.display_name, u.avatar_url, u.profile_color, b.created_at as blocked_at
        FROM dm_blocks b
        JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ?
        ORDER BY b.created_at DESC
    `, [blockerId]);
}

/**
 * Delete a message (only the sender can delete their own message).
 */
function deleteMessage(messageId, userId) {
    const msg = db.get(`SELECT * FROM dm_messages WHERE id = ?`, [messageId]);
    if (!msg || msg.sender_id !== userId) return false;
    db.run(`DELETE FROM dm_messages WHERE id = ?`, [messageId]);
    return true;
}

/**
 * Get the number of participants in a conversation.
 */
function getParticipantCount(conversationId) {
    const row = db.get(
        `SELECT COUNT(*) as c FROM dm_participants WHERE conversation_id = ?`,
        [conversationId]
    );
    return row?.c || 0;
}

// ── Anti-spam helpers ────────────────────────────────────────

/**
 * Detect spam patterns in DM message content.
 * Returns { isSpam: boolean, reason: string|null }
 */
function checkMessageSpam(text) {
    if (!text) return { isSpam: false, reason: null };
    const trimmed = text.trim();

    // Excessive caps (>70% caps in messages over 10 chars)
    if (trimmed.length > 10) {
        const alphaChars = trimmed.replace(/[^a-zA-Z]/g, '');
        if (alphaChars.length > 5) {
            const capsRatio = (alphaChars.replace(/[^A-Z]/g, '').length) / alphaChars.length;
            if (capsRatio > 0.7) return { isSpam: true, reason: 'Excessive caps' };
        }
    }

    // Repeated characters (e.g., "aaaaaaa" or "!!!!!!")
    if (/(.)\1{9,}/i.test(trimmed)) {
        return { isSpam: true, reason: 'Repeated characters' };
    }

    // Repeated words (same word 5+ times)
    const words = trimmed.toLowerCase().split(/\s+/);
    if (words.length >= 5) {
        const freq = {};
        for (const w of words) freq[w] = (freq[w] || 0) + 1;
        for (const w of Object.keys(freq)) {
            if (freq[w] >= 5 && freq[w] / words.length > 0.6) {
                return { isSpam: true, reason: 'Repetitive content' };
            }
        }
    }

    // Common spam patterns (URLs in bulk, typical scam patterns)
    const urlCount = (trimmed.match(/https?:\/\//gi) || []).length;
    if (urlCount >= 3) return { isSpam: true, reason: 'Too many URLs' };

    return { isSpam: false, reason: null };
}

/**
 * Check if this message is a duplicate of the user's recent messages.
 * Returns true if the exact same text was sent within the last N seconds.
 */
function isDuplicateMessage(conversationId, senderId, text, windowSeconds = 30) {
    const row = db.get(`
        SELECT 1 FROM dm_messages
        WHERE conversation_id = ? AND sender_id = ? AND message = ?
          AND created_at > datetime('now', '-' || ? || ' seconds')
        LIMIT 1
    `, [conversationId, senderId, text.trim().slice(0, 2000), windowSeconds]);
    return !!row;
}

/**
 * Check if a user account is too new to send DMs (minimum account age).
 * Returns { tooNew: boolean, minutesRemaining: number }
 */
function isAccountTooNew(userId, minMinutes = 5) {
    const user = db.get(`SELECT created_at FROM users WHERE id = ?`, [userId]);
    if (!user || !user.created_at) return { tooNew: false, minutesRemaining: 0 };
    const created = new Date(user.created_at.endsWith('Z') ? user.created_at : user.created_at + 'Z');
    const ageMs = Date.now() - created.getTime();
    const ageMinutes = ageMs / 60000;
    if (ageMinutes < minMinutes) {
        return { tooNew: true, minutesRemaining: Math.ceil(minMinutes - ageMinutes) };
    }
    return { tooNew: false, minutesRemaining: 0 };
}

module.exports = {
    ensureTables,
    findDirectConversation,
    createConversation,
    getOrCreateDirect,
    addParticipant,
    removeParticipant,
    isParticipant,
    renameConversation,
    getConversations,
    getParticipants,
    getConversation,
    sendMessage,
    getMessages,
    markRead,
    getTotalUnread,
    searchUsers,
    isBlockedEither,
    hasBlocked,
    blockUser,
    unblockUser,
    getBlockedUsers,
    deleteMessage,
    getParticipantCount,
    checkMessageSpam,
    isDuplicateMessage,
    isAccountTooNew,
};
