-- C01 clip audit — OpenVibe.Live (ov_live).
-- Aggregate-only diagnostics for the automatic clipper: what the old rule cut, how the new
-- clip-score rule (Live#442, 2026-10-29 18:52 UTC) is doing, and how busy the site was.
--
-- Read-only: the whole file runs in one READ ONLY transaction with a 20 s statement timeout.
-- Private by construction: no titles, no user ids, no emails, no IPs — counts and percentiles only.
--
--   scp clip-audit-live.sql host:/tmp && sudo -u postgres psql -X -q -At -d ov_live -f /tmp/clip-audit-live.sql

SET statement_timeout = '20s';
BEGIN READ ONLY;

-- 1. Automatic cuts per day, from Live's own clip log (the state table the cutter writes).
SELECT 'auto_clip_log_per_day' AS section,
       to_char(to_timestamp((e->>'ts')::double precision / 1000), 'YYYY-MM-DD') AS bucket,
       count(*) AS clips
FROM app_state s, LATERAL jsonb_array_elements(s.value::jsonb) e
WHERE s.key = 'auto_clip_log'
  AND (e->>'ts')::double precision >= extract(epoch from now() - interval '30 days') * 1000
GROUP BY 2
ORDER BY 2;

-- 2. The log's shape: how many cuts it holds, its span, and how many carry the new score fields.
SELECT 'auto_clip_log_shape' AS section,
       count(*) AS entries,
       min(to_timestamp((e->>'ts')::double precision / 1000))::date AS oldest_day,
       max(to_timestamp((e->>'ts')::double precision / 1000))::date AS newest_day,
       count(*) FILTER (WHERE jsonb_exists(e, 'score')) AS with_score,
       count(*) FILTER (WHERE jsonb_exists(e, 'visibility')) AS with_visibility,
       count(*) FILTER (WHERE jsonb_exists(e, 'clip_id')) AS with_clip_id,
       count(*) FILTER (WHERE COALESCE((e->>'dedup')::boolean, false)) AS deduplicated
FROM app_state s, LATERAL jsonb_array_elements(s.value::jsonb) e
WHERE s.key = 'auto_clip_log';

-- 3. The clip-score the new rule gave the cuts it made (empty until the new rule has cuts).
SELECT 'auto_clip_log_scores' AS section,
       COALESCE(e->>'score', 'none') AS score,
       COALESCE(e->>'visibility', 'none') AS visibility,
       count(*) AS clips
FROM app_state s, LATERAL jsonb_array_elements(s.value::jsonb) e
WHERE s.key = 'auto_clip_log'
GROUP BY 2, 3
ORDER BY 2, 3;

-- 4. Interest in the streams that produced clips: chatters, peak viewers, chat volume.
SELECT 'clip_stream_interest' AS section,
       count(*) AS stream_rows,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY unique_chatters))::bigint AS median_chatters,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY unique_chatters))::bigint AS p90_chatters,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY peak_viewers))::bigint AS median_peak_viewers,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY total_messages))::bigint AS median_messages,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY total_messages))::bigint AS p90_messages
FROM stream_analytics
WHERE COALESCE(clips_created, 0) > 0;

-- 5. The AI verdicts behind the clips: how many clips the AI has worked on.
SELECT 'clip_ai_state' AS section,
       count(*) AS clips,
       count(*) FILTER (WHERE transcript_status = 'ready') AS with_transcript,
       count(*) FILTER (WHERE COALESCE(ai_overview_short, '') <> '') AS with_overview,
       count(*) FILTER (WHERE COALESCE(ai_transcript_json, '') <> '') AS with_transcript_json
FROM clip_ai_state;

-- 6. Streams and their audience over the last 30 days (the traffic the cutter worked with).
SELECT 'streams_30d' AS section,
       count(*) AS streams,
       count(*) FILTER (WHERE is_live <> 0) AS live_now,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY peak_viewers))::bigint AS median_peak_viewers,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY peak_viewers))::bigint AS p90_peak_viewers,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY viewer_count))::bigint AS median_viewers
FROM streams
WHERE started_at::timestamptz >= now() - interval '30 days';

COMMIT;
