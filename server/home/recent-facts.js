'use strict';

function moment(value) {
    if (!value) return NaN;
    const text = String(value);
    const ms = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z');
    return Number.isFinite(ms) ? ms : NaN;
}
function duration(row, now) {
    const stored = Number(row.duration_seconds) || 0;
    if (stored > 0) return stored;
    const start = moment(row.started_at);
    const end = row.is_live ? now : moment(row.ended_at);
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : 0;
}
function summarizeHistory(rows, now = Date.now()) {
    const sorted = (rows || []).filter((r) => Number.isFinite(moment(r.started_at)))
        .sort((a, b) => moment(b.started_at) - moment(a.started_at));
    const week = sorted.filter((r) => moment(r.started_at) >= now - 7 * 86400000 && moment(r.started_at) <= now);
    const hours = Math.round(week.reduce((n, r) => n + duration(r, now), 0) / 360) / 10;
    const starts = week.map((r) => new Date(moment(r.started_at)).getUTCHours());
    const bins = [0, 0, 0, 0];
    for (const h of starts) bins[h < 5 ? 0 : h < 12 ? 1 : h < 17 ? 2 : 3]++;
    const bucket = bins.indexOf(Math.max(...bins));
    const usual = starts.length >= 2 ? 'Usually live ' + ['late nights', 'mornings', 'afternoons', 'evenings'][bucket] : null;
    const dates = new Set(sorted.map((r) => new Date(moment(r.started_at)).toISOString().slice(0, 10)));
    let run = 0;
    const latest = sorted[0] && new Date(moment(sorted[0].started_at)).toISOString().slice(0, 10);
    if (latest) for (let d = Date.parse(latest + 'T00:00:00Z'); dates.has(new Date(d).toISOString().slice(0, 10)); d -= 86400000) run++;
    return {
        streams_this_week: week.length, hours_this_week: hours, usual_time: usual,
        days_in_a_row: run >= 3 ? run : null, last_stream_seconds: sorted[0] ? duration(sorted[0], now) : null,
        streams: sorted.slice(0, 2).map((r) => ({ id: r.id, title: r.title || 'Stream', started_at: r.started_at,
            length_seconds: duration(r, now), is_live: !!r.is_live, thumbnail_url: r.thumbnail_url || null,
            managed_stream_id: r.managed_stream_id || null })),
    };
}
module.exports = { summarizeHistory, moment, duration };
