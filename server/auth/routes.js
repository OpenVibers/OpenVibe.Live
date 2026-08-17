/**
 * OpenVibe.Live — Auth Routes
 * All authentication is via OpenVibe.Tools OAuth2 SSO.
 * No local login/register — users sign in at openvibe.tools.
 *
 * GET  /api/auth/sso/login    — Redirect to openvibe.tools OAuth
 * GET  /api/auth/callback     — OAuth callback
 * GET  /api/auth/me           — Current user
 * PUT  /api/auth/profile      — Update profile
 * POST /api/auth/avatar       — Upload avatar
 * GET  /api/auth/stream-key
 * POST /api/auth/stream-key/regenerate
 * GET  /api/auth/user/:username
 * GET  /api/auth/sso/status
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const { requireAuth } = require('./auth');
const permissions = require('./permissions');
const config = require('../config');

const router = express.Router();

function cleanOptionalString(value) {
    if (value === undefined || value === null) return undefined;
    return String(value).trim();
}

/** Strip HTML tags from a string */
function stripHtml(str) {
    return str.replace(/<[^>]*>/g, '');
}

/**
 * Sanitize display names — strip HTML, control chars, and characters that could
 * cause injection issues in HTML attributes / JS string contexts / URLs.
 */
function sanitizeDisplayName(raw) {
    if (!raw) return raw;
    let s = stripHtml(raw);
    // Remove characters dangerous in HTML/JS/URL contexts
    s = s.replace(/[\\`'"<>(){};:/\[\]]/g, '');
    // Collapse whitespace and trim
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

function isValidEmail(value) {
    if (!value) return true;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isAllowedAvatarUrl(value) {
    if (!value) return true;
    if (value.startsWith('/data/avatars/')) return true;
    if (value.startsWith('/data/pastes/screenshots/')) return true;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

// ── Avatar Upload Config ─────────────────────────────────────
const avatarDir = path.resolve('./data/avatars');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });

const MIME_TO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif' };
const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, avatarDir),
    filename: (req, file, cb) => {
        const ext = MIME_TO_EXT[file.mimetype] || '.png';
        cb(null, `avatar-${req.user.id}-${Date.now()}${ext}`);
    },
});
const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
    fileFilter: (req, file, cb) => {
        const allowed = ['image/png', 'image/gif', 'image/webp', 'image/jpeg', 'image/avif'];
        cb(null, allowed.includes(file.mimetype));
    },
});

// ── Register (disabled — use openvibe.tools) ─────────────────────
router.post('/register', (_req, res) => {
    res.status(410).json({ error: 'Local registration is no longer available. Please sign in with OpenVibe.' });
});

// ── Login (disabled — use openvibe.tools) ────────────────────────
router.post('/login', (_req, res) => {
    res.status(410).json({ error: 'Local login is no longer available. Please sign in with OpenVibe.' });
});

// ── Get Current User ─────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
    res.json({
        user: sanitizeUser(req.user),
        capabilities: permissions.getCapabilities(req.user),
    });
});

// ── Update Profile ───────────────────────────────────────────
router.put('/profile', requireAuth, (req, res) => {
    try {
        let display_name = cleanOptionalString(req.body.display_name);
        let bio = cleanOptionalString(req.body.bio);
        const avatar_url = cleanOptionalString(req.body.avatar_url);
        const email = cleanOptionalString(req.body.email);
        const profile_color = cleanOptionalString(req.body.profile_color);
        const updates = [];
        const params = [];

        // Strip HTML tags from free-text fields
        if (display_name !== undefined) display_name = sanitizeDisplayName(display_name);
        if (bio !== undefined) bio = stripHtml(bio);

        if (display_name !== undefined && (display_name.length < 1 || display_name.length > 60)) {
            return res.status(400).json({ error: 'Display name must be 1-60 characters' });
        }
        // Display name may only re-case the actual username (e.g. "goosely" → "Goosely"),
        // not be an arbitrary different name.
        if (display_name !== undefined && req.user.username
            && display_name.toLowerCase() !== String(req.user.username).toLowerCase()) {
            return res.status(400).json({ error: `Display name can only change the capitalization of your username (${req.user.username}).` });
        }
        if (bio !== undefined && bio.length > 500) {
            return res.status(400).json({ error: 'Bio must be 500 characters or fewer' });
        }
        if (email !== undefined && (!isValidEmail(email) || email.length > 254)) {
            return res.status(400).json({ error: 'Invalid email address' });
        }
        if (profile_color !== undefined && profile_color !== '' && !/^#[0-9a-fA-F]{6}$/.test(profile_color)) {
            return res.status(400).json({ error: 'Profile color must be a 6-digit hex color' });
        }
        if (display_name !== undefined) { updates.push('display_name = ?'); params.push(display_name); }
        if (bio !== undefined) { updates.push('bio = ?'); params.push(bio); }
        // avatar_url is intentionally NOT settable here — avatars change only via the
        // /api/auth/avatar image upload (from /settings), which validates the file.
        if (email !== undefined) { updates.push('email = ?'); params.push(email); }
        if (profile_color !== undefined) { updates.push('profile_color = ?'); params.push(profile_color); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(req.user.id);

        db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
        const updated = db.getUserById(req.user.id);
        res.json({ user: sanitizeUser(updated) });
    } catch (err) {
        console.error('[Auth] Profile update error:', err.message);
        res.status(500).json({ error: 'Profile update failed' });
    }
});

// ── Change Password (disabled — managed on openvibe.tools) ──────
router.post('/change-password', (_req, res) => {
    res.status(410).json({ error: 'Password management has moved to openvibe.tools.' });
});

// ── Get Stream Key ───────────────────────────────────────────
router.get('/stream-key', requireAuth, (req, res) => {
    res.json({ stream_key: req.user.stream_key });
});

// ── Regenerate Stream Key ────────────────────────────────────
router.post('/stream-key/regenerate', requireAuth, (req, res) => {
    const newKey = uuidv4().replace(/-/g, '');
    db.run('UPDATE users SET stream_key = ? WHERE id = ?', [newKey, req.user.id]);
    res.json({ stream_key: newKey });
});

// ── Get User Profile (public) ────────────────────────────────
router.get('/user/:username', (req, res) => {
    const user = db.getUserByUsername(req.params.username);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: sanitizeUser(user, true) });
});

// ── Upload Avatar ────────────────────────────────────────────
router.post('/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });

        // Validate it's a REAL, decodable image of an allowed type (not just a
        // trusted mimetype / renamed file).
        try {
            const sharp = require('sharp');
            const meta = await sharp(req.file.path, { failOn: 'error' }).metadata();
            const okFormats = ['png', 'jpeg', 'gif', 'webp', 'avif'];
            if (!meta || !okFormats.includes(meta.format) || !meta.width || !meta.height) {
                try { fs.unlinkSync(req.file.path); } catch { /* */ }
                return res.status(400).json({ error: 'That file is not a valid image.' });
            }
        } catch (imgErr) {
            try { fs.unlinkSync(req.file.path); } catch { /* */ }
            return res.status(400).json({ error: 'That file is not a valid or is a corrupt image.' });
        }

        // Back the avatar with a paste: every upload becomes an avatar-tagged
        // screenshot paste (now stored in OpenVibe.Media), giving users an upload
        // history and letting staff moderate avatar images via the paste tooling.
        const media = require('../media-client');
        // Default to a PUBLIC paste (checkbox checked); accept opt-out via `public=false`.
        const makePublic = req.body.public === undefined ? true : !(req.body.public === 'false' || req.body.public === false || req.body.public === '0');
        const imageBuffer = fs.readFileSync(req.file.path);
        try { fs.unlinkSync(req.file.path); } catch { /* */ }
        const paste = await media.createPaste({
            title: 'Avatar upload',
            content: '',
            language: 'text',
            visibility: makePublic ? 'public' : 'unlisted',
            user_id: req.user.id,
            metadata: JSON.stringify({ kind: 'avatar', original_name: req.file.originalname || null, mime_type: req.file.mimetype || null }),
            screenshot: {
                buffer: imageBuffer,
                filename: req.file.originalname || 'avatar.png',
                contentType: req.file.mimetype || 'image/png',
            },
        });
        const screenshotUrl = media.publicUrl(paste.screenshot_url) || media.pasteRawUrl(paste.slug);
        db.updateUserAvatar(req.user.id, screenshotUrl, paste.id || null);

        const updated = db.getUserById(req.user.id);
        res.json({ user: sanitizeUser(updated), avatar_url: screenshotUrl });
    } catch (err) {
        if (req.file) try { fs.unlinkSync(req.file.path); } catch { }
        console.error('[Auth] Avatar upload error:', err.message);
        res.status(500).json({ error: 'Avatar upload failed' });
    }
});

// The user's avatar upload history (avatar-tagged screenshot pastes).
router.get('/avatar/history', requireAuth, (req, res) => {
    try {
        const me = db.getUserById(req.user.id);
        const activePasteId = me?.avatar_paste_id || null;
        // TODO(contract): avatar history reads the legacy local pastes rows only —
        // Media API v1 has no metadata-filtered paste listing yet, so avatars
        // uploaded after the media split appear once Media exposes such a filter.
        const rows = db.getUserAvatarPastes(req.user.id).map(r => ({
            slug: r.slug,
            title: r.title,
            created_at: r.created_at,
            url: r.screenshot_path ? `/data/pastes/screenshots/${path.basename(r.screenshot_path)}` : null,
            active: r.id === activePasteId,
        })).filter(r => r.url);
        res.json({ avatars: rows });
    } catch (err) {
        console.error('[Auth] Avatar history error:', err.message);
        res.status(500).json({ error: 'Failed to load avatar history' });
    }
});

// ═══════════════════════════════════════════════════════════════
// OpenVibe.Tools OAuth2 SSO Integration
// ═══════════════════════════════════════════════════════════════


const OV_CLIENT_ID = process.env.OV_OAUTH_CLIENT_ID || 'live';
const OV_CLIENT_SECRET = process.env.OV_OAUTH_CLIENT_SECRET || '';

function getNetworkBase() {
    return config.openvibeToolsUrl || config.baseUrl || 'https://openvibe.network';
}

function getNetworkTokenBase() {
    return config.openvibeToolsInternalUrl || getNetworkBase();
}

function getNetworkHttpModule() {
    const url = new URL(getNetworkTokenBase());
    return url.protocol === 'http:' ? require('http') : require('https');
}

function getNetworkRedirectUri() {
    return `${config.baseUrl.toLowerCase()}/api/auth/callback`;
}

// ── Initiate OAuth Login (redirect to openvibe.tools) ───────────
router.get('/sso/login', (req, res) => {
    const state = require('crypto').randomBytes(16).toString('hex');
    // Store state in a short-lived cookie for CSRF protection
    const isSecure = config.baseUrl.startsWith('https');
    res.cookie('oauth_state', state, { httpOnly: true, maxAge: 5 * 60 * 1000, sameSite: 'Lax', secure: isSecure });

    const params = new URLSearchParams({
        client_id: OV_CLIENT_ID,
        redirect_uri: getNetworkRedirectUri(),
        response_type: 'code',
        scope: 'profile theme',
        state,
    });
    res.redirect(`${getNetworkBase()}/oauth/authorize?${params.toString()}`);
});

// ── OAuth Callback (exchange code for token) ─────────────────
router.get('/callback', async (req, res) => {
    try {
        const { code, state } = req.query;
        if (!code) return res.status(400).send('Missing authorization code');

        // Validate CSRF state
        const savedState = req.cookies?.oauth_state;
        if (savedState && savedState !== state) {
            return res.status(403).send('Invalid state parameter');
        }
        res.clearCookie('oauth_state');

        // Exchange code for tokens
        const tokenData = await new Promise((resolve, reject) => {
            const body = JSON.stringify({
                grant_type: 'authorization_code',
                client_id: OV_CLIENT_ID,
                client_secret: OV_CLIENT_SECRET,
                code,
                redirect_uri: getNetworkRedirectUri(),
            });

            const url = new URL(`${getNetworkTokenBase()}/oauth/token`);
            const httpModule = getNetworkHttpModule();
            const reqOpts = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const httpReq = httpModule.request(reqOpts, (httpRes) => {
                let data = '';
                httpRes.on('data', chunk => data += chunk);
                httpRes.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch { reject(new Error('Invalid token response')); }
                });
            });
            httpReq.on('error', reject);
            httpReq.write(body);
            httpReq.end();
        });

        if (tokenData.error) {
            console.error('[Auth/SSO] Token exchange failed:', tokenData.error_description || tokenData.error);
            return res.status(400).send(`OAuth error: ${tokenData.error_description || tokenData.error}`);
        }

        const ssoUser = tokenData.user;
        if (!ssoUser) {
            return res.status(400).send('No user data in token response');
        }

        // Find or create local user linked to this openvibe.tools account
        const openvibeToolsId = String(ssoUser.id);

        // Check linked_accounts first
        let localUser = null;
        const linked = db.getDb().prepare(
            "SELECT user_id FROM linked_accounts WHERE service = 'network' AND service_user_id = ?"
        ).get(openvibeToolsId);

        if (linked) {
            localUser = db.getUserById(linked.user_id);
        }

        // Try matching by username
        if (!localUser) {
            localUser = db.getUserByUsername(ssoUser.username);
            if (localUser) {
                // Auto-link
                db.getDb().prepare(
                    "INSERT OR IGNORE INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (?, 'network', ?, ?)"
                ).run(localUser.id, openvibeToolsId, ssoUser.username);
            }
        }

        // Create new local user if none found
        if (!localUser) {
            const stream_key = uuidv4().replace(/-/g, '');
            const result = db.createUser({
                username: ssoUser.username,
                email: ssoUser.email || null,
                password_hash: '$sso$' + require('crypto').randomBytes(32).toString('hex'), // placeholder, can't login with password
                display_name: ssoUser.display_name || ssoUser.username,
                stream_key,
            });
            localUser = db.getUserById(result.lastInsertRowid);

            // Sync optional fields from openvibe.tools
            if (ssoUser.avatar_url) db.updateUserAvatar(localUser.id, ssoUser.avatar_url);
            if (ssoUser.bio) db.getDb().prepare('UPDATE users SET bio = ? WHERE id = ?').run(ssoUser.bio, localUser.id);
            if (ssoUser.role && ['user', 'streamer', 'global_mod', 'admin'].includes(ssoUser.role)) {
                db.getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(ssoUser.role, localUser.id);
            }
            if (ssoUser.profile_color) db.getDb().prepare('UPDATE users SET profile_color = ? WHERE id = ?').run(ssoUser.profile_color, localUser.id);

            // Link to openvibe.tools
            db.getDb().prepare(
                "INSERT OR IGNORE INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (?, 'network', ?, ?)"
            ).run(localUser.id, openvibeToolsId, ssoUser.username);

            localUser = db.getUserById(localUser.id); // re-fetch
            console.log(`[Auth/SSO] New local account created for openvibe.tools user ${ssoUser.username} (openvibe-tools id:${openvibeToolsId}, local id:${localUser.id})`);
        }

        // Register this account under the user's openvibe.tools Linked Services.
        try { require('../utils/notify').reportLinkedAccount(localUser); } catch { /* */ }

        // Use the openvibe.tools token directly (no more local tokens)
        const openvibeToolsToken = tokenData.access_token;
        const openvibeRefreshToken = tokenData.refresh_token;
        if (!openvibeToolsToken) {
            return res.status(500).send('No access token in response');
        }

        const isSecure = (process.env.BASE_URL || '').startsWith('https');

        // Set access token cookie (readable by JS for API calls)
        res.cookie('token', openvibeToolsToken, { httpOnly: false, path: '/', maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'Lax', secure: isSecure });

        // Also set ov_token (used by shared navbar/notification libs)
        res.cookie('ov_token', openvibeToolsToken, { httpOnly: false, path: '/', maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'Lax', secure: isSecure });

        // Store refresh token in httpOnly cookie (not readable by JS — server handles refresh)
        if (openvibeRefreshToken) {
            res.cookie('ov_refresh', openvibeRefreshToken, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'Lax', secure: isSecure, path: '/api/auth' });
        }

        // Return HTML that stores token in localStorage and redirects
        const userJson = JSON.stringify({ id: localUser.id, username: localUser.username, display_name: localUser.display_name || localUser.username, avatar_url: localUser.avatar_url || null });
        res.send(`<!DOCTYPE html>
<html><head><title>Logging in...</title></head>
<body>
<script>
    localStorage.setItem('token', ${JSON.stringify(openvibeToolsToken)});
    localStorage.setItem('ov_token', ${JSON.stringify(openvibeToolsToken)});
    // Seed account-switcher state so shared libs stay in sync
    try {
        var u = ${userJson};
        var acct = { id: u.id, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url, is_anon: false, token: ${JSON.stringify(openvibeToolsToken)}, added_at: Date.now() };
        localStorage.setItem('openvibe_accounts', JSON.stringify([acct]));
        localStorage.setItem('openvibe_active_account', String(u.id));
    } catch(e) {}
    window.location.href = '/';
</script>
<noscript><a href="/">Click here to continue</a></noscript>
</body></html>`);
    } catch (err) {
        console.error('[Auth/SSO] Callback error:', err);
        res.status(500).send('OAuth login failed. Please try again.');
    }
});

// ── Token Refresh (server-to-server using httpOnly refresh cookie) ──
router.post('/refresh', async (req, res) => {
    const refreshToken = req.cookies?.ov_refresh;
    if (!refreshToken) {
        return res.status(401).json({ error: 'No refresh token' });
    }
    try {
        const tokenData = await new Promise((resolve, reject) => {
            const body = JSON.stringify({
                grant_type: 'refresh_token',
                client_id: OV_CLIENT_ID,
                client_secret: OV_CLIENT_SECRET,
                refresh_token: refreshToken,
            });
            const url = new URL(`${getNetworkTokenBase()}/oauth/token`);
            const httpModule = getNetworkHttpModule();
            const httpReq = httpModule.request({
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, (httpRes) => {
                let data = '';
                httpRes.on('data', chunk => data += chunk);
                httpRes.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch { reject(new Error('Invalid response')); }
                });
            });
            httpReq.on('error', reject);
            httpReq.write(body);
            httpReq.end();
        });

        if (tokenData.error || !tokenData.access_token) {
            // Refresh failed — clear stale cookies
            res.clearCookie('ov_refresh', { path: '/api/auth' });
            return res.status(401).json({ error: tokenData.error_description || 'Refresh failed' });
        }

        const isSecure = (process.env.BASE_URL || '').startsWith('https');
        res.cookie('token', tokenData.access_token, { httpOnly: false, path: '/', maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'Lax', secure: isSecure });
        res.cookie('ov_token', tokenData.access_token, { httpOnly: false, path: '/', maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'Lax', secure: isSecure });
        if (tokenData.refresh_token) {
            res.cookie('ov_refresh', tokenData.refresh_token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'Lax', secure: isSecure, path: '/api/auth' });
        }
        res.json({ access_token: tokenData.access_token, expires_in: tokenData.expires_in || 86400 });
    } catch (err) {
        console.error('[Auth] Refresh error:', err.message);
        res.status(500).json({ error: 'Token refresh failed' });
    }
});

// ── Logout (clear all auth cookies) ──────────────────────────
router.post('/logout', (req, res) => {
    const isSecure = (process.env.BASE_URL || '').startsWith('https');
    res.clearCookie('token', { sameSite: 'Lax', secure: isSecure });
    res.clearCookie('ov_token', { sameSite: 'Lax', secure: isSecure });
    res.clearCookie('ov_refresh', { path: '/api/auth', sameSite: 'Lax', secure: isSecure });
    res.json({ ok: true });
});

// ── SSO Status (for client-side detection) ───────────────────
router.get('/sso/status', (req, res) => {
    res.json({
        enabled: !!OV_CLIENT_SECRET,
        provider: 'openvibe.tools',
        loginUrl: `${getNetworkBase()}/oauth/authorize`,
    });
});

router.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large (max 512KB)' });
    }
    res.status(500).json({ error: 'Upload failed' });
});

// ── Helper ───────────────────────────────────────────────────
function sanitizeUser(user, publicOnly = false) {
    const safe = {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        bio: user.bio,
        role: user.role,
        profile_color: user.profile_color,
        openvibe_bucks_balance: user.openvibe_bucks_balance,
        openvibe_coins_balance: user.openvibe_coins_balance,
        created_at: user.created_at,
        capabilities: permissions.getCapabilities(user),
    };
    if (!publicOnly) {
        safe.email = user.email;
        safe.stream_key = user.stream_key;
    }
    return safe;
}

// ── User Preferences (server-side chat settings sync) ────────────────────────
router.get('/preferences', requireAuth, (req, res) => {
    try {
        const prefs = db.getUserPreferences(req.user.id);
        res.json({ chatSettings: prefs });
    } catch (e) {
        console.error('[Auth] Error loading preferences:', e.message);
        res.status(500).json({ error: 'Failed to load preferences' });
    }
});

router.put('/preferences', requireAuth, (req, res) => {
    try {
        const { chatSettings } = req.body;
        if (!chatSettings || typeof chatSettings !== 'object') {
            return res.status(400).json({ error: 'chatSettings must be an object' });
        }
        // Sanity check: limit size to prevent abuse
        const json = JSON.stringify(chatSettings);
        if (json.length > 16384) {
            return res.status(400).json({ error: 'Settings too large' });
        }
        db.saveUserPreferences(req.user.id, chatSettings);
        res.json({ ok: true });
    } catch (e) {
        console.error('[Auth] Error saving preferences:', e.message);
        res.status(500).json({ error: 'Failed to save preferences' });
    }
});

// ── API Tokens (Bot / Integration) ───────────────────────────────────────────
const TOKEN_SCOPE_DEFINITIONS = Object.freeze([
    {
        id: 'chat',
        label: 'chat',
        title: 'Chat bot access',
        description: 'Send and receive authenticated chat messages via WebSocket and related chat APIs.',
    },
    {
        id: 'read',
        label: 'read',
        title: 'Read access',
        description: 'Read streams, VODs, user info, and other non-mutating integration surfaces.',
    },
    {
        id: 'stream',
        label: 'stream',
        title: 'Stream control',
        description: 'Start or stop streams and update stream state or metadata.',
    },
    {
        id: 'control',
        label: 'control',
        title: 'Hardware control bridge',
        description: 'Use the hardware control bridge and related remote-control surfaces.',
    },
    {
        id: 'vibe_coding_publish',
        label: 'vibe_coding_publish',
        title: 'Vibe coding publisher',
        description: 'Publish sanitized coding-feed events to /ws/vibe-coding/publish for a managed stream slot.',
    },
]);

const TOKEN_PRESET_DEFINITIONS = Object.freeze([
    {
        id: 'chat-bot',
        label: 'Chat Bot',
        description: 'Recommended for bots that read chat and post messages back into chat.',
        suggested_label: 'Chat Bot',
        scopes: ['chat', 'read'],
    },
    {
        id: 'vibe-coding-publisher',
        label: 'GitHub Copilot Companion',
        description: 'Recommended for the OpenVibe.Live VS Code companion and other coding-feed publishers.',
        suggested_label: 'Copilot Companion',
        scopes: ['read', 'vibe_coding_publish'],
    },
    {
        id: 'stream-controller',
        label: 'Stream Controller',
        description: 'Recommended for integrations that control live state, metadata, or hardware workflows.',
        suggested_label: 'Stream Controller',
        scopes: ['read', 'stream', 'control'],
    },
]);

const VALID_TOKEN_SCOPES = TOKEN_SCOPE_DEFINITIONS.map((scope) => scope.id);
const MAX_ACTIVE_API_TOKENS = 10;

function parseApiTokenScopes(rawScopes) {
    if (rawScopes !== undefined && !Array.isArray(rawScopes)) {
        return { error: 'Scopes must be an array' };
    }
    const requestedScopes = Array.isArray(rawScopes) && rawScopes.length
        ? rawScopes
        : ['chat', 'read'];
    const scopes = [...new Set(requestedScopes.filter(scope => VALID_TOKEN_SCOPES.includes(scope)))];
    if (!scopes.length) {
        return { error: 'At least one valid scope is required' };
    }
    return { scopes };
}

function parseApiTokenExpiry(rawExpiresAt) {
    if (rawExpiresAt === undefined || rawExpiresAt === null || rawExpiresAt === '') {
        return { expiresAt: null };
    }
    const expiresAt = new Date(rawExpiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
        return { error: 'Invalid expiresAt value' };
    }
    if (expiresAt.getTime() <= Date.now()) {
        return { error: 'Expiration must be in the future' };
    }
    return { expiresAt: expiresAt.toISOString() };
}

function normalizeApiTokenLabel(rawLabel) {
    if (typeof rawLabel !== 'string') return 'Bot Token';
    const label = rawLabel.trim();
    return label ? label.slice(0, 50) : 'Bot Token';
}

function serializeApiToken(token) {
    return {
        id: token.id,
        label: token.label,
        scopes: (() => {
            try {
                return JSON.parse(token.scopes);
            } catch {
                return [];
            }
        })(),
        created_at: token.created_at,
        last_used_at: token.last_used_at,
        expires_at: token.expires_at,
        is_active: !!token.is_active,
    };
}

router.post('/tokens', requireAuth, (req, res) => {
    try {
        // API tokens can't create other API tokens
        if (req.authSource === 'api_token') {
            return res.status(403).json({ error: 'Cannot create tokens using an API token' });
        }
        const { scopes, expiresAt } = req.body || {};
        const label = normalizeApiTokenLabel(req.body?.label);
        const scopeResult = parseApiTokenScopes(scopes);
        if (scopeResult.error) {
            return res.status(400).json({ error: scopeResult.error });
        }
        const expiryResult = parseApiTokenExpiry(expiresAt);
        if (expiryResult.error) {
            return res.status(400).json({ error: expiryResult.error });
        }
        // Limit to 10 active tokens per user
        const existing = db.listApiTokens(req.user.id).filter(t => t.is_active);
        if (existing.length >= MAX_ACTIVE_API_TOKENS) {
            return res.status(400).json({ error: `Maximum ${MAX_ACTIVE_API_TOKENS} active tokens per account` });
        }
        const result = db.createApiToken(req.user.id, label, scopeResult.scopes, expiryResult.expiresAt);
        console.log(`[Auth] API token created: user=${req.user.username} label=${label} scopes=${scopeResult.scopes.join(',')}`);
        res.json({
            id: result.id,
            token: result.token,
            label,
            created_at: result.created_at,
            expires_at: expiryResult.expiresAt,
            scopes: scopeResult.scopes,
            max_active_tokens: MAX_ACTIVE_API_TOKENS,
        });
    } catch (e) {
        console.error('[Auth] Token creation error:', e.message);
        res.status(500).json({ error: 'Failed to create token' });
    }
});

router.get('/tokens', requireAuth, (req, res) => {
    try {
        if (req.authSource === 'api_token') {
            return res.status(403).json({ error: 'Cannot list tokens using an API token' });
        }
        const tokens = db.listApiTokens(req.user.id).map(serializeApiToken);
        res.json({
            tokens,
            valid_scopes: VALID_TOKEN_SCOPES,
            scope_definitions: TOKEN_SCOPE_DEFINITIONS,
            token_presets: TOKEN_PRESET_DEFINITIONS,
            max_active_tokens: MAX_ACTIVE_API_TOKENS,
            active_token_count: tokens.filter(token => token.is_active).length,
        });
    } catch (e) {
        console.error('[Auth] Token list error:', e.message);
        res.status(500).json({ error: 'Failed to list tokens' });
    }
});

router.delete('/tokens/:id', requireAuth, (req, res) => {
    try {
        if (req.authSource === 'api_token') {
            return res.status(403).json({ error: 'Cannot revoke tokens using an API token' });
        }
        const result = db.revokeApiToken(parseInt(req.params.id), req.user.id);
        if (!result?.changes) {
            return res.status(404).json({ error: 'Token not found or not yours' });
        }
        console.log(`[Auth] API token revoked: id=${req.params.id} user=${req.user.username}`);
        res.json({ ok: true });
    } catch (e) {
        console.error('[Auth] Token revoke error:', e.message);
        res.status(500).json({ error: 'Failed to revoke token' });
    }
});

// ── ICE / TURN server config (public — needed by unauthenticated voice chat) ─
router.get('/ice-servers', (req, res) => {
    const servers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
    ];
    if (config.turn?.url) {
        const hasTurnAuth = config.turn.username && config.turn.credential;
        servers.push(
            hasTurnAuth
                ? { urls: config.turn.url, username: config.turn.username, credential: config.turn.credential }
                : { urls: config.turn.url },
            hasTurnAuth
                ? { urls: `${config.turn.url}?transport=tcp`, username: config.turn.username, credential: config.turn.credential }
                : { urls: `${config.turn.url}?transport=tcp` },
        );
        if (!hasTurnAuth && (config.turn.username || config.turn.credential)) {
            console.warn('[ICE] Incomplete TURN credentials configured; emitting TURN URLs without auth.');
        }
    }
    res.json({ iceServers: servers });
});

module.exports = router;
