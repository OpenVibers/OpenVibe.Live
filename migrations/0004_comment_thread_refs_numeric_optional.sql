-- phase: expand
-- Compatibility register C-14: Live addresses OpenVibe.Community threads by their access id (cth_…, already stored in
-- comment_thread_refs.access_id), and Community stops handing services the numeric thread id. A thread resolved from
-- now on may have no numeric id, so thread_id becomes nullable; rows made before keep theirs, used only to recognise a
-- parent comment during the switch. A later contract migration drops the column.
ALTER TABLE comment_thread_refs ALTER COLUMN thread_id DROP NOT NULL;
