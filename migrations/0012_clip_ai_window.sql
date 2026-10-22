-- phase: expand
-- The clip window Live's AI state describes (server/media-proxy/outcomes.js, db.setClipAiWindow): '<start>-<end>',
-- seconds of the source recording to a tenth, from Media's clip.ready. A clip trimmed in place (Media POST
-- /clips/:id/trim) keeps its id with a narrower window; when clip.ready names a window other than this one, the clip's
-- overview and transcript describe footage it no longer has, so they are cleared and media.analyze runs again under a
-- new key. NULL until the clip's next clip.ready (or a trim from the clip editor) records it. Nullable, no default:
-- the N-1 release neither reads nor writes it.
ALTER TABLE clip_ai_state ADD COLUMN IF NOT EXISTS ai_window text COLLATE "C";
