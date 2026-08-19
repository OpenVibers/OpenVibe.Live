-- OpenVibe.Live Database Schema
-- SQLite3

-- Users
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    bio TEXT DEFAULT '',
    role TEXT DEFAULT 'user' CHECK(role IN ('user', 'streamer', 'global_mod', 'admin')),
    stream_key TEXT UNIQUE,
    openvibe_bucks_balance REAL DEFAULT 0.00,
    openvibe_coins_balance INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    ban_reason TEXT,
    profile_color TEXT DEFAULT '#8b5cf6',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Channels (permanent streamer page, static URL = /username)
CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    title TEXT DEFAULT 'Untitled Channel',
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'irl',
    tags TEXT DEFAULT '[]',
    protocol TEXT DEFAULT 'webrtc' CHECK(protocol IN ('jsmpeg', 'webrtc', 'rtmp')),
    is_nsfw INTEGER DEFAULT 0,
    auto_record INTEGER DEFAULT 0,
    offline_banner_url TEXT,
    panels TEXT DEFAULT '[]',              -- JSON array of info panels
    emote_sources TEXT DEFAULT '{"defaults":true,"custom":true,"ffz":true,"bttv":true,"7tv":true}',
    default_vod_visibility TEXT DEFAULT 'public' CHECK(default_vod_visibility IN ('public', 'unlisted', 'private')),
    default_clip_visibility TEXT DEFAULT 'public' CHECK(default_clip_visibility IN ('public', 'unlisted', 'private')),
    vod_recording_enabled INTEGER DEFAULT 1,
    force_vod_recording_disabled INTEGER DEFAULT 0,
    weather_zip TEXT DEFAULT NULL,
    weather_detail TEXT DEFAULT 'basic' CHECK(weather_detail IN ('off', 'basic', 'hourly', 'detailed')),
    weather_show_location INTEGER DEFAULT 0,
    control_mode TEXT DEFAULT 'open' CHECK(control_mode IN ('open','whitelist','disabled')),
    anon_controls_enabled INTEGER DEFAULT 1,
    control_rate_limit_ms INTEGER DEFAULT 100,
    video_click_enabled INTEGER DEFAULT 0,
    video_click_rate_limit_ms INTEGER DEFAULT 0,
    active_control_config_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- RobotStreamer integrations (private per-streamer restream/chat bridge config)
CREATE TABLE IF NOT EXISTS robotstreamer_integrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    enabled INTEGER DEFAULT 0,
    mirror_chat INTEGER DEFAULT 1,
    token TEXT,
    robot_id TEXT,
    owner_id TEXT,
    chat_url TEXT,
    control_url TEXT,
    rtc_sfu_url TEXT,
    stream_name TEXT,
    owner_name TEXT,
    last_validated_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Managed Streams (persistent per-user stream definitions with stable endpoints)
CREATE TABLE IF NOT EXISTS managed_streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel_id INTEGER,
    slug TEXT,                              -- optional unique string ID (must contain non-numeric chars)
    title TEXT DEFAULT 'Untitled Stream',
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'irl',
    tags TEXT DEFAULT '[]',
    protocol TEXT DEFAULT 'webrtc' CHECK(protocol IN ('jsmpeg', 'webrtc', 'rtmp')),
    stream_key TEXT UNIQUE NOT NULL,       -- per-stream stable key (reusable across sessions)
    is_nsfw INTEGER DEFAULT 0,
    control_config_id INTEGER,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL,
    FOREIGN KEY (control_config_id) REFERENCES control_configs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_managed_streams_user ON managed_streams(user_id);
CREATE INDEX IF NOT EXISTS idx_managed_streams_slug ON managed_streams(slug);
CREATE INDEX IF NOT EXISTS idx_managed_streams_key ON managed_streams(stream_key);

-- Streams (broadcast sessions on a managed stream)
CREATE TABLE IF NOT EXISTS streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel_id INTEGER,
    managed_stream_id INTEGER,
    control_config_id INTEGER,
    title TEXT DEFAULT 'Untitled Stream',
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'irl',
    tags TEXT DEFAULT '[]',
    protocol TEXT DEFAULT 'webrtc' CHECK(protocol IN ('jsmpeg', 'webrtc', 'rtmp')),
    is_live INTEGER DEFAULT 0,
    is_nsfw INTEGER DEFAULT 0,
    viewer_count INTEGER DEFAULT 0,
    peak_viewers INTEGER DEFAULT 0,
    follower_count INTEGER DEFAULT 0,
    thumbnail_url TEXT,
    multi_cam INTEGER DEFAULT 0,
    started_at DATETIME,
    ended_at DATETIME,
    last_heartbeat DATETIME,
    duration_seconds INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL,
    FOREIGN KEY (managed_stream_id) REFERENCES managed_streams(id) ON DELETE SET NULL,
    FOREIGN KEY (control_config_id) REFERENCES control_configs(id) ON DELETE SET NULL
);

-- Cameras (multi-cam support)
CREATE TABLE IF NOT EXISTS cameras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER NOT NULL,
    camera_index INTEGER DEFAULT 0,
    label TEXT DEFAULT 'Main',
    protocol TEXT DEFAULT 'jsmpeg',
    jsmpeg_video_port INTEGER,
    jsmpeg_audio_port INTEGER,
    webrtc_room_id TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
);

-- Chat messages (stored for moderation / VOD replay)
CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER,
    user_id INTEGER,                       -- NULL for anon
    anon_id TEXT,                          -- 'anon12345' format
    username TEXT,
    message TEXT NOT NULL,
    message_type TEXT DEFAULT 'chat' CHECK(message_type IN ('chat', 'system', 'donation', 'command', 'tts')),
    metadata TEXT,                         -- JSON sidecar for rich events (donation/goal-reached)
    is_global INTEGER DEFAULT 0,
    is_deleted INTEGER DEFAULT 0,
    is_filtered INTEGER DEFAULT 0,
    reply_to_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
    source_platform TEXT,
    deleted_by INTEGER,
    deleted_at DATETIME,
    auto_delete_at DATETIME,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS vibe_coding_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    managed_stream_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    session_key TEXT NOT NULL,
    slot_slug TEXT,
    workspace_name TEXT,
    machine_name TEXT,
    extension_version TEXT,
    publisher_id TEXT,
    publisher_label TEXT,
    publisher_vendor TEXT,
    publisher_client_type TEXT,
    publisher_client_name TEXT,
    publisher_client_version TEXT,
    publisher_capabilities_json TEXT,
    publisher_depth TEXT DEFAULT 'standard',
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'ended')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_event_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    FOREIGN KEY (managed_stream_id) REFERENCES managed_streams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (managed_stream_id, session_key)
);
CREATE INDEX IF NOT EXISTS idx_vibe_sessions_managed ON vibe_coding_sessions(managed_stream_id);
CREATE INDEX IF NOT EXISTS idx_vibe_sessions_user ON vibe_coding_sessions(user_id);

CREATE TABLE IF NOT EXISTS vibe_coding_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    managed_stream_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    stream_id INTEGER,
    session_key TEXT,
    event_id TEXT NOT NULL,
    sequence_num INTEGER DEFAULT 0,
    event_type TEXT NOT NULL,
    visibility TEXT DEFAULT 'public' CHECK(visibility IN ('public', 'streamer')),
    depth TEXT DEFAULT 'standard',
    summary TEXT DEFAULT '',
    payload_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (managed_stream_id) REFERENCES managed_streams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
    UNIQUE (managed_stream_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_vibe_events_managed ON vibe_coding_events(managed_stream_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_vibe_events_stream ON vibe_coding_events(stream_id);

-- Follows
CREATE TABLE IF NOT EXISTS follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    follower_id INTEGER NOT NULL,
    streamer_id INTEGER NOT NULL,
    email_notify INTEGER DEFAULT 0,
    push_notify INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(follower_id, streamer_id),
    FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (streamer_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER NOT NULL,
    streamer_id INTEGER NOT NULL,
    tier INTEGER DEFAULT 1 CHECK(tier IN (1, 2, 3)),
    is_active INTEGER DEFAULT 1,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    FOREIGN KEY (subscriber_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (streamer_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Vibes Transactions
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER,
    to_user_id INTEGER,
    stream_id INTEGER,
    amount INTEGER NOT NULL,              -- in bits (cents)
    type TEXT NOT NULL CHECK(type IN ('donation', 'purchase', 'subscription', 'cashout', 'refund', 'bonus')),
    status TEXT DEFAULT 'completed' CHECK(status IN ('pending', 'completed', 'failed', 'escrow', 'refunded')),
    message TEXT,
    paypal_transaction_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL
);

-- Donation Goals
CREATE TABLE IF NOT EXISTS donation_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    target_amount INTEGER NOT NULL,        -- in Vibes (dollars)
    current_amount INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    image_url TEXT,                        -- optional goal media (webp image / webm video)
    media_type TEXT,                       -- 'image' | 'video'
    reached_at DATETIME,                   -- set when target hit; drives the ~1h celebration window
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- VODs (Video on Demand)
CREATE TABLE IF NOT EXISTS vods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER,
    user_id INTEGER NOT NULL,
    title TEXT,
    description TEXT DEFAULT '',
    file_path TEXT NOT NULL,
    thumbnail_url TEXT,
    master_file_path TEXT,
    file_size INTEGER DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    probe_duration_seconds REAL DEFAULT 0,
    probe_format_json TEXT DEFAULT '',
    health_status TEXT DEFAULT 'unknown',
    health_score INTEGER DEFAULT 0,
    health_issues_json TEXT DEFAULT '[]',
    last_health_scan_at DATETIME,
    quarantined_at DATETIME,
    is_public INTEGER DEFAULT 1,
    is_recording INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Clips
CREATE TABLE IF NOT EXISTS clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vod_id INTEGER,
    stream_id INTEGER,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT 'Untitled Clip',
    description TEXT DEFAULT '',
    file_path TEXT,
    thumbnail_url TEXT,
    start_time REAL NOT NULL DEFAULT 0,
    end_time REAL NOT NULL DEFAULT 0,
    duration_seconds REAL DEFAULT 0,
    is_public INTEGER DEFAULT 1,
    view_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vod_id) REFERENCES vods(id) ON DELETE SET NULL,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Unique view tracking (IP-based dedup for VODs and clips)
CREATE TABLE IF NOT EXISTS content_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_type TEXT NOT NULL CHECK(content_type IN ('vod', 'clip')),
    content_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(content_type, content_id, ip)
);
CREATE INDEX IF NOT EXISTS idx_content_views_lookup ON content_views(content_type, content_id);

-- ONVIF Camera Profiles (for PTZ control)
CREATE TABLE IF NOT EXISTS camera_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stream_id INTEGER,                      -- NULL = global profile
    name TEXT NOT NULL,
    onvif_url TEXT NOT NULL,                -- e.g., http://192.168.1.100:8080
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,            -- bcrypt hashed
    pan_speed REAL DEFAULT 0.5,             -- 0.0-1.0
    tilt_speed REAL DEFAULT 0.5,
    zoom_speed REAL DEFAULT 0.5,
    is_active INTEGER DEFAULT 1,
    last_connected DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
);

-- ONVIF Camera Presets (saved PTZ positions)
CREATE TABLE IF NOT EXISTS camera_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    pan REAL NOT NULL,                      -- 0.0-1.0
    tilt REAL NOT NULL,
    zoom REAL NOT NULL,
    preset_token TEXT,                      -- ONVIF device preset token (if supported)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (camera_id) REFERENCES camera_profiles(id) ON DELETE CASCADE
);

-- Stream Controls (interactive buttons/commands)
CREATE TABLE IF NOT EXISTS stream_controls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    command TEXT NOT NULL,                  -- command string sent to hardware
    icon TEXT DEFAULT 'fa-gamepad',         -- Font Awesome icon class
    control_type TEXT DEFAULT 'button' CHECK(control_type IN ('button', 'toggle', 'slider', 'dpad', 'onvif', 'keyboard')),
    key_binding TEXT,                       -- keyboard shortcut
    cooldown_ms INTEGER DEFAULT 100,
    is_enabled INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    camera_id INTEGER,                      -- NULL for non-ONVIF controls; references camera_profiles(id)
    onvif_movement TEXT,                    -- 'pan_left', 'pan_right', 'tilt_up', 'tilt_down', 'zoom_in', 'zoom_out', 'preset'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE,
    FOREIGN KEY (camera_id) REFERENCES camera_profiles(id) ON DELETE SET NULL
);

-- Control API Keys (for hardware clients)
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_hash TEXT UNIQUE NOT NULL,
    label TEXT DEFAULT 'Default',
    permissions TEXT DEFAULT '["control","stream"]',  -- JSON array
    last_used DATETIME,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Bot / Integration API Tokens (general-purpose, long-lived)
CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    label TEXT DEFAULT 'Bot Token',
    scopes TEXT DEFAULT '["chat","read"]',  -- JSON array: chat, stream, control, read, admin
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    expires_at DATETIME,                     -- NULL = never expires
    is_active INTEGER DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Bans / Moderation
CREATE TABLE IF NOT EXISTS bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER,                     -- NULL = site-wide
    user_id INTEGER,
    ip_address TEXT,
    anon_id TEXT,
    reason TEXT,
    banned_by INTEGER,
    expires_at DATETIME,                   -- NULL = permanent
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (banned_by) REFERENCES users(id) ON DELETE SET NULL
);

-- VPN approval queue
CREATE TABLE IF NOT EXISTS vpn_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT NOT NULL,
    user_id INTEGER,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied')),
    reviewed_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Themes (community theme directory)
CREATE TABLE IF NOT EXISTS themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    author_id INTEGER,
    description TEXT DEFAULT '',
    mode TEXT DEFAULT 'dark' CHECK(mode IN ('dark', 'light')),
    variables TEXT NOT NULL DEFAULT '{}',   -- JSON: CSS variable overrides
    preview_colors TEXT DEFAULT '{}',       -- JSON: {bg, accent, text} for quick preview
    is_builtin INTEGER DEFAULT 0,
    is_public INTEGER DEFAULT 1,
    downloads INTEGER DEFAULT 0,
    rating_sum INTEGER DEFAULT 0,
    rating_count INTEGER DEFAULT 0,
    tags TEXT DEFAULT '[]',                 -- JSON array
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);

-- User theme preferences
CREATE TABLE IF NOT EXISTS user_themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    theme_id INTEGER,                       -- NULL = custom
    custom_variables TEXT DEFAULT '{}',     -- JSON: custom overrides
    is_custom INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE SET NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_themes_slug ON themes(slug);
CREATE INDEX IF NOT EXISTS idx_themes_author ON themes(author_id);
CREATE INDEX IF NOT EXISTS idx_themes_public ON themes(is_public);
CREATE INDEX IF NOT EXISTS idx_user_themes_user ON user_themes(user_id);
CREATE INDEX IF NOT EXISTS idx_streams_user_id ON streams(user_id);
CREATE INDEX IF NOT EXISTS idx_streams_is_live ON streams(is_live);
CREATE INDEX IF NOT EXISTS idx_streams_channel_id ON streams(channel_id);
CREATE INDEX IF NOT EXISTS idx_channels_user_id ON channels(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_stream_id ON chat_messages(stream_id);
CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_chat_user_id ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_follows_streamer ON follows(streamer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_to_user ON transactions(to_user_id);
CREATE INDEX IF NOT EXISTS idx_vods_user_id ON vods(user_id);
CREATE INDEX IF NOT EXISTS idx_clips_stream_id ON clips(stream_id);
CREATE INDEX IF NOT EXISTS idx_clips_user_id ON clips(user_id);
CREATE INDEX IF NOT EXISTS idx_bans_stream_id ON bans(stream_id);
CREATE INDEX IF NOT EXISTS idx_cameras_stream_id ON cameras(stream_id);

-- Channel Moderators (per-channel mod assignments)
CREATE TABLE IF NOT EXISTS channel_moderators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    added_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel_id, user_id),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_mods_channel ON channel_moderators(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_mods_user ON channel_moderators(user_id);

-- Per-channel moderation settings (slow mode, etc.)
CREATE TABLE IF NOT EXISTS channel_moderation_settings (
    channel_id INTEGER PRIMARY KEY,
    slow_mode_seconds INTEGER DEFAULT 0,
    followers_only INTEGER DEFAULT 0,
    emote_only INTEGER DEFAULT 0,
    allow_anonymous INTEGER DEFAULT 1,
    links_allowed INTEGER DEFAULT 1,
    gifs_enabled INTEGER DEFAULT 1,
    account_age_gate_hours INTEGER DEFAULT 0,
    caps_percentage_limit INTEGER DEFAULT 0,
    aggressive_filter INTEGER DEFAULT 0,
    max_message_length INTEGER DEFAULT 500,
    slur_filter_enabled INTEGER DEFAULT 0,
    slur_filter_use_builtin INTEGER DEFAULT 1,
    slur_filter_terms TEXT DEFAULT '',
    slur_filter_regexes TEXT DEFAULT '',
    slur_filter_nudge_message TEXT DEFAULT '',
    slur_filter_disabled_categories TEXT DEFAULT '[]',
    ip_approval_mode INTEGER DEFAULT 0,
    soundboard_enabled INTEGER DEFAULT 1,
    soundboard_allow_pitch INTEGER DEFAULT 1,
    soundboard_allow_speed INTEGER DEFAULT 1,
    soundboard_banned_ids TEXT DEFAULT '',
    viewer_auto_delete_enabled INTEGER DEFAULT 1,
    viewer_delete_all_enabled INTEGER DEFAULT 1,
    custom_emotes_enabled INTEGER DEFAULT 1,   -- viewers may upload gif/png emotes for this channel
    custom_sounds_enabled INTEGER DEFAULT 1,   -- viewers may upload !sound commands for this channel
    max_sound_seconds INTEGER DEFAULT 10,      -- max duration of an uploaded channel sound
    uploads_mods_only INTEGER DEFAULT 0,       -- restrict emote/sound uploads to channel mods
    mods_can_edit_about INTEGER DEFAULT 0,     -- allow channel mods to edit the streamer's About/panels
    donation_sound_url TEXT,                   -- on-disk path to the streamer's donation alert sound
    donation_sound_mime TEXT,
    goal_sound_url TEXT,                       -- optional override sound for goal-reached
    goal_sound_mime TEXT,
    emote_scale INTEGER DEFAULT 100,           -- emote display size in chat, percent (50-300)
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

-- ═══════════════════════════════════════════════════════════════
-- Site Settings (key/value store for platform configuration)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    description TEXT DEFAULT '',
    type TEXT DEFAULT 'string' CHECK(type IN ('string', 'number', 'boolean', 'json')),
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════
-- Verification Keys (for legacy RS-Companion users to claim usernames)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS verification_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    target_username TEXT NOT NULL,          -- the reserved username this key unlocks
    note TEXT DEFAULT '',                   -- admin notes (e.g. RS-Companion user_id)
    created_by INTEGER NOT NULL,           -- admin who generated it
    used_by INTEGER,                       -- user who redeemed it (NULL until used)
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'used', 'revoked')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_vkeys_key ON verification_keys(key);
CREATE INDEX IF NOT EXISTS idx_vkeys_target ON verification_keys(target_username);
CREATE INDEX IF NOT EXISTS idx_vkeys_status ON verification_keys(status);

-- Comments (YouTube-style, on VODs and clips)
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_type TEXT NOT NULL CHECK(content_type IN ('vod', 'clip')),
    content_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    parent_id INTEGER,                     -- NULL = top-level, set = reply
    message TEXT NOT NULL,
    is_deleted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_content ON comments(content_type, content_id);
CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

-- Custom emotes (per-channel or global)
CREATE TABLE IF NOT EXISTS emotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,              -- owner / uploader
    code TEXT NOT NULL,                     -- trigger word, e.g. 'openvibeWave'
    url TEXT NOT NULL,                      -- served path or external URL
    animated INTEGER DEFAULT 0,
    width INTEGER DEFAULT 28,
    height INTEGER DEFAULT 28,
    is_global INTEGER DEFAULT 0,            -- admin-uploaded global emotes
    is_approved INTEGER DEFAULT 1,
    channel_owner_id INTEGER,               -- streamer whose channel this emote belongs to (NULL = uploader's own channel)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, code),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_emotes_user ON emotes(user_id);
CREATE INDEX IF NOT EXISTS idx_emotes_global ON emotes(is_global);
CREATE INDEX IF NOT EXISTS idx_emotes_code ON emotes(code);
-- NOTE: idx_emotes_channel_owner is created by the runtime migration in database.js,
-- after the channel_owner_id column is ALTER-added on pre-existing databases.

-- Per-channel viewer-uploadable sound commands (triggered by !name in chat)
CREATE TABLE IF NOT EXISTS channel_sounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_owner_id INTEGER NOT NULL,      -- streamer whose channel this sound belongs to
    command TEXT NOT NULL,                   -- trigger word (without leading '!'), lowercased
    url TEXT NOT NULL,                       -- served path of the audio file on disk
    mime TEXT DEFAULT 'audio/mpeg',
    duration_seconds REAL DEFAULT 0,
    created_by INTEGER,                      -- uploader user id (NULL if removed user)
    created_by_name TEXT DEFAULT '',
    is_approved INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Multiple sounds may share a command; playback picks one at random.
    FOREIGN KEY (channel_owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_channel_sounds_owner ON channel_sounds(channel_owner_id);
CREATE INDEX IF NOT EXISTS idx_channel_sounds_cmd ON channel_sounds(channel_owner_id, command);

-- ═══════════════════════════════════════════════════════════════
-- OpenCoins (Channel Points — free loyalty currency)
-- Earned by watching streams, chatting, etc. Global across all streams.
-- ═══════════════════════════════════════════════════════════════

-- Coin balance stored on users table (openvibe_coins_balance column added via ALTER)
-- See users table: openvibe_coins_balance INTEGER DEFAULT 0

-- Coin transaction log
CREATE TABLE IF NOT EXISTS coin_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stream_id INTEGER,                      -- NULL for non-stream earnings
    amount INTEGER NOT NULL,                -- positive = earned, negative = spent
    type TEXT NOT NULL CHECK(type IN ('watch', 'chat_bonus', 'follow_bonus', 'redeem', 'admin_grant', 'refund')),
    reward_id INTEGER,                      -- if type='redeem', links to coin_rewards
    message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
    FOREIGN KEY (reward_id) REFERENCES coin_rewards(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_coin_tx_user ON coin_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_coin_tx_stream ON coin_transactions(stream_id);

-- Streamer-configured rewards that viewers can redeem with OpenCoins
CREATE TABLE IF NOT EXISTS coin_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER NOT NULL,           -- who created this reward
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    cost INTEGER NOT NULL DEFAULT 100,      -- OpenCoins cost
    icon TEXT DEFAULT 'fa-star',            -- Font Awesome icon
    color TEXT DEFAULT '#8b5cf6',           -- accent color
    cooldown_seconds INTEGER DEFAULT 0,     -- per-user cooldown
    max_per_stream INTEGER DEFAULT 0,       -- 0 = unlimited
    requires_input INTEGER DEFAULT 0,       -- viewer must type a message
    is_enabled INTEGER DEFAULT 1,
    is_global INTEGER DEFAULT 0,            -- admin: available on all channels
    redemption_count INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (streamer_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_coin_rewards_streamer ON coin_rewards(streamer_id);

-- Track individual redemptions (for cooldowns & streamer action queue)
CREATE TABLE IF NOT EXISTS coin_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reward_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    stream_id INTEGER,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'fulfilled', 'rejected', 'refunded')),
    user_input TEXT,                        -- message if requires_input
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    FOREIGN KEY (reward_id) REFERENCES coin_rewards(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_coin_redemptions_stream ON coin_redemptions(stream_id);
CREATE INDEX IF NOT EXISTS idx_coin_redemptions_user ON coin_redemptions(user_id);

-- Watch time tracking (for passive coin earning)
CREATE TABLE IF NOT EXISTS watch_time (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stream_id INTEGER NOT NULL,
    minutes_watched INTEGER DEFAULT 0,
    last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP,
    coins_earned INTEGER DEFAULT 0,         -- coins earned this session
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, stream_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_watch_time_user ON watch_time(user_id);
CREATE INDEX IF NOT EXISTS idx_watch_time_stream ON watch_time(stream_id);

-- Streamer media request settings
CREATE TABLE IF NOT EXISTS media_request_settings (
    user_id INTEGER PRIMARY KEY,
    enabled INTEGER DEFAULT 1,
    request_cost INTEGER DEFAULT 25,
    max_per_user INTEGER DEFAULT 3,
    max_duration_seconds INTEGER DEFAULT 600,
    allow_youtube INTEGER DEFAULT 1,
    allow_vimeo INTEGER DEFAULT 1,
    allow_direct_media INTEGER DEFAULT 1,
    auto_advance INTEGER DEFAULT 1,
    currency TEXT DEFAULT 'opencoins' CHECK(currency IN ('free','vibes','opencoins','points')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Media request queue and playback history
CREATE TABLE IF NOT EXISTS media_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER NOT NULL,
    stream_id INTEGER,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    input TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    embed_url TEXT,
    provider TEXT NOT NULL CHECK(provider IN ('youtube', 'vimeo', 'audio', 'video')),
    title TEXT NOT NULL,
    thumbnail_url TEXT,
    duration_seconds INTEGER,
    cost INTEGER NOT NULL DEFAULT 25,
    currency TEXT DEFAULT 'opencoins',
    queue_position INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'playing', 'played', 'skipped', 'removed', 'failed')),
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    ended_at DATETIME,
    last_error TEXT,
    FOREIGN KEY (streamer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_media_requests_streamer_status ON media_requests(streamer_id, status, queue_position, requested_at);
CREATE INDEX IF NOT EXISTS idx_media_requests_user_status ON media_requests(user_id, status, requested_at);
CREATE INDEX IF NOT EXISTS idx_media_requests_canonical ON media_requests(streamer_id, canonical_url, status);

-- ═══════════════════════════════════════════════════════════════
-- User Cosmetics — global unlocked items & active equipment
-- Items earned in OpenVibeGame, equipped globally (chat, overlay, etc.)
-- ═══════════════════════════════════════════════════════════════

-- Unlocked cosmetics (one row per cosmetic the user owns)
CREATE TABLE IF NOT EXISTS user_cosmetics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,                 -- references ITEMS key (fx_rainbow, px_sparkle, hat_crown, voice_robot etc.)
    category TEXT NOT NULL,                -- 'name_effect'|'particle'|'hat'|'voice'
    unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, item_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_cosmetics_user ON user_cosmetics(user_id);

-- Equipped cosmetics (one row per slot — at most one per category)
CREATE TABLE IF NOT EXISTS user_equipped (
    user_id INTEGER NOT NULL,
    slot TEXT NOT NULL,                    -- 'name_effect'|'particle'|'hat'|'voice'
    item_id TEXT NOT NULL,
    PRIMARY KEY (user_id, slot),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ═══════════════════════════════════════════════════════════════
-- Stream Analytics — viewer snapshots & per-stream summary
-- ═══════════════════════════════════════════════════════════════

-- Time-series viewer count snapshots (for charts)
CREATE TABLE IF NOT EXISTS viewer_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER NOT NULL,
    viewer_count INTEGER DEFAULT 0,
    chat_messages_5m INTEGER DEFAULT 0,     -- messages in trailing 5 min window
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_viewer_snapshots_stream ON viewer_snapshots(stream_id, recorded_at);

-- Cached per-stream analytics (computed on stream end or periodically)
CREATE TABLE IF NOT EXISTS stream_analytics (
    stream_id INTEGER PRIMARY KEY,
    avg_viewers REAL DEFAULT 0,
    peak_viewers INTEGER DEFAULT 0,
    unique_chatters INTEGER DEFAULT 0,
    total_messages INTEGER DEFAULT 0,
    total_watch_minutes INTEGER DEFAULT 0,
    new_followers INTEGER DEFAULT 0,
    clips_created INTEGER DEFAULT 0,
    coins_earned INTEGER DEFAULT 0,
    computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
);

-- User preferences (server-side sync for chat settings, etc.)
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER PRIMARY KEY,
    chat_settings TEXT DEFAULT '{}',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
