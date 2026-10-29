-- C01 clip audit — OpenVibe.Media (ov_media).
-- The canonical clip table. Automatic clips are the ones the AI clipper cut (auto_generated = 1);
-- the rest were cut by people. This file says how many automatic clips there are, what they are
-- worth, how many nobody ever watched, and how they repeat (overlap and semantic repeats counted
-- separately).
--
-- Read-only: one READ ONLY transaction, 20 s statement timeout. Aggregate-only: counts, medians
-- and percentiles. No titles, no user ids, no emails, no IPs.
--
--   scp clip-audit-media.sql host:/tmp && sudo -u postgres psql -X -q -At -d ov_media -f /tmp/clip-audit-media.sql

SET statement_timeout = '20s';
BEGIN READ ONLY;

-- 1. Automatic clips per day over the last 30 days.
SELECT 'auto_clips_per_day' AS section,
       to_char(date_trunc('day', created_at::timestamptz), 'YYYY-MM-DD') AS bucket,
       count(*) AS clips
FROM public.clips
WHERE auto_generated = 1
  AND created_at::timestamptz >= now() - interval '30 days'
GROUP BY 2
ORDER BY 2;

-- 2. Automatic versus human clips, by kind (visibility x status): counts, median length, median plays.
SELECT 'clips_by_kind' AS section,
       CASE WHEN auto_generated = 1 THEN 'auto' ELSE 'human' END AS kind,
       visibility,
       status,
       count(*) AS clips,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_seconds)) AS median_seconds,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY view_count)) AS median_plays,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY unique_views)) AS median_viewers
FROM public.clips
GROUP BY 2, 3, 4
ORDER BY 2, 3, 4;

-- 3. What the old rule produced: plays, viewers and length of the automatic clips, in percentiles.
SELECT 'auto_clips_percentiles' AS section,
       count(*) AS clips,
       round(percentile_cont(0.25) WITHIN GROUP (ORDER BY view_count)) AS p25_plays,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY view_count)) AS p50_plays,
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY view_count)) AS p75_plays,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY view_count)) AS p90_plays,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY unique_views)) AS p50_viewers,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_seconds)) AS p50_seconds,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_seconds)) AS p90_seconds
FROM public.clips
WHERE auto_generated = 1;

-- 4. Never watched by a person. A person is a visitor row (content_visits counts visitors, never
--    names one); a play counter alone is not a person. 7 and 30 days after the clip was cut.
WITH clips AS (
    SELECT c.id,
           c.created_at::timestamptz AS cut_at,
           extract(epoch from now() - c.created_at::timestamptz) / 86400 AS age_days,
           (SELECT count(*) FROM content_visits v
             WHERE v.content_type = 'clip' AND v.content_id = c.id) AS visitors,
           (SELECT count(*) FROM content_visits v
             WHERE v.content_type = 'clip' AND v.content_id = c.id
               AND v.last_at::timestamptz >= c.created_at::timestamptz + interval '7 days') AS visitors_7d,
           (SELECT count(*) FROM content_visits v
             WHERE v.content_type = 'clip' AND v.content_id = c.id
               AND v.last_at::timestamptz >= c.created_at::timestamptz + interval '30 days') AS visitors_30d
    FROM public.clips c
    WHERE c.auto_generated = 1
)
SELECT 'auto_clips_never_watched' AS section,
       count(*) AS clips,
       count(*) FILTER (WHERE visitors = 0) AS never_watched,
       count(*) FILTER (WHERE age_days >= 7) AS clips_at_least_7d_old,
       count(*) FILTER (WHERE age_days >= 7 AND visitors_7d = 0) AS never_watched_after_7d,
       count(*) FILTER (WHERE age_days >= 30) AS clips_at_least_30d_old,
       count(*) FILTER (WHERE age_days >= 30 AND visitors_30d = 0) AS never_watched_after_30d
FROM clips;

-- 5. Overlap: two automatic cuts of the same source that cover the same seconds.
SELECT 'auto_clip_overlap' AS section,
       count(*) AS overlapping_pairs,
       count(DISTINCT a.id) AS clips_involved
FROM public.clips a
JOIN public.clips b
  ON a.id < b.id
 AND a.vod_id = b.vod_id
 AND a.auto_generated = 1
 AND b.auto_generated = 1
 AND a.start_time < b.end_time
 AND b.start_time < a.end_time;

-- 6. Semantic repeats, counted separately from the overlap above: the same words cut from
--    different footage. Only hashes are compared; no text is printed.
WITH fingerprints AS (
    SELECT md5(lower(regexp_replace(COALESCE(ai_transcript, ''), '[^a-z0-9]+', ' ', 'g'))) AS fp,
           count(*) AS clips,
           count(DISTINCT vod_id) AS sources
    FROM public.clips
    WHERE auto_generated = 1
      AND COALESCE(ai_transcript, '') <> ''
    GROUP BY 1
)
SELECT 'auto_clip_semantic_repeats' AS section,
       count(*) AS distinct_fingerprints,
       count(*) FILTER (WHERE clips > 1) AS fingerprints_used_twice,
       count(*) FILTER (WHERE sources > 1) AS fingerprints_on_several_sources,
       COALESCE(sum(clips) FILTER (WHERE clips > 1), 0) AS clips_in_repeat_pairs
FROM fingerprints;

COMMIT;
