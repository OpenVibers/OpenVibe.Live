'use strict';

/**
 * Agent Streams S3: the stream part of a session report.
 *
 * When an agent stream ends, Live tells OpenVibe.Report about it. The report the tool wrote for the same task (the
 * same source and task ref) gets the stream added to it; when no tool finished the session - the stream was the
 * session - Report writes a stream-only report instead.
 *
 * The payload is the stream's own: its public id (ags_<ULID>), the VOD it left behind, the task it was for and the
 * person it was theirs.
 */
function buildStreamReport(row, next, worked) {
    const task = (row && row.task && typeof row.task === 'object') ? row.task : {};
    return {
        source: task.source || 'desk',
        task_ref: task.ref || null,
        ags_id: (row && row.public_id) || null,
        vod_id: (row && row.vod_id) || null,
        owner: (row && row.owner_subject) || null,
        task: {
            title: task.title || (row && row.title) || 'An agent session',
            ref: task.ref || (row && row.public_id) || '',
            url: task.url || null,
        },
        started_at: (row && row.started_at) || null,
        ended_at: (next && next.ended_at) || null,
        worked_seconds: Number(worked) || 0,
        visibility: (row && row.visibility) || 'private',
    };
}

module.exports = { buildStreamReport };
