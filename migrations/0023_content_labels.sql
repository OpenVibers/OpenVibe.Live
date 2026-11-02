-- phase: expand
-- Content labels (L1, labels and choices, 2026-10-31; Contracts 0.257.0 common.content-labels@1).
--
-- A creator labels a stream slot (managed_streams) in the setup/dashboard; the live session copies those labels when
-- it starts, so the channel page, the cards and the watch screen read them from the stream itself. The AI may
-- SUGGEST a label from the frame notes it already writes; a suggestion is stored in `suggested` and changes nothing
-- for anyone until the creator confirms it. Three viewer suggestions or a moderator may put a label on later.
--
-- Labels are choices, not bans: nothing here hides content from the person who posted it, and nothing filters a
-- viewer's search or feed except the one clean page (the home page skips 18+). The query that reads a label uses the
-- jsonb containment operator, so the GIN index answers it.
--
-- Expand only: an older release never reads these columns, and the defaults keep every existing row label-free.
ALTER TABLE managed_streams ADD COLUMN IF NOT EXISTS content_labels jsonb NOT NULL DEFAULT '{"labels": [], "suggested": []}'::jsonb;
ALTER TABLE streams ADD COLUMN IF NOT EXISTS content_labels jsonb NOT NULL DEFAULT '{"labels": [], "suggested": []}'::jsonb;
CREATE INDEX IF NOT EXISTS streams_content_labels ON streams USING gin (content_labels);
CREATE INDEX IF NOT EXISTS managed_streams_content_labels ON managed_streams USING gin (content_labels);
