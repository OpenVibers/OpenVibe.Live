'use strict';

const db = require('../db/database');
const { client } = require('./bench-client');
const delivery = require('../chat/chat-delivery');
const { publicBenchPoll: publicPoll } = require('../web/serializers');

const VALID_KINDS = new Set(['design.page', 'design.component', 'games.fun', 'meme.caption', 'vision.pair', 'codes.review', 'surf.desk', 'chat.reply', 'speech.tts', 'translate.ja', 'search.answer']);

async function line(row, message, suffix) {
    await delivery.message({ stream_id: Number(row.stream_id), channel_user_id: Number(row.streamer_id), user_id: null,
        username: 'OpenVibe.Bench', message, message_type: 'system',
        metadata: { kind: 'bench_stream', round_id: row.round_id }, key: `bench:${row.round_id}:${suffix}` });
}

async function start(streamerId, { kind, prompt, durationSeconds = 60 }) {
    if (!VALID_KINDS.has(kind)) throw new Error('Choose a pairwise Bench kind.');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('Write a prompt of at most 4000 characters.');
    if (!Number.isInteger(durationSeconds) || durationSeconds < 15 || durationSeconds > 600) throw new Error('Vote time must be 15 to 600 seconds.');
    const streams = await db.getLiveStreamsByUserId(streamerId);
    const stream = streams && streams[0];
    if (!stream) throw new Error('Go live before starting a Bench round.');
    const active = await db.get("SELECT id FROM live_bench_polls WHERE streamer_id = ? AND status IN ('pending', 'open', 'closing') LIMIT 1", [streamerId]);
    if (active) throw new Error('Finish the current Bench round first.');
    const subject = await require('../auth/identity-sync').subjectOf(streamerId);
    if (!subject) throw new Error('Sign in again to start a Bench round.');
    const task = await client().tasks.create(kind, { prompt: prompt.trim(), public: true }, { actingSubject: subject });
    const created = await client().rounds.create(task.task.id, {}, { actingSubject: subject });
    try {
        await db.run(`INSERT INTO live_bench_polls (streamer_id, stream_id, round_id, kind_id, prompt, status, duration_seconds)
            VALUES (?, ?, ?, ?, ?, 'pending', ?)`, [streamerId, stream.id, created.round.id, kind, prompt.trim(), durationSeconds]);
    } catch (err) {
        if (err.code === '23505') throw new Error('Finish the current Bench round first.');
        throw err;
    }
    return await current(streamerId);
}

async function current(streamerId) {
    const row = await db.get(`SELECT p.* FROM live_bench_polls p JOIN streams s ON s.id = p.stream_id
        WHERE p.streamer_id = ? AND s.is_live = 1 ORDER BY p.id DESC LIMIT 1`, [streamerId]);
    if (!row) return null;
    return publicPoll(row);
}

async function advance(row) {
    if (row.status === 'pending') {
        const stream = await db.getStreamById(row.stream_id);
        if (!stream || !stream.is_live) {
            await db.run("UPDATE live_bench_polls SET status = 'failed' WHERE id = ? AND status = 'pending'", [row.id]);
            return;
        }
        const { round } = await client().rounds.get(row.round_id);
        if (round.status === 'failed') {
            await db.run("UPDATE live_bench_polls SET status = 'failed' WHERE id = ? AND status = 'pending'", [row.id]);
            return;
        }
        const entries = (round.entries || []).filter((e) => !e.error).slice(0, 2);
        if (round.status !== 'finished' || entries.length !== 2) return;
        const opened = await db.run(`UPDATE live_bench_polls SET status = 'open', entries = ?, closes_at = now() + duration_seconds * interval '1 second'
            WHERE id = ? AND status = 'pending'`, [JSON.stringify(entries), row.id]);
        if (opened.changes) await line(row, `Bench vote is open for ${row.duration_seconds}s: !1, !2 or !tie. ${row.prompt}`.slice(0, 480), 'open');
        return;
    }
    if (row.status !== 'open' && row.status !== 'closing') return;
    if (row.status === 'open' && new Date(row.closes_at).getTime() > Date.now()) return;
    if (row.status === 'open') {
        const claimed = await db.run("UPDATE live_bench_polls SET status = 'closing' WHERE id = ? AND status = 'open'", [row.id]);
        if (!claimed.changes) return;
    }
    const counts = { left: 0, right: 0, tie: 0, voters: 0 };
    for (const v of await db.all('SELECT choice, COUNT(*)::int AS n FROM live_bench_votes WHERE poll_id = ? GROUP BY choice', [row.id])) {
        counts[v.choice] = Number(v.n);
        counts.voters += Number(v.n);
    }
    const entries = typeof row.entries === 'string' ? JSON.parse(row.entries) : row.entries;
    const outcome = counts.left > counts.right && counts.left > counts.tie ? 'left'
        : counts.right > counts.left && counts.right > counts.tie ? 'right' : 'tie';
    let judgementId = row.judgement_id;
    if (!judgementId) {
        try {
            const result = await client().judgements.cast(row.round_id, { judge: 'audience_poll', pair: { left: entries[0].id, right: entries[1].id }, outcome, vote_counts: counts });
            judgementId = result.judgement.id;
        } catch (err) {
            if (err.status !== 409 || err.code !== 'bench.already_judged') throw err;
            // A previous close reached Bench and crashed before saving the receipt. Bench's one-service-per-round rule prevents a duplicate.
            judgementId = 'already-recorded';
        }
    }
    await db.run("UPDATE live_bench_polls SET status = 'closed', vote_counts = ?, judgement_id = ? WHERE id = ? AND status = 'closing'", [JSON.stringify(counts), judgementId, row.id]);
    const summary = `${counts.left} for 1, ${counts.right} for 2, ${counts.tie} tie (${counts.voters} voters)`;
    await line(row, `Bench vote closed: ${outcome === 'left' ? '1 wins' : outcome === 'right' ? '2 wins' : 'tie'} — ${summary}.`, 'closed');
}

async function vote({ streamId, userId, choice }) {
    if (!Number.isSafeInteger(streamId) || !Number.isSafeInteger(userId) || !['left', 'right', 'tie'].includes(choice)) return { ok: false, message: 'Invalid vote.' };
    const stream = await db.getStreamById(streamId);
    if (!stream || !stream.is_live) return { ok: false, message: 'The stream is not live.' };
    if (Number(stream.user_id) === userId) return { ok: false, message: 'The streamer cannot vote in their own round.' };
    if (!await db.getUserById(userId) || !await require('../auth/identity-sync').subjectOf(userId)) return { ok: false, message: 'Sign in to vote.' };
    return await db.tx(async () => {
        // Closing updates this same row. A vote admitted before the deadline commits before the tally runs.
        const row = await db.get("SELECT * FROM live_bench_polls WHERE stream_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1 FOR UPDATE", [streamId]);
        if (!row) return { ok: false, message: 'There is no open Bench vote.' };
        if (new Date(row.closes_at).getTime() <= Date.now()) return { ok: false, message: 'Voting has closed.' };
        const added = await db.run(`INSERT INTO live_bench_votes (poll_id, user_id, choice)
            SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM live_bench_polls WHERE id = ? AND status = 'open' AND closes_at > now())
            ON CONFLICT DO NOTHING`, [row.id, userId, choice, row.id]);
        return added.changes ? { ok: true, message: 'Your Bench vote is counted.' } : { ok: false, message: 'You already voted, or voting has closed.' };
    });
}

function startJobs() {
    require('../utils/jobs').every('bench-stream-polls', 3000, async () => {
        for (const row of await db.all("SELECT * FROM live_bench_polls WHERE status IN ('pending', 'open', 'closing') ORDER BY id LIMIT 30")) {
            try { await advance(row); }
            catch (err) { console.warn('[BenchStream] advance:', err.message); }
        }
    }, { initialDelayMs: 1000 });
}

module.exports = { start, current, vote, startJobs, publicPoll, advance };
