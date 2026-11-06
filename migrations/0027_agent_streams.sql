-- phase: expand
-- Agent streams, S1 (design 2026-11-06, plan-state-2026-10-22/AGENT-STREAMS-S1-DESIGN-2026-11-06.md): an agent's
-- own desk screen, published by WHIP with a ticket and watched on Live. An agent stream is a managed_streams row of
-- kind 'agent', so the existing slot machinery, the live session row, the recorder and the player all apply; it never
-- has a stream key (the desk publishes with a wpt_ ticket) and it never takes one of the person's normal slots.
--
-- The public id is ags_<ULID>. The agent-only facts live beside the slot rather than on managed_streams, whose
-- SELECT * rows go to channel pages and through publicManagedStream(); a separate table keeps them out of every
-- response that was not written for them.
--
-- Tickets are stored as a sha256 only: a database copy cannot publish or watch with them. A publish ticket is bound to
-- one agent stream and, once a WHIP session attaches, to that session; revoking it is the kill switch. A view ticket
-- lives ten minutes and is minted for the owner, for someone the sharing system allows, or for the holder of the
-- unlisted link's secret (also stored hashed).
--
-- Expand only: the kind default makes every existing row a normal slot; an older release ignores all of it.
ALTER TABLE managed_streams ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'normal';
DO $$ BEGIN
    ALTER TABLE managed_streams ADD CONSTRAINT managed_streams_kind_allowed CHECK (kind IN ('normal', 'agent'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE managed_streams ADD COLUMN IF NOT EXISTS public_id text;
-- An agent stream has no stream key and no API may ever answer one.
ALTER TABLE managed_streams ALTER COLUMN stream_key DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS managed_streams_public_id ON managed_streams (public_id) WHERE public_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS managed_streams_kind_user ON managed_streams (user_id, kind);

CREATE TABLE IF NOT EXISTS agent_streams (
    managed_stream_id bigint PRIMARY KEY REFERENCES managed_streams(id) ON DELETE CASCADE,
    task jsonb NOT NULL,
    visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
    mode text NOT NULL DEFAULT 'watch' CHECK (mode IN ('watch', 'narrated', 'copilot', 'chatplays')),
    state text NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'live', 'ended')),
    curtain_up bigint NOT NULL DEFAULT 0,
    curtain_since timestamptz,
    curtain_reason text,
    started_at timestamptz,
    ended_at timestamptz,
    worked_seconds bigint NOT NULL DEFAULT 0,
    last_frame_path text,
    last_frame_at timestamptz,
    vod_id text,
    allow_sites jsonb NOT NULL DEFAULT '[]'::jsonb,
    unlisted_secret_hash text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_streams_state ON agent_streams (state);

CREATE TABLE IF NOT EXISTS agent_publish_tickets (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    managed_stream_id bigint NOT NULL REFERENCES managed_streams(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    session_id text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_publish_tickets_stream ON agent_publish_tickets (managed_stream_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS agent_view_tickets (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    managed_stream_id bigint NOT NULL REFERENCES managed_streams(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    subject text,
    via text NOT NULL CHECK (via IN ('owner', 'share', 'link')),
    expires_at timestamptz NOT NULL,
    -- The chain of renewals that began with one mint stops here: a page open all day tops up every ten minutes, but
    -- never past four hours from when it first asked (the design's "renews while the page is open, at most 4 h").
    renews_until timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_view_tickets_stream ON agent_view_tickets (managed_stream_id, expires_at DESC);

-- ── The sharing system's tables (openvibe-sdk/share) ──────────────────────────────────────────────────────────────
-- A private agent stream's guests are the sharing system's (server/agent-streams/sharing.js). These are its own
-- expand-only tables, kept here because a table is only ever created by a migration. The SDK owns their shape; the
-- service column is 'live' and the kind is 'agent-stream'.
CREATE TABLE IF NOT EXISTS shares (
    service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    owner_subject jsonb NOT NULL, audience text NOT NULL CHECK (audience IN ('public','link','people','private')),
    revision integer NOT NULL DEFAULT 1,
    lock text NOT NULL DEFAULT 'none',
    reseal_nonce_base text,
    PRIMARY KEY (service, kind, resource_id)
);
CREATE TABLE IF NOT EXISTS share_members (
    service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    subject jsonb NOT NULL, role text NOT NULL CHECK (role IN ('viewer','editor')),
    expires_at timestamptz, added_by jsonb NOT NULL, added_at timestamptz NOT NULL,
    key_slot jsonb,
    PRIMARY KEY (service, kind, resource_id, subject),
    FOREIGN KEY (service,kind,resource_id) REFERENCES shares(service,kind,resource_id)
);
CREATE TABLE IF NOT EXISTS share_transfers (
    id uuid PRIMARY KEY, service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    from_subject jsonb NOT NULL, to_subject jsonb NOT NULL, keep_access boolean NOT NULL DEFAULT false,
    requested_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('pending','accepted','declined','cancelled','expired')),
    key_slot jsonb,
    FOREIGN KEY (service,kind,resource_id) REFERENCES shares(service,kind,resource_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS share_transfer_pending ON share_transfers(service,kind,resource_id) WHERE state='pending';
CREATE TABLE IF NOT EXISTS share_access_requests (
    id uuid PRIMARY KEY, service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    subject jsonb NOT NULL, requested_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('pending','granted','dismissed')),
    FOREIGN KEY (service,kind,resource_id) REFERENCES shares(service,kind,resource_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS share_request_pending ON share_access_requests(service,kind,resource_id,subject) WHERE state='pending';
CREATE TABLE IF NOT EXISTS share_log (
    id uuid PRIMARY KEY, service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    actor jsonb NOT NULL, action text NOT NULL, details jsonb NOT NULL, occurred_at timestamptz NOT NULL,
    sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE OR REPLACE FUNCTION share_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'share_log is append-only'; END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='share_log_no_changes' AND tgrelid='share_log'::regclass) THEN
        CREATE TRIGGER share_log_no_changes BEFORE UPDATE OR DELETE OR TRUNCATE ON share_log
        FOR EACH STATEMENT EXECUTE FUNCTION share_log_append_only();
    END IF;
END $$;
CREATE TABLE IF NOT EXISTS share_deliveries (
    id uuid PRIMARY KEY, channel text NOT NULL CHECK (channel IN ('event','notify')),
    body jsonb NOT NULL, created_at timestamptz NOT NULL, delivered_at timestamptz,
    sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE TABLE IF NOT EXISTS share_name_limits (
    caller jsonb PRIMARY KEY, window_start bigint NOT NULL, attempts integer NOT NULL
);
CREATE INDEX IF NOT EXISTS share_members_subject ON share_members(subject);
CREATE INDEX IF NOT EXISTS share_transfers_recipient ON share_transfers(to_subject) WHERE state='pending';
CREATE INDEX IF NOT EXISTS share_deliveries_pending ON share_deliveries(created_at) WHERE delivered_at IS NULL;
