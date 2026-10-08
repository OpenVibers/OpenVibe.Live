-- phase: expand
-- OpenVibe.Live on PostgreSQL (plan T4, ADR-035). Generated once on 2026-10-08 from production's SQLite schema
-- (sqlite_master: every ALTER and lazily created table as it really is) plus the lazily created tables production had
-- not made yet (billing_actions, opencoin_admin_grants, subject_merges, tips_deliveries), converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint (0/1 flags stay
-- integers), identities keep their ids, and DATETIME stays SQLite's 'YYYY-MM-DD HH:MM:SS' text through the date
-- functions below. Never edited after it runs.
--
-- Not created here, so never imported:
--   frozen since C-73 (OpenVibe.Media and OpenVibe.Community own the data): vods, clips, pastes, paste_likes, paste_comments, comments;
--   named by no server code (retired features; their rows stay in the archived SQLite file): 48 tables
--     (game_world_state, game_inventory, game_bank, game_structures, game_farm_plots, game_recipes, game_effects, game_battle_stats, game_dungeon_runs, game_leaderboard, game_fish_collection, game_daily_quest_progress, game_daily_quest_claims, game_achievements, tag_guardian_defeats, canvas_settings, canvas_tiles, canvas_actions, canvas_snapshots, canvas_region_locks, canvas_bans, canvas_user_overrides, arena_battles, arena_votes, arena_talk_topics, arena_talk, arena_talk_hype, arena_talk_sessions, arena_talk_session_topics, arena_talk_session_hype, arena_topic_progress, arena_topic_members, arena_topic_hype, arena_topic_sides, arena_viewer_clout, arena_topic_moments, chatter_profiles, chatter_xp_log, chatter_subjects, arena_topic_threads, arena_achievements, arena_events, arena_tier_paid, promo_claims, idempotency_receipts, moderation_events_backfill, arena_topics, arena_beef_sides);
--   SQLite-only machinery: schema_migrations, event_outbox, chat_staged_outbox, chat_bridge_outbox (the ov_migrations ledger and the PostgreSQL outbox replace them);
--   owned by OpenVibe.Chat since T3 (Live keeps no copy): channel_moderators, channel_moderation_settings, user_tags, chat_ai_summaries, chat_timeline_events, chat_dual_read_stats.

-- SQLite's text timestamps and date functions (openvibe-sdk tools/asyncify SQLITE_DATE_FUNCTIONS).
CREATE FUNCTION ov_ts(t text) RETURNS timestamp LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF t IS NULL THEN RETURN NULL; END IF;
    IF t = 'now' THEN RETURN statement_timestamp() AT TIME ZONE 'UTC'; END IF;
    IF t ~ '\d\d:\d\d(:\d\d(\.\d+)?)?\s*(Z|[+-]\d\d(:?\d\d)?)$' THEN RETURN t::timestamptz AT TIME ZONE 'UTC'; END IF;
    RETURN t::timestamp;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;
CREATE FUNCTION ov_now() RETURNS text LANGUAGE sql STABLE AS $$ SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') $$;
CREATE FUNCTION ov_now_iso() RETURNS text LANGUAGE sql STABLE AS $$ SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
CREATE FUNCTION ov_now_iso(modifier text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT to_char((statement_timestamp() AT TIME ZONE 'UTC') + modifier::interval, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
CREATE FUNCTION datetime(t text, modifier text DEFAULT NULL) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE ts timestamp := ov_ts(t);
BEGIN
    IF ts IS NULL THEN RETURN NULL; END IF;
    IF modifier IS NOT NULL THEN ts := ts + modifier::interval; END IF;
    RETURN to_char(ts, 'YYYY-MM-DD HH24:MI:SS');
EXCEPTION WHEN others THEN RETURN NULL;
END $$;
CREATE FUNCTION julianday(t text) RETURNS double precision LANGUAGE sql STABLE AS $$ SELECT extract(epoch FROM ov_ts(t))::double precision / 86400.0 + 2440587.5 $$;

CREATE TABLE account_data_events (
    id text COLLATE "C" PRIMARY KEY,
    kind text COLLATE "C" NOT NULL,
    subject text COLLATE "C" NOT NULL,
    outcome text COLLATE "C",
    sent_at text COLLATE "C",
    applied_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username text COLLATE "C" UNIQUE NOT NULL,
    email text COLLATE "C" UNIQUE,
    password_hash text COLLATE "C" NOT NULL,
    display_name text COLLATE "C",
    avatar_url text COLLATE "C",
    bio text COLLATE "C" DEFAULT '',
    role text COLLATE "C" DEFAULT 'user' CHECK(role IN ('user', 'streamer', 'mod', 'admin')),
    stream_key text COLLATE "C" UNIQUE,
    openvibe_bucks_balance double precision DEFAULT 0.00,
    is_banned bigint DEFAULT 0,
    ban_reason text COLLATE "C",
    profile_color text COLLATE "C" DEFAULT '#c0965c',
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    last_seen text COLLATE "C" DEFAULT ov_now(),
    theme_id bigint,
    token_valid_after text COLLATE "C" DEFAULT NULL,
    max_managed_streams bigint DEFAULT 3,
    avatar_paste_id bigint DEFAULT NULL,
    is_owner bigint DEFAULT 0,
    openvibe_coins_balance bigint DEFAULT 0,
    openvibe_bucks_cashout_balance double precision DEFAULT 0.00,
    deleted_at text COLLATE "C"
);

CREATE TABLE ai_chatbot_configs (
    user_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    enabled bigint DEFAULT 0,
    base_url text COLLATE "C" DEFAULT 'https://api.openai.com/v1',
    api_token text COLLATE "C" DEFAULT '',
    model text COLLATE "C" DEFAULT 'gpt-4o-mini',
    transcribe_enabled bigint DEFAULT 0,
    transcribe_model text COLLATE "C" DEFAULT 'whisper-1',
    num_bots bigint DEFAULT 3,
    post_interval_seconds bigint DEFAULT 45,
    persona text COLLATE "C" DEFAULT '',
    last_validated_at text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    vision_enabled bigint DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE ai_timeline_cache (
    user_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    payload text COLLATE "C",
    generated_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE ai_usage (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text COLLATE "C",
    model text COLLATE "C",
    input_tokens bigint DEFAULT 0,
    output_tokens bigint DEFAULT 0,
    cost_usd double precision DEFAULT 0,
    created_at text COLLATE "C" DEFAULT ov_now(),
    owner_user_id bigint,
    source text COLLATE "C",
    cached_tokens bigint DEFAULT 0,
    role text COLLATE "C",
    provider text COLLATE "C",
    latency_ms bigint
);

CREATE TABLE ai_viewer_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_user_id bigint NOT NULL,
    stream_id bigint,
    event text COLLATE "C" NOT NULL,
    bot_username text COLLATE "C",
    target text COLLATE "C",
    thread_id bigint,
    chat_message_id bigint,
    text text COLLATE "C",
    reason text COLLATE "C",
    tokens_in bigint,
    tokens_cached bigint,
    tokens_out bigint,
    cost_usd double precision,
    model text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE ai_viewer_threads (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_user_id bigint NOT NULL,
    stream_id bigint,
    kind text COLLATE "C" NOT NULL,
    participants_json text COLLATE "C" NOT NULL,
    topic text COLLATE "C",
    state text COLLATE "C" DEFAULT 'open',
    awaiting text COLLATE "C",
    turns bigint DEFAULT 0,
    last_line text COLLATE "C",
    last_line_by text COLLATE "C",
    last_line_at text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE anon_ip_mappings (
    ip text COLLATE "C" PRIMARY KEY,
    anon_num bigint NOT NULL UNIQUE,
    created_at text COLLATE "C"
);

CREATE TABLE api_keys (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    key_hash text COLLATE "C" UNIQUE NOT NULL,
    label text COLLATE "C" DEFAULT 'Default',
    permissions text COLLATE "C" DEFAULT '["control","stream"]',
    last_used text COLLATE "C",
    is_active bigint DEFAULT 1,
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE api_tokens (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    token_hash text COLLATE "C" UNIQUE NOT NULL,
    label text COLLATE "C" DEFAULT 'Bot Token',
    scopes text COLLATE "C" DEFAULT '["chat","read"]',
    created_at text COLLATE "C" DEFAULT ov_now(),
    last_used_at text COLLATE "C",
    expires_at text COLLATE "C",
    is_active bigint DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE app_state (
    key text COLLATE "C" PRIMARY KEY,
    value text COLLATE "C",
    updated_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE channels (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL UNIQUE,
    title text COLLATE "C" DEFAULT 'Untitled Channel',
    description text COLLATE "C" DEFAULT '',
    category text COLLATE "C" DEFAULT 'irl',
    tags text COLLATE "C" DEFAULT '[]',
    protocol text COLLATE "C" DEFAULT 'webrtc' CHECK(protocol IN ('jsmpeg', 'webrtc', 'rtmp')),
    is_nsfw bigint DEFAULT 0,
    auto_record bigint DEFAULT 0,
    offline_banner_url text COLLATE "C",
    panels text COLLATE "C" DEFAULT '[]',
    emote_sources text COLLATE "C" DEFAULT '{"defaults":true,"custom":true,"ffz":true,"bttv":true,"7tv":true}',
    default_vod_visibility text COLLATE "C" DEFAULT 'public' CHECK(default_vod_visibility IN ('public', 'unlisted', 'private')),
    default_clip_visibility text COLLATE "C" DEFAULT 'public' CHECK(default_clip_visibility IN ('public', 'unlisted', 'private')),
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    weather_zip text COLLATE "C" DEFAULT NULL,
    weather_detail text COLLATE "C" DEFAULT 'basic',
    weather_show_location bigint DEFAULT 0,
    force_nsfw bigint DEFAULT 0,
    control_mode text COLLATE "C" DEFAULT 'open',
    anon_controls_enabled bigint DEFAULT 1,
    control_rate_limit_ms bigint DEFAULT 500,
    vod_recording_enabled bigint DEFAULT 1,
    force_vod_recording_disabled bigint DEFAULT 0,
    active_control_config_id bigint,
    video_click_enabled bigint DEFAULT 0,
    video_click_rate_limit_ms bigint DEFAULT 0,
    cp_name text COLLATE "C" DEFAULT 'Channel Points',
    cp_icon text COLLATE "C" DEFAULT 'fa-coins',
    cp_watch_interval_min bigint DEFAULT 5,
    cp_watch_amount bigint DEFAULT 10,
    cp_game_interval_min bigint DEFAULT 0,
    offline_screen_type text COLLATE "C" DEFAULT 'none',
    offline_screen_url text COLLATE "C",
    offline_html text COLLATE "C",
    offline_css text COLLATE "C",
    clips_allow_creator_delete bigint DEFAULT 0,
    hide_ai_overview bigint DEFAULT 0,
    ai_overview_pref text COLLATE "C" DEFAULT 'auto',
    ai_category text COLLATE "C",
    chat_language text COLLATE "C" DEFAULT 'auto',
    ai_derivation_enabled bigint DEFAULT 1,
    social_links text COLLATE "C",
    bot_robot_id text COLLATE "C",
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE approved_ips (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id bigint NOT NULL,
    ip_address text COLLATE "C" NOT NULL,
    approved_by bigint,
    source text COLLATE "C" DEFAULT 'auto',
    created_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE(channel_id, ip_address),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE arena_beef_hype (
    beef_id bigint NOT NULL,
    side text COLLATE "C" NOT NULL,
    voter_key text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (beef_id, voter_key)
);

CREATE TABLE arena_beefs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    a_user_id bigint NOT NULL,
    b_user_id bigint NOT NULL,
    status text COLLATE "C" NOT NULL DEFAULT 'open',
    score_a double precision DEFAULT 0,
    score_b double precision DEFAULT 0,
    hits_a bigint DEFAULT 0,
    hits_b bigint DEFAULT 0,
    crowd_a bigint DEFAULT 0,
    crowd_b bigint DEFAULT 0,
    on_clock text COLLATE "C",
    clock_until text COLLATE "C",
    responded bigint DEFAULT 0,
    last_a_at text COLLATE "C",
    last_b_at text COLLATE "C",
    feed_json text COLLATE "C",
    opener_line text COLLATE "C",
    winner_user_id bigint,
    resolution text COLLATE "C",
    opened_at text COLLATE "C" DEFAULT ov_now(),
    ends_at text COLLATE "C",
    resolved_at text COLLATE "C",
    headline text COLLATE "C",
    result_headline text COLLATE "C",
    upset bigint DEFAULT 0,
    rematch bigint DEFAULT 0,
    bounty_topic_id bigint
);

CREATE TABLE arena_mic_moments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    stream_id bigint,
    vod_id bigint,
    sec bigint,
    kind text COLLATE "C" NOT NULL DEFAULT 'trash',
    target_user_id bigint,
    beef_id bigint,
    aimed_at text COLLATE "C",
    text text COLLATE "C" NOT NULL,
    about text COLLATE "C",
    quality double precision DEFAULT 0,
    announcer text COLLATE "C",
    said_at text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE arena_profiles (
    user_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    stats_json text COLLATE "C",
    persona_json text COLLATE "C",
    persona_model text COLLATE "C",
    persona_generated_at text COLLATE "C",
    image_path text COLLATE "C",
    image_prompt text COLLATE "C",
    image_model text COLLATE "C",
    image_generated_at text COLLATE "C",
    image_error text COLLATE "C",
    updated_at text COLLATE "C" DEFAULT ov_now(),
    quotes_json text COLLATE "C",
    quotes_generated_at text COLLATE "C"
);

CREATE TABLE arena_trash_levels (
    user_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    xp bigint DEFAULT 0,
    level bigint DEFAULT 1,
    angles_cleared bigint DEFAULT 0,
    topics_conquered bigint DEFAULT 0,
    beef_hits bigint DEFAULT 0,
    best_line text COLLATE "C",
    best_line_vod_id bigint,
    best_line_sec bigint,
    best_line_score double precision DEFAULT 0,
    updated_at text COLLATE "C" DEFAULT ov_now(),
    topic_moments bigint DEFAULT 0,
    topics_joined bigint DEFAULT 0,
    mic_moments bigint DEFAULT 0
);

CREATE TABLE arena_xp_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    amount bigint NOT NULL,
    reason text COLLATE "C" NOT NULL,
    ref_id bigint,
    created_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE control_configs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    name text COLLATE "C" NOT NULL,
    description text COLLATE "C" DEFAULT '',
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE managed_streams (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    channel_id bigint,
    slug text COLLATE "C",
    title text COLLATE "C" DEFAULT 'Untitled Stream',
    description text COLLATE "C" DEFAULT '',
    category text COLLATE "C" DEFAULT 'irl',
    tags text COLLATE "C" DEFAULT '[]',
    protocol text COLLATE "C" DEFAULT 'webrtc' CHECK(protocol IN ('jsmpeg', 'webrtc', 'rtmp')),
    stream_key text COLLATE "C" UNIQUE NOT NULL,
    is_nsfw bigint DEFAULT 0,
    control_config_id bigint,
    sort_order bigint DEFAULT 0,
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    broadcast_settings text COLLATE "C" DEFAULT '{}',
    streaming_method text COLLATE "C" DEFAULT 'browser',
    browser_mode text COLLATE "C" DEFAULT 'camera',
    default_vod_visibility text COLLATE "C" DEFAULT 'public',
    default_clip_visibility text COLLATE "C" DEFAULT 'public',
    slot_vod_recording_enabled bigint DEFAULT 1,
    weather_zip text COLLATE "C" DEFAULT NULL,
    weather_detail text COLLATE "C" DEFAULT 'basic',
    weather_show_location bigint DEFAULT 0,
    mic_only_image text COLLATE "C" DEFAULT NULL,
    slot_clip_recording_enabled bigint DEFAULT 1,
    slot_clip_notify_enabled bigint DEFAULT 1,
    pip_source_msid bigint,
    pip_defaults text COLLATE "C" DEFAULT '{}',
    slot_powerchat_relay bigint DEFAULT 1,
    slot_powerchat_count_rs_views bigint DEFAULT 1,
    ingest_authority text COLLATE "C" NOT NULL DEFAULT 'live',
    openre_stream_id text COLLATE "C" DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL,
    FOREIGN KEY (control_config_id) REFERENCES control_configs(id) ON DELETE SET NULL
);

CREATE TABLE streams (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    channel_id bigint,
    title text COLLATE "C" DEFAULT 'Untitled Stream',
    description text COLLATE "C" DEFAULT '',
    category text COLLATE "C" DEFAULT 'irl',
    tags text COLLATE "C" DEFAULT '[]',
    protocol text COLLATE "C" DEFAULT 'webrtc' CHECK(protocol IN ('jsmpeg', 'webrtc', 'rtmp')),
    is_live bigint DEFAULT 0,
    is_nsfw bigint DEFAULT 0,
    viewer_count bigint DEFAULT 0,
    peak_viewers bigint DEFAULT 0,
    follower_count bigint DEFAULT 0,
    thumbnail_url text COLLATE "C",
    multi_cam bigint DEFAULT 0,
    started_at text COLLATE "C",
    ended_at text COLLATE "C",
    last_heartbeat text COLLATE "C",
    duration_seconds bigint DEFAULT 0,
    created_at text COLLATE "C" DEFAULT ov_now(),
    call_mode text COLLATE "C" DEFAULT NULL,
    control_config_id bigint,
    managed_stream_id bigint REFERENCES managed_streams(id) ON DELETE SET NULL,
    ai_overview text COLLATE "C",
    ai_overview_short text COLLATE "C",
    ai_title text COLLATE "C",
    ai_category text COLLATE "C",
    ai_tags text COLLATE "C",
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
);

CREATE TABLE bans (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stream_id bigint,
    user_id bigint,
    ip_address text COLLATE "C",
    anon_id text COLLATE "C",
    reason text COLLATE "C",
    banned_by bigint,
    expires_at text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (banned_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE billing_actions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    action text COLLATE "C" NOT NULL,
    idempotency_key text COLLATE "C" NOT NULL UNIQUE,
    live_user_id bigint,
    live_ref text COLLATE "C",
    method text COLLATE "C" NOT NULL,
    path text COLLATE "C" NOT NULL,
    request_json text COLLATE "C" NOT NULL,
    status text COLLATE "C" NOT NULL DEFAULT 'pending',
    http_status bigint,
    billing_ref text COLLATE "C",
    response_json text COLLATE "C",
    error text COLLATE "C",
    attempts bigint NOT NULL DEFAULT 0,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now(),
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);

CREATE TABLE camera_profiles (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    stream_id bigint,
    name text COLLATE "C" NOT NULL,
    onvif_url text COLLATE "C" NOT NULL,
    username text COLLATE "C" NOT NULL,
    password_hash text COLLATE "C" NOT NULL,
    pan_speed double precision DEFAULT 0.5,
    tilt_speed double precision DEFAULT 0.5,
    zoom_speed double precision DEFAULT 0.5,
    is_active bigint DEFAULT 1,
    last_connected text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
);

CREATE TABLE camera_presets (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    camera_id bigint NOT NULL,
    name text COLLATE "C" NOT NULL,
    pan double precision NOT NULL,
    tilt double precision NOT NULL,
    zoom double precision NOT NULL,
    preset_token text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (camera_id) REFERENCES camera_profiles(id) ON DELETE CASCADE
);

CREATE TABLE cameras (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stream_id bigint NOT NULL,
    camera_index bigint DEFAULT 0,
    label text COLLATE "C" DEFAULT 'Main',
    protocol text COLLATE "C" DEFAULT 'jsmpeg',
    jsmpeg_video_port bigint,
    jsmpeg_audio_port bigint,
    webrtc_room_id text COLLATE "C",
    is_active bigint DEFAULT 1,
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
);

CREATE TABLE channel_ai_bots (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_user_id bigint NOT NULL,
    username text COLLATE "C" NOT NULL,
    display_name text COLLATE "C",
    avatar_color text COLLATE "C" DEFAULT '#8a8aff',
    source text COLLATE "C" DEFAULT 'ambient',
    cloned_from_kind text COLLATE "C",
    cloned_from_ref text COLLATE "C",
    persona_json text COLLATE "C" DEFAULT '{}',
    brain_json text COLLATE "C" DEFAULT '{}',
    is_active bigint DEFAULT 1,
    msg_count bigint DEFAULT 0,
    last_active_at text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (channel_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE channel_ai_config (
    user_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    enabled bigint DEFAULT 0,
    num_ambient_bots bigint DEFAULT 3,
    pacing_seconds bigint DEFAULT 45,
    persona text COLLATE "C" DEFAULT '',
    transcribe_enabled bigint DEFAULT 0,
    vision_enabled bigint DEFAULT 0,
    use_shared_key bigint DEFAULT 1,
    daily_budget_cents bigint DEFAULT 20,
    byo_key text COLLATE "C" DEFAULT '',
    byo_base_url text COLLATE "C" DEFAULT '',
    byo_model text COLLATE "C" DEFAULT 'gpt-4o-mini',
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    settings_json text COLLATE "C" DEFAULT '{}',
    byo_in_ai bigint DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE channel_points (
    user_id bigint NOT NULL,
    streamer_id bigint NOT NULL,
    balance bigint NOT NULL DEFAULT 0,
    updated_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (user_id, streamer_id)
);

CREATE TABLE channel_points_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key text COLLATE "C" NOT NULL UNIQUE,
    user_id bigint NOT NULL,
    streamer_id bigint NOT NULL,
    delta bigint NOT NULL,
    reason text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE clip_ai_state (
    clip_id bigint,
    ai_overview_short text COLLATE "C",
    ai_transcript_json text COLLATE "C",
    transcript_status text COLLATE "C",
    transcript_attempts bigint DEFAULT 0,
    transcript_error text COLLATE "C",
    transcript_next_at text COLLATE "C",
    clip_notified bigint DEFAULT 0,
    clip_notify_at text COLLATE "C",
    ai_overview text COLLATE "C",
    transcript_partial_json text COLLATE "C",
    transcript_progress_sec bigint DEFAULT 0
);

CREATE TABLE coin_rewards (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    streamer_id bigint NOT NULL,
    title text COLLATE "C" NOT NULL,
    description text COLLATE "C" DEFAULT '',
    cost bigint NOT NULL DEFAULT 100,
    icon text COLLATE "C" DEFAULT 'fa-star',
    color text COLLATE "C" DEFAULT '#c0965c',
    cooldown_seconds bigint DEFAULT 0,
    max_per_stream bigint DEFAULT 0,
    requires_input bigint DEFAULT 0,
    is_enabled bigint DEFAULT 1,
    is_global bigint DEFAULT 0,
    redemption_count bigint DEFAULT 0,
    sort_order bigint DEFAULT 0,
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (streamer_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE coin_redemptions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reward_id bigint NOT NULL,
    user_id bigint NOT NULL,
    stream_id bigint,
    status text COLLATE "C" DEFAULT 'pending' CHECK(status IN ('pending', 'fulfilled', 'rejected', 'refunded')),
    user_input text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    resolved_at text COLLATE "C",
    FOREIGN KEY (reward_id) REFERENCES coin_rewards(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL
);

CREATE TABLE coin_transactions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    stream_id bigint,
    amount bigint NOT NULL,
    type text COLLATE "C" NOT NULL CHECK(type IN ('watch', 'chat_bonus', 'follow_bonus', 'redeem', 'admin_grant', 'refund')),
    reward_id bigint,
    message text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
    FOREIGN KEY (reward_id) REFERENCES coin_rewards(id) ON DELETE SET NULL
);

CREATE TABLE comment_thread_refs (
    content_type text COLLATE "C" NOT NULL,
    content_id bigint NOT NULL,
    thread_id bigint NOT NULL,
    access_id text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (content_type, content_id)
);

CREATE TABLE content_views (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    content_type text COLLATE "C" NOT NULL CHECK(content_type IN ('vod', 'clip')),
    content_id bigint NOT NULL,
    ip text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE(content_type, content_id, ip)
);

CREATE TABLE control_config_buttons (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    config_id bigint NOT NULL,
    label text COLLATE "C" NOT NULL,
    command text COLLATE "C" NOT NULL,
    icon text COLLATE "C" DEFAULT 'fa-gamepad',
    control_type text COLLATE "C" DEFAULT 'button' CHECK(control_type IN ('button','toggle','dpad','keyboard')),
    key_binding text COLLATE "C",
    cooldown_ms bigint DEFAULT 500,
    sort_order bigint DEFAULT 0,
    btn_color text COLLATE "C" DEFAULT '',
    btn_bg text COLLATE "C" DEFAULT '',
    btn_border_color text COLLATE "C" DEFAULT '',
    is_enabled bigint DEFAULT 1,
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (config_id) REFERENCES control_configs(id) ON DELETE CASCADE
);

CREATE TABLE control_whitelist (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id bigint NOT NULL,
    user_id bigint NOT NULL,
    added_by bigint,
    created_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE(channel_id, user_id),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE donation_goals (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    title text COLLATE "C" NOT NULL,
    target_amount bigint NOT NULL,
    current_amount bigint DEFAULT 0,
    is_active bigint DEFAULT 1,
    created_at text COLLATE "C" DEFAULT ov_now(),
    image_url text COLLATE "C",
    media_type text COLLATE "C",
    reached_at text COLLATE "C",
    sort_order bigint DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE easter_egg_solves (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    egg_date text COLLATE "C" NOT NULL,
    solver_key text COLLATE "C" NOT NULL,
    user_id bigint,
    created_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE(egg_date, solver_key)
);

CREATE TABLE follow_projection_revisions (
    follower_subject text COLLATE "C" NOT NULL,
    target_subject text COLLATE "C" NOT NULL,
    revision bigint NOT NULL,
    PRIMARY KEY (follower_subject, target_subject)
);

CREATE TABLE follows (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    follower_id bigint NOT NULL,
    streamer_id bigint NOT NULL,
    email_notify bigint DEFAULT 0,
    push_notify bigint DEFAULT 0,
    created_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE(follower_id, streamer_id),
    FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (streamer_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE game_players (
    user_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    display_name text COLLATE "C",
    x double precision DEFAULT 4096,
    y double precision DEFAULT 4096,
    mining_xp bigint DEFAULT 0,
    fishing_xp bigint DEFAULT 0,
    woodcut_xp bigint DEFAULT 0,
    farming_xp bigint DEFAULT 0,
    combat_xp bigint DEFAULT 0,
    crafting_xp bigint DEFAULT 0,
    agility_xp bigint DEFAULT 0,
    hp bigint DEFAULT 100,
    max_hp bigint DEFAULT 100,
    attack bigint DEFAULT 10,
    defense bigint DEFAULT 5,
    stamina bigint DEFAULT 100,
    max_stamina bigint DEFAULT 100,
    last_stamina_tick text COLLATE "C" DEFAULT ov_now(),
    equip_pickaxe text COLLATE "C" DEFAULT NULL,
    equip_rod text COLLATE "C" DEFAULT NULL,
    equip_axe text COLLATE "C" DEFAULT NULL,
    equip_hat text COLLATE "C",
    equip_weapon text COLLATE "C",
    equip_armor text COLLATE "C",
    sleeping_bag_x double precision,
    sleeping_bag_y double precision,
    sprite_skin bigint DEFAULT 0,
    name_effect text COLLATE "C",
    particle_effect text COLLATE "C",
    chat_color text COLLATE "C" DEFAULT '#e8e6e3',
    total_coins_earned bigint DEFAULT 0,
    total_items_crafted bigint DEFAULT 0,
    total_monsters_killed bigint DEFAULT 0,
    total_deaths bigint DEFAULT 0,
    battle_wins bigint DEFAULT 0,
    battle_losses bigint DEFAULT 0,
    structures_built bigint DEFAULT 0,
    resources_gathered bigint DEFAULT 0,
    created_at text COLLATE "C" DEFAULT ov_now(),
    last_action text COLLATE "C" DEFAULT ov_now(),
    smithing_xp bigint DEFAULT 0,
    total_chests_opened bigint DEFAULT 0,
    total_tiles_traveled double precision DEFAULT 0,
    total_dungeon_wins bigint DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE ip_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint,
    anon_id text COLLATE "C",
    ip_address text COLLATE "C" NOT NULL,
    action text COLLATE "C" NOT NULL DEFAULT 'chat',
    geo_country text COLLATE "C",
    geo_region text COLLATE "C",
    geo_city text COLLATE "C",
    geo_isp text COLLATE "C",
    geo_org text COLLATE "C",
    geo_ll text COLLATE "C",
    user_agent text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE kick_channel_cache (
    slug text COLLATE "C" PRIMARY KEY,
    chatroom_id bigint,
    kick_channel_id bigint,
    updated_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE lineage_unresolved (
    ref text COLLATE "C" NOT NULL,
    reason text COLLATE "C" NOT NULL,
    detail text COLLATE "C",
    last_caller text COLLATE "C",
    count bigint NOT NULL DEFAULT 1,
    first_at text COLLATE "C" NOT NULL,
    last_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (ref, reason)
);

CREATE TABLE linked_accounts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    service text COLLATE "C" NOT NULL,
    service_user_id text COLLATE "C" NOT NULL,
    service_username text COLLATE "C",
    linked_at text COLLATE "C" DEFAULT ov_now(),
    subject_id text COLLATE "C",
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(service, service_user_id)
);

CREATE TABLE media_request_settings (
    user_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    enabled bigint DEFAULT 1,
    request_cost bigint DEFAULT 25,
    max_per_user bigint DEFAULT 3,
    max_duration_seconds bigint DEFAULT 600,
    allow_youtube bigint DEFAULT 1,
    allow_vimeo bigint DEFAULT 1,
    allow_direct_media bigint DEFAULT 1,
    auto_advance bigint DEFAULT 1,
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    cost_mode text COLLATE "C" DEFAULT 'flat' CHECK(cost_mode IN ('flat','per_minute')),
    cost_per_minute bigint DEFAULT 5,
    allow_live bigint DEFAULT 0,
    download_mode text COLLATE "C" DEFAULT 'stream' CHECK(download_mode IN ('stream','download')),
    currency text COLLATE "C" DEFAULT 'opencoins' CHECK(currency IN ('free','vibes','opencoins','points')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE media_requests (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    streamer_id bigint NOT NULL,
    stream_id bigint,
    user_id bigint NOT NULL,
    username text COLLATE "C" NOT NULL,
    input text COLLATE "C" NOT NULL,
    canonical_url text COLLATE "C" NOT NULL,
    embed_url text COLLATE "C",
    provider text COLLATE "C" NOT NULL CHECK(provider IN ('youtube', 'vimeo', 'audio', 'video')),
    title text COLLATE "C" NOT NULL,
    thumbnail_url text COLLATE "C",
    duration_seconds bigint,
    cost bigint NOT NULL DEFAULT 25,
    queue_position bigint DEFAULT 0,
    status text COLLATE "C" DEFAULT 'pending' CHECK(status IN ('pending', 'playing', 'played', 'skipped', 'removed', 'failed')),
    requested_at text COLLATE "C" DEFAULT ov_now(),
    started_at text COLLATE "C",
    ended_at text COLLATE "C",
    last_error text COLLATE "C",
    stream_url text COLLATE "C",
    download_status text COLLATE "C" DEFAULT 'none' CHECK(download_status IN ('none','extracting','downloading','ready','failed')),
    file_path text COLLATE "C",
    playback_position double precision DEFAULT 0,
    refunded bigint DEFAULT 0,
    currency text COLLATE "C" DEFAULT 'opencoins',
    charge_state text COLLATE "C",
    FOREIGN KEY (streamer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE module_summary_pushes (
    user_id bigint NOT NULL,
    namespace text COLLATE "C" NOT NULL,
    hash text COLLATE "C" NOT NULL,
    pushed_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (user_id, namespace)
);

CREATE TABLE news_settings (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope text COLLATE "C" NOT NULL DEFAULT 'global',
    scope_id bigint,
    source_id text COLLATE "C" NOT NULL,
    enabled bigint NOT NULL DEFAULT 0,
    config text COLLATE "C" DEFAULT '{}',
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE(scope, scope_id, source_id)
);

CREATE TABLE opencoin_admin_grants (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_key text COLLATE "C" UNIQUE,
    admin_id bigint,
    user_id bigint NOT NULL,
    amount bigint NOT NULL,
    reason text COLLATE "C",
    balance bigint,
    created_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE openre_sessions (
    session_id text COLLATE "C" PRIMARY KEY,
    managed_stream_id bigint,
    stream_id bigint,
    state text COLLATE "C" NOT NULL,
    revision bigint NOT NULL DEFAULT 0,
    started_at text COLLATE "C",
    ended_at text COLLATE "C",
    confirmed_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE payment_orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    provider text COLLATE "C" NOT NULL,
    provider_ref text COLLATE "C",
    kind text COLLATE "C" NOT NULL DEFAULT 'bucks',
    amount_cents bigint NOT NULL DEFAULT 0,
    currency text COLLATE "C" DEFAULT 'usd',
    bucks bigint DEFAULT 0,
    streamer_id bigint,
    status text COLLATE "C" DEFAULT 'pending',
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE platform_connections (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    platform text COLLATE "C" NOT NULL CHECK(platform IN ('youtube', 'twitch', 'kick')),
    platform_user_id text COLLATE "C",
    platform_username text COLLATE "C",
    channel_url text COLLATE "C",
    access_token text COLLATE "C",
    refresh_token text COLLATE "C",
    token_expires_at bigint,
    scope text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE(user_id, platform),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE powerchat_connections (
    user_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    powerchat_username text COLLATE "C",
    powerchat_user_id text COLLATE "C",
    access_token text COLLATE "C",
    refresh_token text COLLATE "C",
    token_expires_at bigint,
    scope text COLLATE "C",
    tip_page_url text COLLATE "C",
    last_error text COLLATE "C",
    connected_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE powerchat_webhook_deliveries (
    delivery_id text COLLATE "C" PRIMARY KEY,
    event_type text COLLATE "C",
    received_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE restream_destinations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    platform text COLLATE "C" NOT NULL CHECK(platform IN ('youtube', 'twitch', 'kick', 'custom')),
    name text COLLATE "C",
    server_url text COLLATE "C",
    stream_key text COLLATE "C",
    enabled bigint DEFAULT 1,
    auto_start bigint DEFAULT 0,
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    quality_preset text COLLATE "C" DEFAULT 'auto',
    custom_video_bitrate bigint DEFAULT NULL,
    custom_audio_bitrate bigint DEFAULT NULL,
    custom_fps bigint DEFAULT NULL,
    custom_encoder_preset text COLLATE "C" DEFAULT NULL,
    channel_url text COLLATE "C" DEFAULT NULL,
    chat_relay bigint DEFAULT 0,
    managed_stream_id bigint REFERENCES managed_streams(id) ON DELETE SET NULL,
    connection_id bigint DEFAULT NULL REFERENCES platform_connections(id) ON DELETE SET NULL,
    consecutive_failures bigint DEFAULT 0,
    cooldown_until text COLLATE "C" DEFAULT NULL,
    last_error text COLLATE "C" DEFAULT NULL,
    last_failed_at text COLLATE "C" DEFAULT NULL,
    powerchat_relay bigint DEFAULT 1,
    powerchat_count_views bigint DEFAULT 1,
    srt_latency_ms bigint DEFAULT NULL,
    srt_passphrase text COLLATE "C" DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE robotstreamer_integrations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    managed_stream_id bigint,
    enabled bigint DEFAULT 0,
    mirror_chat bigint DEFAULT 1,
    token text COLLATE "C",
    robot_id text COLLATE "C",
    owner_id text COLLATE "C",
    chat_url text COLLATE "C",
    control_url text COLLATE "C",
    rtc_sfu_url text COLLATE "C",
    stream_name text COLLATE "C",
    owner_name text COLLATE "C",
    last_validated_at text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (managed_stream_id) REFERENCES managed_streams(id) ON DELETE CASCADE
);

CREATE TABLE search_doc_pushes (
    user_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    hash text COLLATE "C" NOT NULL,
    revision bigint NOT NULL,
    deleted bigint NOT NULL DEFAULT 0,
    pushed_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE search_media_pushes (
    kind text COLLATE "C" NOT NULL,
    media_id bigint NOT NULL,
    hash text COLLATE "C" NOT NULL,
    revision bigint NOT NULL,
    deleted bigint NOT NULL DEFAULT 0,
    pushed_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (kind, media_id)
);

CREATE TABLE site_settings (
    key text COLLATE "C" PRIMARY KEY,
    value text COLLATE "C" NOT NULL DEFAULT '',
    description text COLLATE "C" DEFAULT '',
    type text COLLATE "C" DEFAULT 'string' CHECK(type IN ('string', 'number', 'boolean', 'json')),
    updated_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE stream_analytics (
    stream_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    avg_viewers double precision DEFAULT 0,
    peak_viewers bigint DEFAULT 0,
    unique_chatters bigint DEFAULT 0,
    total_messages bigint DEFAULT 0,
    total_watch_minutes bigint DEFAULT 0,
    new_followers bigint DEFAULT 0,
    clips_created bigint DEFAULT 0,
    coins_earned bigint DEFAULT 0,
    computed_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
);

CREATE TABLE stream_controls (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stream_id bigint NOT NULL,
    label text COLLATE "C" NOT NULL,
    command text COLLATE "C" NOT NULL,
    icon text COLLATE "C" DEFAULT 'fa-gamepad',
    control_type text COLLATE "C" DEFAULT 'button' CHECK(control_type IN ('button', 'toggle', 'slider', 'dpad', 'onvif', 'keyboard')),
    key_binding text COLLATE "C",
    cooldown_ms bigint DEFAULT 500,
    is_enabled bigint DEFAULT 1,
    sort_order bigint DEFAULT 0,
    camera_id bigint,
    onvif_movement text COLLATE "C",
    btn_color text COLLATE "C" DEFAULT '',
    btn_bg text COLLATE "C" DEFAULT '',
    btn_border_color text COLLATE "C" DEFAULT '',
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE,
    FOREIGN KEY (camera_id) REFERENCES camera_profiles(id) ON DELETE SET NULL
);

CREATE TABLE stream_memories (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stream_id bigint NOT NULL,
    user_id bigint,
    offset_seconds bigint DEFAULT 0,
    captured_at text COLLATE "C" DEFAULT ov_now(),
    description text COLLATE "C",
    tags text COLLATE "C",
    thumbnail_url text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    transcript_json text COLLATE "C",
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
);

CREATE TABLE stream_recaps (
    stream_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id bigint,
    json text COLLATE "C" NOT NULL,
    ai bigint DEFAULT 0,
    announced_at text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE stream_timeline_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stream_id bigint NOT NULL,
    user_id bigint,
    vod_id bigint,
    kind text COLLATE "C" NOT NULL,
    start_sec double precision NOT NULL,
    end_sec double precision,
    text text COLLATE "C",
    label text COLLATE "C",
    confidence double precision,
    created_at text COLLATE "C" DEFAULT ov_now(),
    lang text COLLATE "C",
    text_en text COLLATE "C",
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
);

CREATE TABLE streamer_overviews (
    user_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    overview text COLLATE "C",
    model text COLLATE "C",
    sources text COLLATE "C",
    generated_at text COLLATE "C" DEFAULT ov_now(),
    overview_short text COLLATE "C",
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE subject_merges (
    merge_id text COLLATE "C" PRIMARY KEY,
    from_subject text COLLATE "C" NOT NULL,
    into_subject text COLLATE "C" NOT NULL,
    from_user_id bigint,
    into_user_id bigint,
    outcome text COLLATE "C" NOT NULL,
    applied_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE subject_projection (
    subject_id text COLLATE "C" PRIMARY KEY,
    network_user_id bigint,
    revision bigint NOT NULL,
    username text COLLATE "C" NOT NULL,
    display_name text COLLATE "C",
    avatar_url text COLLATE "C",
    profile_color text COLLATE "C",
    role text COLLATE "C" NOT NULL,
    banned bigint NOT NULL DEFAULT 0,
    updated_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE subscriptions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subscriber_id bigint NOT NULL,
    streamer_id bigint NOT NULL,
    tier bigint DEFAULT 1 CHECK(tier IN (1, 2, 3)),
    is_active bigint DEFAULT 1,
    started_at text COLLATE "C" DEFAULT ov_now(),
    expires_at text COLLATE "C",
    provider text COLLATE "C" DEFAULT NULL,
    provider_ref text COLLATE "C" DEFAULT NULL,
    price_cents bigint DEFAULT 0,
    currency text COLLATE "C" DEFAULT 'usd',
    status text COLLATE "C" DEFAULT 'active',
    cancel_at_period_end bigint DEFAULT 0,
    current_period_end text COLLATE "C" DEFAULT NULL,
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    auto_renew bigint DEFAULT 0,
    FOREIGN KEY (subscriber_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (streamer_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE themes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text COLLATE "C" NOT NULL,
    slug text COLLATE "C" UNIQUE NOT NULL,
    author_id bigint,
    description text COLLATE "C" DEFAULT '',
    mode text COLLATE "C" DEFAULT 'dark' CHECK(mode IN ('dark', 'light')),
    variables text COLLATE "C" NOT NULL DEFAULT '{}',
    preview_colors text COLLATE "C" DEFAULT '{}',
    is_builtin bigint DEFAULT 0,
    is_public bigint DEFAULT 1,
    downloads bigint DEFAULT 0,
    rating_sum bigint DEFAULT 0,
    rating_count bigint DEFAULT 0,
    tags text COLLATE "C" DEFAULT '[]',
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE tips_deliveries (
    idempotency_key text COLLATE "C" PRIMARY KEY,
    effect text COLLATE "C",
    state text COLLATE "C" NOT NULL DEFAULT 'pending',
    response_json text COLLATE "C",
    claimed_at bigint NOT NULL,
    created_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE token_revocations (
    subject_id text COLLATE "C" PRIMARY KEY,
    valid_after_ms bigint NOT NULL,
    reason text COLLATE "C",
    updated_at bigint NOT NULL
);

CREATE TABLE transactions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    from_user_id bigint,
    to_user_id bigint,
    stream_id bigint,
    amount bigint NOT NULL,
    type text COLLATE "C" NOT NULL CHECK(type IN ('donation', 'purchase', 'subscription', 'cashout', 'refund', 'bonus')),
    status text COLLATE "C" DEFAULT 'completed' CHECK(status IN ('pending', 'completed', 'failed', 'escrow', 'refunded')),
    message text COLLATE "C",
    paypal_transaction_id text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL
);

CREATE TABLE translations (
    key text COLLATE "C" PRIMARY KEY,
    src text COLLATE "C",
    dst text COLLATE "C",
    text text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE user_cosmetics (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    item_id text COLLATE "C" NOT NULL,
    category text COLLATE "C" NOT NULL,
    unlocked_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE(user_id, item_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE user_equipped (
    user_id bigint NOT NULL,
    slot text COLLATE "C" NOT NULL,
    item_id text COLLATE "C" NOT NULL,
    PRIMARY KEY (user_id, slot),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE user_equipped_tag (
    user_id bigint NOT NULL PRIMARY KEY,
    tag_id text COLLATE "C" NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE user_preferences (
    user_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    chat_settings text COLLATE "C" DEFAULT '{}',
    updated_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE user_themes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    theme_id bigint,
    custom_variables text COLLATE "C" DEFAULT '{}',
    is_custom bigint DEFAULT 0,
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE SET NULL
);

CREATE TABLE username_history (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    old_username text COLLATE "C" NOT NULL,
    new_username text COLLATE "C" NOT NULL,
    changed_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE verification_keys (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key text COLLATE "C" UNIQUE NOT NULL,
    target_username text COLLATE "C" NOT NULL,
    note text COLLATE "C" DEFAULT '',
    created_by bigint NOT NULL,
    used_by bigint,
    status text COLLATE "C" DEFAULT 'active' CHECK(status IN ('active', 'used', 'revoked')),
    created_at text COLLATE "C" DEFAULT ov_now(),
    used_at text COLLATE "C",
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE vibe_coding_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    managed_stream_id bigint NOT NULL,
    user_id bigint NOT NULL,
    stream_id bigint,
    session_key text COLLATE "C",
    event_id text COLLATE "C" NOT NULL,
    sequence_num bigint DEFAULT 0,
    event_type text COLLATE "C" NOT NULL,
    visibility text COLLATE "C" DEFAULT 'public' CHECK(visibility IN ('public', 'streamer')),
    depth text COLLATE "C" DEFAULT 'standard',
    summary text COLLATE "C" DEFAULT '',
    payload_json text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (managed_stream_id) REFERENCES managed_streams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
    UNIQUE (managed_stream_id, event_id)
);

CREATE TABLE vibe_coding_sessions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    managed_stream_id bigint NOT NULL,
    user_id bigint NOT NULL,
    session_key text COLLATE "C" NOT NULL,
    slot_slug text COLLATE "C",
    workspace_name text COLLATE "C",
    machine_name text COLLATE "C",
    extension_version text COLLATE "C",
    publisher_id text COLLATE "C",
    publisher_label text COLLATE "C",
    publisher_vendor text COLLATE "C",
    publisher_client_type text COLLATE "C",
    publisher_client_name text COLLATE "C",
    publisher_client_version text COLLATE "C",
    publisher_capabilities_json text COLLATE "C",
    publisher_depth text COLLATE "C" DEFAULT 'standard',
    status text COLLATE "C" DEFAULT 'active' CHECK(status IN ('active', 'ended')),
    created_at text COLLATE "C" DEFAULT ov_now(),
    last_event_at text COLLATE "C" DEFAULT ov_now(),
    ended_at text COLLATE "C",
    FOREIGN KEY (managed_stream_id) REFERENCES managed_streams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (managed_stream_id, session_key)
);

CREATE TABLE viewer_samples (
    sampled_at text COLLATE "C" DEFAULT ov_now(),
    viewers bigint NOT NULL DEFAULT 0,
    live_streams bigint NOT NULL DEFAULT 0
);

CREATE TABLE viewer_snapshots (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stream_id bigint NOT NULL,
    viewer_count bigint DEFAULT 0,
    chat_messages_5m bigint DEFAULT 0,
    recorded_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
);

CREATE TABLE vod_ai_state (
    vod_id bigint,
    ai_overview_short text COLLATE "C",
    ai_transcript_json text COLLATE "C",
    transcript_status text COLLATE "C",
    transcript_attempts bigint DEFAULT 0,
    transcript_error text COLLATE "C",
    transcript_next_at text COLLATE "C",
    ai_overview text COLLATE "C",
    transcript_partial_json text COLLATE "C",
    transcript_progress_sec bigint DEFAULT 0
);

CREATE TABLE vpn_approvals (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ip_address text COLLATE "C" NOT NULL,
    user_id bigint,
    status text COLLATE "C" DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied')),
    reviewed_by bigint,
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE watch_time (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    stream_id bigint NOT NULL,
    minutes_watched bigint DEFAULT 0,
    last_heartbeat text COLLATE "C" DEFAULT ov_now(),
    coins_earned bigint DEFAULT 0,
    created_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE(user_id, stream_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL
);

CREATE INDEX idx_ai_usage_created ON ai_usage(created_at);
CREATE INDEX idx_ai_usage_owner_day ON ai_usage(owner_user_id, created_at);
CREATE INDEX idx_ai_usage_source_day ON ai_usage(source, created_at);
CREATE INDEX idx_ai_viewer_log_created ON ai_viewer_log(created_at);
CREATE INDEX idx_aiv_log_channel ON ai_viewer_log(channel_user_id, id);
CREATE INDEX idx_aiv_threads_open ON ai_viewer_threads(channel_user_id, state, updated_at);
CREATE INDEX idx_anon_ip_created ON anon_ip_mappings(created_at);
CREATE INDEX idx_approved_ips_channel ON approved_ips(channel_id);
CREATE INDEX idx_approved_ips_ip ON approved_ips(ip_address);
CREATE INDEX idx_arena_beefs_status ON arena_beefs (status, a_user_id, b_user_id);
CREATE INDEX idx_arena_mic_created ON arena_mic_moments (created_at);
CREATE INDEX idx_arena_mic_user ON arena_mic_moments (user_id, id);
CREATE INDEX idx_arena_moments_said ON arena_mic_moments(said_at);
CREATE INDEX idx_arena_xp_log_user ON arena_xp_log (user_id, created_at);
CREATE INDEX idx_bans_ip ON bans(ip_address);
CREATE INDEX idx_bans_stream_id ON bans(stream_id);
CREATE INDEX idx_bans_user ON bans(user_id);
CREATE INDEX idx_billing_actions_ref ON billing_actions(action, live_ref);
CREATE INDEX idx_billing_actions_status ON billing_actions(status, created_at);
CREATE INDEX idx_cameras_stream_id ON cameras(stream_id);
CREATE INDEX idx_channel_ai_bots_channel ON channel_ai_bots(channel_user_id, is_active);
CREATE UNIQUE INDEX idx_channel_ai_bots_uname ON channel_ai_bots(channel_user_id, username);
CREATE INDEX idx_cp_log_user ON channel_points_log(user_id, streamer_id, id);
CREATE INDEX idx_channels_user_id ON channels(user_id);
CREATE UNIQUE INDEX idx_clip_ai_state_clip_id_unique ON clip_ai_state(clip_id);
CREATE INDEX idx_coin_redemptions_stream ON coin_redemptions(stream_id);
CREATE INDEX idx_coin_redemptions_user ON coin_redemptions(user_id);
CREATE INDEX idx_coin_rewards_streamer ON coin_rewards(streamer_id);
CREATE INDEX idx_coin_tx_created ON coin_transactions(created_at);
CREATE INDEX idx_coin_tx_stream ON coin_transactions(stream_id);
CREATE INDEX idx_coin_tx_user ON coin_transactions(user_id);
CREATE INDEX idx_content_views_lookup ON content_views(content_type, content_id);
CREATE INDEX idx_config_buttons_config ON control_config_buttons(config_id);
CREATE INDEX idx_control_configs_user ON control_configs(user_id);
CREATE INDEX idx_control_whitelist_channel ON control_whitelist(channel_id);
CREATE INDEX idx_goals_active ON donation_goals(is_active);
CREATE INDEX idx_egg_solves_date ON easter_egg_solves(egg_date);
CREATE INDEX idx_follows_follower ON follows(follower_id);
CREATE INDEX idx_follows_streamer ON follows(streamer_id);
CREATE INDEX idx_ip_log_action ON ip_log(action);
CREATE INDEX idx_ip_log_created ON ip_log(created_at);
CREATE INDEX idx_ip_log_ip ON ip_log(ip_address);
CREATE INDEX idx_ip_log_user ON ip_log(user_id);
CREATE INDEX idx_lineage_unresolved_last ON lineage_unresolved(last_at DESC);
CREATE INDEX idx_linked_service ON linked_accounts(service, service_user_id);
CREATE INDEX idx_linked_subject ON linked_accounts(subject_id);
CREATE INDEX idx_linked_user ON linked_accounts(user_id);
CREATE INDEX idx_managed_streams_key ON managed_streams(stream_key);
CREATE INDEX idx_managed_streams_slug ON managed_streams(slug);
CREATE INDEX idx_managed_streams_user ON managed_streams(user_id);
CREATE INDEX idx_media_requests_canonical ON media_requests(streamer_id, canonical_url, status);
CREATE INDEX idx_media_requests_streamer_status ON media_requests(streamer_id, status, queue_position, requested_at);
CREATE INDEX idx_media_requests_user_status ON media_requests(user_id, status, requested_at);
CREATE INDEX idx_openre_sessions_state ON openre_sessions(state);
CREATE INDEX idx_openre_sessions_stream ON openre_sessions(stream_id);
CREATE INDEX idx_payment_orders_ref ON payment_orders(provider, provider_ref);
CREATE INDEX idx_payment_orders_user ON payment_orders(user_id);
CREATE INDEX idx_powerchat_conn_pcuid ON powerchat_connections(powerchat_user_id);
CREATE INDEX idx_powerchat_conn_username ON powerchat_connections(powerchat_username);
CREATE INDEX idx_restream_dest_managed ON restream_destinations(managed_stream_id);
CREATE INDEX idx_restream_dest_user ON restream_destinations(user_id);
CREATE UNIQUE INDEX idx_rs_integrations_user_slot ON robotstreamer_integrations(user_id, COALESCE(managed_stream_id, 0));
CREATE UNIQUE INDEX idx_stream_memories_moment_unique ON stream_memories(stream_id, offset_seconds);
CREATE INDEX idx_stream_memories_stream ON stream_memories(stream_id, offset_seconds);
CREATE INDEX idx_stream_recaps_user ON stream_recaps(user_id, created_at);
CREATE INDEX idx_timeline_kind ON stream_timeline_events(stream_id, kind, start_sec);
CREATE INDEX idx_timeline_null_vod ON stream_timeline_events(stream_id) WHERE vod_id IS NULL;
CREATE INDEX idx_timeline_stream ON stream_timeline_events(stream_id, start_sec);
CREATE INDEX idx_timeline_user_kind_created ON stream_timeline_events(user_id, kind, created_at);
CREATE INDEX idx_timeline_vod ON stream_timeline_events(vod_id, start_sec);
CREATE INDEX idx_streams_channel_id ON streams(channel_id);
CREATE INDEX idx_streams_created ON streams(created_at);
CREATE INDEX idx_streams_is_live ON streams(is_live);
CREATE INDEX idx_streams_live_ended ON streams(is_live, ended_at);
CREATE INDEX idx_streams_managed ON streams(managed_stream_id);
CREATE INDEX idx_streams_managed_ended ON streams(managed_stream_id, ended_at);
CREATE INDEX idx_streams_started ON streams(started_at);
CREATE INDEX idx_streams_user_id ON streams(user_id);
CREATE INDEX idx_subject_projection_network ON subject_projection(network_user_id);
CREATE INDEX idx_subs_provider_ref ON subscriptions(provider, provider_ref);
CREATE INDEX idx_subs_streamer ON subscriptions(streamer_id, status);
CREATE INDEX idx_subs_subscriber ON subscriptions(subscriber_id, status);
CREATE INDEX idx_themes_author ON themes(author_id);
CREATE INDEX idx_themes_public ON themes(is_public);
CREATE INDEX idx_themes_slug ON themes(slug);
CREATE INDEX idx_tips_deliveries_created ON tips_deliveries(created_at);
CREATE INDEX idx_transactions_to_user ON transactions(to_user_id);
CREATE INDEX idx_tx_type_created ON transactions(type, created_at);
CREATE INDEX idx_user_cosmetics_user ON user_cosmetics(user_id);
CREATE INDEX idx_user_themes_user ON user_themes(user_id);
CREATE INDEX idx_username_history_old ON username_history(lower(old_username));
CREATE INDEX idx_users_created ON users(created_at);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_username_nocase ON users(lower(username));
CREATE INDEX idx_vkeys_key ON verification_keys(key);
CREATE INDEX idx_vkeys_status ON verification_keys(status);
CREATE INDEX idx_vkeys_target ON verification_keys(target_username);
CREATE INDEX idx_vibe_events_managed ON vibe_coding_events(managed_stream_id, id DESC);
CREATE INDEX idx_vibe_events_stream ON vibe_coding_events(stream_id);
CREATE INDEX idx_vibe_sessions_managed ON vibe_coding_sessions(managed_stream_id);
CREATE INDEX idx_vibe_sessions_user ON vibe_coding_sessions(user_id);
CREATE INDEX idx_viewer_samples_at ON viewer_samples(sampled_at);
CREATE INDEX idx_viewer_snapshots_stream ON viewer_snapshots(stream_id, recorded_at);
CREATE UNIQUE INDEX idx_vod_ai_state_vod_id_unique ON vod_ai_state(vod_id);
CREATE INDEX idx_watch_time_stream ON watch_time(stream_id);
CREATE INDEX idx_watch_time_user ON watch_time(user_id);

-- openvibe-sdk/events: the PostgreSQL outbox (stream events) and inbox (OpenRe mirror, Media outcomes).
CREATE TABLE event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;
CREATE TABLE event_inbox (
    consumer     text NOT NULL,
    event_id     text NOT NULL,
    processed_at bigint NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

-- The site settings a new database starts with (initDb's defaults on SQLite).
INSERT INTO site_settings (key, value, description, type) VALUES
    ('ai_enabled', 'false', 'Master switch: enable AI analysis (pastes + stream memories)', 'boolean'),
    ('ai_max_cost_usd_per_day', '0', 'Daily AI spend cap in USD (0 = no cap)', 'number'),
    ('ai_paste_analysis_enabled', 'true', 'Analyze image + text pastes (when AI is enabled)', 'boolean'),
    ('ai_stream_capture_interval_sec', '120', 'Seconds between live-stream AI memory captures', 'number'),
    ('ai_stream_memory_enabled', 'false', 'Periodically analyze live-stream thumbnails into timestamped memories', 'boolean'),
    ('ai_timeline_enabled', 'false', 'CONTINUOUS audio timeline — transcribes the WHOLE live stream (not a 12s sample every 2min) and detects non-speech sounds, into a searchable timestamped timeline. FREE/local, but uses noticeably more CPU than sampling', 'boolean'),
    ('ai_transcription_enabled', 'true', 'Transcribe live-stream/clip/VOD audio into memories — FREE, runs locally via whisper.cpp (no API/cost). Requires whisper.cpp installed on the server', 'boolean'),
    ('ai_viewers_default_settings_json', '{}', 'Admin defaults for per-channel AI viewer settings (overrides built-in defaults)', 'json'),
    ('ai_viewers_enabled', 'true', 'Kill switch for the AI chat viewers feature (all channels)', 'boolean'),
    ('ai_viewers_global_cap_usd_per_day', '0', 'Daily USD cap for ALL AI-viewer spend on the site’s AI, not streamers’ own keys (0 = none)', 'number'),
    ('ai_viewers_max_lines_per_min', '12', 'Hard ceiling on bot lines per minute per channel', 'number'),
    ('ai_viewers_max_roster', '12', 'Max AI viewers per channel', 'number'),
    ('bucks_min_purchase_bucks', '100', 'Minimum Vibes purchase (bucks)', 'number'),
    ('bucks_per_usd', '100', 'Vibes value per 1 USD (100 Bucks = $1.00 cashout). Purchase price adds a margin, see the buy tiers.', 'number'),
    ('ccbill_client_account', '', 'CCBill client account number', 'string'),
    ('ccbill_enabled', 'false', 'Enable CCBill', 'boolean'),
    ('ccbill_flexform_id', '', 'CCBill FlexForms form ID', 'string'),
    ('ccbill_salt', '', 'CCBill FlexForms encryption/salt key', 'string'),
    ('ccbill_subaccount', '', 'CCBill subaccount', 'string'),
    ('ccbill_webhook_secret', '', 'CCBill webhook shared secret (query token we require)', 'string'),
    ('chat_slowmode_seconds', '0', 'Global chat slow mode (0=off)', 'number'),
    ('coins_per_minute', '10', 'OpenCoins earned per minute watching', 'number'),
    ('crypto_api_key', '', 'Crypto provider API key', 'string'),
    ('crypto_enabled', 'false', 'Enable crypto payments', 'boolean'),
    ('crypto_ipn_secret', '', 'Crypto provider IPN/webhook secret', 'string'),
    ('crypto_provider', 'nowpayments', 'Crypto provider (nowpayments)', 'string'),
    ('gif_giphy_api_key', '', 'Giphy API key for chat GIF picker', 'string'),
    ('gif_tenor_api_key', '', 'Tenor API key for chat GIF picker', 'string'),
    ('google_client_id', '', 'Google OAuth Client ID (Google Cloud Console, for YouTube Connect)', 'string'),
    ('google_client_secret', '', 'Google OAuth Client Secret (Google Cloud Console)', 'string'),
    ('kick_client_id', '', 'Kick API Client ID (from kick.com/settings/developer, used for viewer counts)', 'string'),
    ('kick_client_secret', '', 'Kick API Client Secret (from kick.com/settings/developer)', 'string'),
    ('max_audio_bitrate', '320', 'Maximum audio bitrate for streamers (kbps)', 'number'),
    ('max_clip_duration', '60', 'Maximum clip duration in seconds', 'number'),
    ('max_emotes_per_user', '25', 'Max custom emotes per user', 'number'),
    ('max_video_bitrate', '6000', 'Maximum video bitrate for streamers (kbps)', 'number'),
    ('max_vod_size_mb', '5120', 'Maximum VOD file size in MB', 'number'),
    ('min_cashout_amount', '500', 'Minimum Vibes for cashout', 'number'),
    ('money_writes_frozen', 'false', 'Freeze: refuse every Live money action (checkouts, donations, cashouts, recycling, subscriptions, Vibes media requests) in both billing modes; reads keep working. Owner only — use /api/admin/money/freeze', 'boolean'),
    ('motd', '', 'Message of the day shown on homepage', 'string'),
    ('nsfw_enabled', 'true', 'Allow NSFW streams', 'boolean'),
    ('paste_anon_allowed', 'true', 'Allow anonymous paste creation', 'boolean'),
    ('paste_comment_anon_allowed', 'true', 'Allow anonymous comments on pastes', 'boolean'),
    ('paste_comment_cooldown_seconds', '10', 'Cooldown between paste comments in seconds', 'number'),
    ('paste_comment_max_length', '2000', 'Maximum paste comment length in characters', 'number'),
    ('paste_cooldown_seconds', '30', 'Cooldown between paste submissions in seconds', 'number'),
    ('paste_image_upload_enabled', 'true', 'Allow image uploads in pastes', 'boolean'),
    ('paste_max_per_user_per_day', '50', 'Maximum pastes per user per day (0 = unlimited)', 'number'),
    ('paste_max_size_kb', '512', 'Maximum paste content size in KB', 'number'),
    ('paste_screenshot_max_size_mb', '8', 'Maximum screenshot upload size in MB', 'number'),
    ('payments_enabled', 'false', 'Master switch: enable real-money purchases & subscriptions', 'boolean'),
    ('paypal_client_id', '', 'PayPal REST client ID', 'string'),
    ('paypal_client_secret', '', 'PayPal REST client secret', 'string'),
    ('paypal_enabled', 'false', 'Enable PayPal', 'boolean'),
    ('paypal_mode', 'sandbox', 'PayPal mode: sandbox | live', 'string'),
    ('paypal_webhook_id', '', 'PayPal webhook ID (for signature verification)', 'string'),
    ('powerchat_allow_test_fulfillment', 'false', 'Fulfill PowerChat checkouts from isTest webhook deliveries (dev/sandbox only — test tips move no money)', 'boolean'),
    ('powerchat_base_url', 'https://powerchatlive.dev', 'PowerChat base URL', 'string'),
    ('powerchat_client_id', '', 'PowerChat OAuth client_id (pca_…) from the PowerChat Developer dashboard', 'string'),
    ('powerchat_client_secret', '', 'PowerChat OAuth client_secret (pcs_…) — shown once; owner-only', 'string'),
    ('powerchat_enabled', 'false', 'Master switch: enable PowerChat donation/tip integration', 'boolean'),
    ('powerchat_sandbox_username', 'alex', 'Sandbox streamer username the app can act on until approved (the app owner’s PowerChat username)', 'string'),
    ('powerchat_scopes', 'profile:read webhooks:events checkout:attribute paid_messages:read alerts:trigger chat:write viewcount:write subscriptions:write follows:write currency:write tips:write chat:read', 'OAuth scopes requested from each streamer (space-delimited)', 'string'),
    ('powerchat_site_tip_username', '', 'PowerChat username whose tip page receives site purchases + fallback donations (that account must have the app connected on PowerChat)', 'string'),
    ('powerchat_webhook_secret', '', 'PowerChat webhook signing secret (pcw_…) — shown once; owner-only', 'string'),
    ('registration_open', 'true', 'Whether new user registration is open', 'boolean'),
    ('require_email', 'false', 'Require email for registration', 'boolean'),
    ('site_description', 'Live streaming for camp culture', 'Site description / tagline', 'string'),
    ('site_name', 'OpenVibe.Live', 'Public site name', 'string'),
    ('soundboard_101_api_key', '', '101soundboards API key for chat soundboard fetches', 'string'),
    ('stripe_enabled', 'false', 'Enable Stripe', 'boolean'),
    ('stripe_publishable_key', '', 'Stripe publishable key (pk_…)', 'string'),
    ('stripe_secret_key', '', 'Stripe secret key (sk_live_… / sk_test_…)', 'string'),
    ('stripe_webhook_secret', '', 'Stripe webhook signing secret (whsec_…)', 'string'),
    ('sub_price_usd', '4.99', 'Monthly channel subscription price in USD', 'number'),
    ('sub_site_route_fee_pct', '10', 'Platform fee (%) added when someone subscribes through OpenVibe''s PowerChat account instead of the streamer''s own', 'number'),
    ('sub_streamer_share_pct', '70', 'Percent of a subscription that goes to the streamer (as Vibes)', 'number'),
    ('tts_aws_access_key_id', '', 'Amazon Polly AWS Access Key ID', 'string'),
    ('tts_aws_region', 'us-east-1', 'Amazon Polly AWS Region', 'string'),
    ('tts_aws_secret_access_key', '', 'Amazon Polly AWS Secret Access Key', 'string'),
    ('tts_default_voice', 'gary', 'Default TTS voice ID', 'string'),
    ('tts_enabled', 'true', 'Enable site-wide TTS system', 'boolean'),
    ('tts_google_api_key', '', 'Google Cloud TTS API key', 'string'),
    ('tts_google_service_account', '', 'Google Cloud service account JSON (paste full JSON or file path)', 'string'),
    ('tts_max_length', '200', 'Maximum TTS message length (characters)', 'number'),
    ('tts_max_queue_global', '20', 'Maximum global TTS queue size', 'number'),
    ('tts_max_queue_per_user', '3', 'Maximum queued TTS messages per user', 'number'),
    ('tts_provider', 'espeak-ng', 'Default TTS provider (espeak-ng, google-cloud, amazon-polly)', 'string'),
    ('twitch_client_id', '', 'Twitch API Client ID (from dev.twitch.tv, used for viewer counts)', 'string'),
    ('twitch_client_secret', '', 'Twitch API Client Secret (from dev.twitch.tv)', 'string')
ON CONFLICT DO NOTHING;
