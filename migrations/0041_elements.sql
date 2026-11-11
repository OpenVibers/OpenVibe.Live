-- phase: expand
-- Elements, stage 1 (owner ask 2026-11-11): a streamer's library of buttons and controls people
-- make, the store each one keeps, and the presses that authorise a run. The deck is a new surface
-- on the channel page, so it is OFF until the streamer turns it on (channels.deck_enabled); the
-- migration only adds, and the previous release reads every new table as absent.
CREATE TABLE IF NOT EXISTS elements (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id text COLLATE "C" NOT NULL UNIQUE,
    user_id bigint NOT NULL,
    name text COLLATE "C" NOT NULL,
    description text COLLATE "C",
    look jsonb NOT NULL,
    recipe jsonb NOT NULL,
    capabilities jsonb NOT NULL,
    initial_state jsonb NOT NULL DEFAULT '{}'::jsonb,
    mod jsonb,
    sharing text COLLATE "C" NOT NULL DEFAULT 'private',
    active bigint NOT NULL DEFAULT 1,
    position bigint NOT NULL DEFAULT 0,
    revision bigint NOT NULL DEFAULT 1,
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT elements_public_id_shape CHECK (public_id ~ '^el_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT elements_sharing CHECK (sharing IN ('private', 'link', 'gallery')),
    CONSTRAINT elements_active CHECK (active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_elements_deck ON elements(user_id, active, position, id);
CREATE INDEX IF NOT EXISTS idx_elements_public ON elements(public_id);

CREATE TABLE IF NOT EXISTS element_state (
    element_id bigint PRIMARY KEY,
    revision bigint NOT NULL DEFAULT 0,
    values jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (element_id) REFERENCES elements(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS element_press_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    element_id bigint NOT NULL,
    presser_id bigint,
    source text COLLATE "C" NOT NULL DEFAULT 'press',
    points bigint NOT NULL DEFAULT 0,
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (element_id) REFERENCES elements(id) ON DELETE CASCADE,
    CONSTRAINT element_press_source CHECK (source IN ('press', 'chat')),
    CONSTRAINT element_press_points CHECK (points >= 0)
);

CREATE INDEX IF NOT EXISTS idx_element_press_person ON element_press_log(element_id, presser_id, created_at);
CREATE INDEX IF NOT EXISTS idx_element_press_all ON element_press_log(element_id, created_at);

-- The owner switch: a channel's Viewer Deck is off until the streamer opens Elements for it.
ALTER TABLE channels ADD COLUMN deck_enabled bigint NOT NULL DEFAULT 0;
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_deck_enabled;
ALTER TABLE channels ADD CONSTRAINT channels_deck_enabled CHECK (deck_enabled IN (0, 1));
