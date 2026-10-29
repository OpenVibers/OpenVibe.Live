-- C01 clip audit — OpenVibe.Chat (ov_chat).
-- The old cutter cut a clip when a chat bucket spiked; this file gives the buckets (counts only,
-- never who wrote them) so the spike behind every cut can be reconstructed and the cuts can be
-- grouped by spike size.
--
-- Read-only: one READ ONLY transaction, 20 s statement timeout. Aggregate-only: counts per bucket
-- and the summary percentiles. No usernames, no user ids, no IPs.
--
--   scp clip-audit-chat.sql host:/tmp && sudo -u postgres psql -X -q -At -d ov_chat -f /tmp/clip-audit-chat.sql

SET statement_timeout = '20s';
BEGIN READ ONLY;

-- 1. The buckets themselves: 15-second buckets (the size the old rule used), last 30 days.
--    Join to the cut list (ov_media clips: stream_id, start_time) to get the spike at each cut.
SELECT 'chat_buckets' AS section,
       stream_id,
       floor(extract(epoch from timestamp::timestamptz) / 15)::bigint AS bucket,
       count(*) AS messages,
       count(DISTINCT COALESCE(user_id::text, anon_id)) AS people
FROM chat_messages
WHERE is_deleted = 0
  AND is_filtered = 0
  AND timestamp::timestamptz >= now() - interval '30 days'
GROUP BY 2, 3
ORDER BY 2, 3;

-- 2. The same buckets as a summary: how busy a bucket is, and how big the spikes are.
WITH buckets AS (
    SELECT stream_id,
           floor(extract(epoch from timestamp::timestamptz) / 15)::bigint AS bucket,
           count(*) AS messages
    FROM chat_messages
    WHERE is_deleted = 0
      AND is_filtered = 0
      AND timestamp::timestamptz >= now() - interval '30 days'
    GROUP BY 1, 2
)
SELECT 'chat_bucket_summary' AS section,
       count(*) AS occupied_buckets,
       count(DISTINCT stream_id) AS streams,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY messages)) AS p50_messages,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY messages)) AS p90_messages,
       round(percentile_cont(0.99) WITHIN GROUP (ORDER BY messages)) AS p99_messages
FROM buckets;

COMMIT;
