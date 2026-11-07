-- phase: expand
-- The Rundown's bar: search and filters (design 2026-11-06, section 4; plan-state-2026-10-22/
-- RUNDOWN-CONTROLS-AND-BROWSE-DESIGN-2026-11-06.md).
--
-- One tsvector per row with a GIN index, so a single query finds a take by its title, by what was said, by the
-- desk's quip, by one of its quotes or by the topic it is on; an episode by its title, logline, recap or chapters;
-- a topic by its name, headline or summary. English configuration, so the words are stemmed ("takes" finds "took")
-- and a phrase in quotes is matched as a phrase (websearch_to_tsquery turns "two words" into two words <-> two).
--
-- The column is filled by a trigger, not by the desk: a topic's name is part of every take on it, and a name that
-- changes later must change the search with it. Expand only: the columns are nullable and the old release never
-- writes them, so it keeps working; the backfill below fills what is already written.
ALTER TABLE rundown_segments ADD COLUMN IF NOT EXISTS search_tsv tsvector;
ALTER TABLE rundown_episodes ADD COLUMN IF NOT EXISTS search_tsv tsvector;
ALTER TABLE rundown_topics   ADD COLUMN IF NOT EXISTS search_tsv tsvector;

-- A take: its own words, the desk's quip, the quotes it carries and the name of the topic it is on.
CREATE OR REPLACE FUNCTION rundown_segments_search_tsv() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
    topic_title text;
BEGIN
    SELECT t.title INTO topic_title FROM rundown_topics t WHERE t.id = NEW.topic_id;
    NEW.search_tsv := to_tsvector('english',
        coalesce(NEW.title, '') || ' ' || coalesce(NEW.what, '') || ' ' || coalesce(NEW.take, '') || ' ' ||
        coalesce(NEW.quip, '') || ' ' || coalesce(NEW.quotes_json, '') || ' ' || coalesce(topic_title, ''));
    RETURN NEW;
END;
$fn$;

-- An episode: its title, its logline, its recap and its chapters.
CREATE OR REPLACE FUNCTION rundown_episodes_search_tsv() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.search_tsv := to_tsvector('english',
        coalesce(NEW.title, '') || ' ' || coalesce(NEW.logline, '') || ' ' || coalesce(NEW.recap, '') || ' ' ||
        coalesce(NEW.chapters_json, ''));
    RETURN NEW;
END;
$fn$;

-- A topic: its name, its headline and the summary the desk writes for it.
CREATE OR REPLACE FUNCTION rundown_topics_search_tsv() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.search_tsv := to_tsvector('english',
        coalesce(NEW.title, '') || ' ' || coalesce(NEW.headline, '') || ' ' || coalesce(NEW.summary, ''));
    RETURN NEW;
END;
$fn$;

-- A topic that is renamed changes the search of every take on it.
CREATE OR REPLACE FUNCTION rundown_topics_search_refresh() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.title IS DISTINCT FROM OLD.title THEN
        UPDATE rundown_segments SET search_tsv = NULL WHERE topic_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$fn$;

DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rundown_segments_search_tsv_trg') THEN
        CREATE TRIGGER rundown_segments_search_tsv_trg BEFORE INSERT OR UPDATE ON rundown_segments
            FOR EACH ROW EXECUTE FUNCTION rundown_segments_search_tsv();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rundown_episodes_search_tsv_trg') THEN
        CREATE TRIGGER rundown_episodes_search_tsv_trg BEFORE INSERT OR UPDATE ON rundown_episodes
            FOR EACH ROW EXECUTE FUNCTION rundown_episodes_search_tsv();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rundown_topics_search_tsv_trg') THEN
        CREATE TRIGGER rundown_topics_search_tsv_trg BEFORE INSERT OR UPDATE ON rundown_topics
            FOR EACH ROW EXECUTE FUNCTION rundown_topics_search_tsv();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rundown_topics_search_refresh_trg') THEN
        CREATE TRIGGER rundown_topics_search_refresh_trg AFTER UPDATE ON rundown_topics
            FOR EACH ROW EXECUTE FUNCTION rundown_topics_search_refresh();
    END IF;
END;
$do$;

-- What is already written gets its words (the triggers above fill the rows as they are touched).
UPDATE rundown_segments SET search_tsv = NULL;
UPDATE rundown_episodes SET search_tsv = NULL;
UPDATE rundown_topics   SET search_tsv = NULL;

CREATE INDEX IF NOT EXISTS idx_rundown_segments_search ON rundown_segments USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_rundown_episodes_search ON rundown_episodes USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_rundown_topics_search   ON rundown_topics   USING gin (search_tsv);
