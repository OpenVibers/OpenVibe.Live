-- phase: expand
-- AI titles for untitled clips (server/ai/clip-title.js; owner, 2026-10-25: "The AI should automatically title clips that
-- are untitled"): whether a clip's title is decided. 'titled': it carried a placeholder ("Untitled Clip", "Clip from
-- stream") and the AI named it; 'kept': its maker's own title stays; 'failed': no usable title came (it keeps its
-- placeholder). NULL until decided. Nullable, no default: the N-1 release neither reads nor writes it.
ALTER TABLE clip_ai_state ADD COLUMN IF NOT EXISTS title_status text COLLATE "C";
