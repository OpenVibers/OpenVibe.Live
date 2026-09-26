/**
 * Following a clip cut on the server (OpenVibe.Media's clip.cut job; roadmap WS-G task 3).
 *
 * A clip the server cuts answers with its job id. The page follows the job until the clip is ready
 * and survives a reload: pending cuts are kept in localStorage (ov_clip_jobs, 30 minutes at most) and
 * the next page that loads this reattaches to them.
 *
 *   OVClipJobs.follow(clipId, jobId, { onReady(clip), onFailed(message), onRetry(job) })
 *   OVClipJobs.resume({ onReady, onFailed, onRetry })    follow what an earlier page left pending
 *   OVClipJobs.pending()                                  [{ clipId, jobId, at }]
 */
(function () {
    'use strict';
    var KEY = 'ov_clip_jobs';
    var MAX_AGE_MS = 30 * 60 * 1000;
    var followed = {};

    function load() {
        try {
            var list = JSON.parse(localStorage.getItem(KEY) || '[]');
            return Array.isArray(list) ? list.filter(function (e) { return e && e.clipId && e.jobId && Date.now() - e.at < MAX_AGE_MS; }) : [];
        } catch (e) { return []; }
    }
    function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list.slice(-10))); } catch (e) { /* storage off: this page still follows */ } }
    function forget(jobId) { save(load().filter(function (e) { return e.jobId !== jobId; })); delete followed[jobId]; }
    function remember(clipId, jobId) {
        var list = load().filter(function (e) { return e.jobId !== jobId; });
        list.push({ clipId: clipId, jobId: jobId, at: Date.now() });
        save(list);
    }
    function headers() {
        var t = null;
        try { t = localStorage.getItem('token'); } catch (e) { /* none */ }
        return t ? { Authorization: 'Bearer ' + t } : {};
    }

    function follow(clipId, jobId, h) {
        h = h || {};
        if (!clipId || !jobId || followed[jobId]) return;
        followed[jobId] = true;
        remember(clipId, jobId);
        var started = Date.now(), tries = 0, retried = 0;
        (function poll() {
            if (Date.now() - started > MAX_AGE_MS) { forget(jobId); return; }
            fetch('/api/clips/' + encodeURIComponent(clipId) + '/job?job=' + encodeURIComponent(jobId), { headers: headers(), credentials: 'same-origin' })
                .then(function (r) { return r.status === 404 || r.status === 403 ? { gone: true } : (r.ok ? r.json() : null); })
                .then(function (d) {
                    if (d && d.gone) { forget(jobId); return; }
                    var job = d && d.job;
                    if (job && job.status === 'succeeded') { forget(jobId); if (h.onReady) h.onReady(d.clip || { id: clipId }); return; }
                    if (job && (job.status === 'failed' || job.status === 'cancelled')) { forget(jobId); if (h.onFailed) h.onFailed(job.error || 'The clip could not be cut'); return; }
                    // A failed attempt waits for its retry (the server backs off): say so once per attempt.
                    if (job && job.status === 'queued' && job.attempts > retried) { retried = job.attempts; if (h.onRetry) h.onRetry(job); }
                    tries++;
                    setTimeout(poll, job && job.attempts > 0 ? 5000 : Math.min(4000, 800 + tries * 200));
                })
                .catch(function () { tries++; setTimeout(poll, Math.min(15000, 2000 * tries)); });
        })();
    }

    function resume(h) { load().forEach(function (e) { follow(e.clipId, e.jobId, h); }); }

    window.OVClipJobs = { follow: follow, resume: resume, pending: load };
})();
