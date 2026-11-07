'use strict';
/**
 * /api/streams/agent — the agent streams API (live.agent-stream@1 and the publish/view routes around it).
 *
 *   POST   /                             create the stream and its publish ticket      { stream, publish } 201
 *   GET    /                             the caller's own streams, the live one first  { streams } (Dock K-D3)
 *   GET    /:id                          the stream (view rule), plus what its page needs
 *   PUT    /:id/visibility               the owner's switch
 *   POST   /:id/rotate-link              a fresh unlisted link secret (the old links stop working)
 *   POST   /:id/ticket                   renew the publish ticket (the desk renews at three hours)
 *   DELETE /:id/ticket                   revoke it — the kill switch; Live ends the WHIP session at once
 *   GET    /:id/state                    what the desk polls every 10 s (with the ticket)
 *   PUT    /:id/frame                    the desk's last frame (JPEG or WebP, ≤200 KB, with the ticket)
 *   GET    /:id/frame                    that frame, for a viewer allowed to see the stream
 *   POST   /:id/curtain                  the desk's privacy screen up or down
 *   POST   /:id/end                      end the stream (the person or the desk)
 *   POST   /:id/view-ticket              mint a view ticket for a player (owner, guest, unlisted link)
 *
 * The desk endpoints (state, frame, curtain, end) take the publish ticket as `Authorization: Bearer wpt_…`; the
 * person's own browser uses their session instead. Nothing here ever answers a stream key: an agent row has none.
 */
const express = require('express');
const auth = require('./auth');
const service = require('./service');
const plays = require('./plays');
const sandbox = require('./sandbox');
const tickets = require('./tickets');
const frames = require('./frames');
const steps = require('./steps');
const voice = require('./voice');
const schedules = require('./schedules');

const router = express.Router();

function fail(res, status, code, detail) {
    return res.status(status).json({ error: detail || code, code });
}

function stringOf(value, max) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    return s && s.length <= max ? s : null;
}

function cleanTask(task) {
    if (!task || typeof task !== 'object') return null;
    const source = service.TASK_SOURCES.includes(task.source) ? task.source : null;
    const ref = stringOf(task.ref, 200);
    const title = stringOf(task.title, 200);
    if (!source || !ref || !title) return null;
    const url = task.url == null ? null : (typeof task.url === 'string' && /^https?:\/\//i.test(task.url) && task.url.length <= 2000 ? task.url : undefined);
    if (url === undefined) return null;
    return { source, ref, title, url };
}

function cleanSites(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 50) return null;
    const out = [];
    for (const site of value) {
        if (typeof site !== 'string' || !/^https?:\/\//i.test(site) || site.length > 500) return null;
        out.push(site);
    }
    return out;
}

/** The stream's row for this request's :id, or a 404 already sent. */
async function load(req, res) {
    const row = await service.getByPublicId(req.params.id);
    if (!row) { fail(res, 404, 'agent_stream_not_found', 'No such agent stream'); return null; }
    return row;
}

/** The channel's Chat moderation (the moderators the owner set), cached by the client; [] on any failure. */
async function channelModeration(channelId) {
    try { return await require('../chat/moderation-client').getChannelModeration(Number(channelId) || 0); }
    catch { return { moderator_ids: [] }; }
}

/** The person's role on this stream: the owner, one of its channel's moderators, or null. */
async function roleOn(row, user) {
    if (!user) return null;
    if (Number(user.id) === Number(row.user_id)) return 'owner';
    const moderation = await channelModeration(row.channel_id);
    return moderation.moderator_ids.includes(Number(user.id)) ? 'moderator' : null;
}

/**
 * The desk, or the person: a publish ticket for this stream (state, frame, curtain, end), else the owner's session.
 * A ticket names its stream, so a ticket for another stream is the same as no ticket.
 */
async function deskOrOwner(req, res, next) {
    try {
        const header = String(req.headers.authorization || '');
        const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        if (bearer.startsWith('wpt_')) {
            const ticket = await tickets.findPublish(bearer);
            const row = ticket ? await service.getByManagedStreamId(ticket.managed_stream_id) : null;
            if (!ticket || !row || row.public_id !== req.params.id) return fail(res, 401, 'invalid_ticket', 'The publish ticket is not valid for this stream');
            req.ticket = ticket;
            req.agent = row;
            return next();
        }
        return auth.publisher(req, res, async () => {
            try {
                const row = req.publisher && await service.getByPublicId(req.params.id);
                if (!row) return fail(res, 404, 'agent_stream_not_found', 'No such agent stream');
                if (Number(row.user_id) !== Number(req.publisher.user.id)) return fail(res, 403, 'not_your_stream', 'This agent stream belongs to another account');
                req.agent = row;
                next();
            } catch (err) {
                console.error('[AgentStream] desk auth failed:', err.message);
                fail(res, 500, 'auth_failed', 'The request could not be authorised');
            }
        });
    } catch (err) {
        console.error('[AgentStream] desk ticket failed:', err.message);
        return fail(res, 500, 'auth_failed', 'The request could not be authorised');
    }
}

// ── The public list (the Agents tab and the home row) ─────────
// Public agent streams are open; a channel's own page also shows its private and unlisted cards to the owner. This is
// the S2 list, never mixed into people's streams: the "Agents live" row calls ?live=1.

router.get('/', auth.viewer, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const channel = typeof req.query.channel === 'string' ? req.query.channel.trim().slice(0, 64) : null;
        if (channel) {
            const rows = await service.listForChannel(channel, req.viewer ? req.viewer.id : null);
            const subject = req.viewer ? await auth.viewerSubject(req.viewer) : null;
            const planned = await schedules.listForChannel(channel, req.viewer ? req.viewer.id : null, { subject });
            return res.json({ agents: rows.map(service.cardView), schedules: planned });
        }
        const rows = await service.listPublic({ liveOnly: req.query.live === '1' });
        res.json({ agents: rows.map(service.cardView) });
    } catch (err) {
        console.error('[AgentStream] list failed:', err.message);
        fail(res, 500, 'list_failed', 'The agent streams could not be listed');
    }
});

// ── Create ─────────────────────────────────────────────────────

router.post('/', auth.publisher, async (req, res) => {
    try {
        const body = req.body || {};
        const title = stringOf(body.title, 200);
        const task = cleanTask(body.task);
        const visibility = service.VISIBILITIES.includes(body.visibility) ? body.visibility : null;
        const allowSites = cleanSites(body.allow_sites);
        const copilot = body.copilot === true;
        if (!title) return fail(res, 400, 'invalid_title', 'A title of 1–200 characters is required');
        if (!task) return fail(res, 400, 'invalid_task', 'task needs source (codes, actor, desk, node), ref and title');
        if (!visibility) return fail(res, 400, 'invalid_visibility', 'visibility is private, unlisted or public');
        if (allowSites === null) return fail(res, 400, 'invalid_allow_sites', 'allow_sites is a list of at most 50 http(s) addresses');

        const row = await service.create({ user: req.publisher.user, title, task, visibility, allowSites, copilotReady: copilot });
        const publish = await tickets.issuePublish(row.managed_stream_id);
        const stream = service.publicView(row);
        if (row.unlisted_secret) stream.page_url = `${stream.page_url}?k=${encodeURIComponent(row.unlisted_secret)}`;
        res.status(201).json({ stream, publish: { whip_url: service.whipUrl(row.public_id), ...publish } });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
        console.error('[AgentStream] create failed:', err.message);
        fail(res, 500, 'create_failed', 'The agent stream could not be created');
    }
});

/**
 * Whether this request may see this stream: the owner, a valid view ticket, the unlisted link's secret, a public
 * stream, or the sharing system's answer for a private one. The same rule the page's GET /:id applies.
 */
async function watchable(req, row) {
    if (req.viewer && Number(req.viewer.id) === Number(row.user_id)) return true;
    if (typeof req.query.vt === 'string' && await tickets.findViewById(req.query.vt, row.managed_stream_id)) return true;
    return await service.mayView(row, {
        viewer: req.viewer,
        secret: (req.body && typeof req.body.k === 'string') ? req.body.k : (typeof req.query.k === 'string' ? req.query.k : null),
    });
}


// ── Schedules (S7) ─────────────────────────────────────────────
//
// An owner schedules a public agent stream; the record shows on the channel's Agents tab and in Today 24 hours before
// its time. The desk says it is online with a heartbeat, claims a due schedule and receives the one publish ticket.
// A schedule nobody claims says "didn't start: the desk was offline" and starts nothing. A chatplays schedule waits
// for the owner's Go. Reminders are opt-in and the answer is a count, never a name.

/** POST /desk/heartbeat — the owner's desk says it is online (a fact, not a stream). */
router.post('/desk/heartbeat', auth.publisher, async (req, res) => {
    try {
        const out = await schedules.heartbeat(req.publisher.user, (req.body || {}).version);
        res.set('Cache-Control', 'no-store');
        res.json(out);
    } catch (err) {
        console.error('[AgentStream] desk heartbeat failed:', err.message);
        fail(res, 500, 'heartbeat_failed', 'The heartbeat could not be stored');
    }
});

/** POST /schedules — the owner writes a schedule. */
router.post('/schedules', auth.publisher, async (req, res) => {
    try {
        const body = req.body || {};
        const task = schedules.cleanTask(body.task);
        if (!task) return fail(res, 400, 'invalid_task', 'task needs source (codes, actor, desk, node), ref and title');
        const schedule = await schedules.create({
            user: req.publisher.user,
            title: body.title,
            task,
            mode: body.mode,
            startsAt: body.starts_at,
        });
        res.status(201).json({ schedule });
    } catch (err) {
        if (err.status) return fail(res, err.status, err.code, err.message);
        console.error('[AgentStream] schedule create failed:', err.message);
        fail(res, 500, 'schedule_failed', 'The schedule could not be stored');
    }
});

/** GET /schedules — the caller's own (?mine=1) or a channel's public window (the channel's Agents tab). */
router.get('/schedules', auth.viewer, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const subject = req.viewer ? await auth.viewerSubject(req.viewer) : null;
        if (String(req.query.mine || '') === '1') {
            if (!req.viewer) return res.json({ schedules: [] });
            return res.json({ schedules: await schedules.listMine(req.viewer.id, { subject }) });
        }
        if (String(req.query.public || '') === '1') {
            return res.json({ schedules: await schedules.listPublic({ subject }) });
        }
        const channel = typeof req.query.channel === 'string' ? req.query.channel.trim().slice(0, 64) : null;
        if (!channel) return fail(res, 400, 'channel_required', 'channel is required (or mine=1 or public=1)');
        const viewerId = req.viewer ? req.viewer.id : null;
        const rows = await schedules.listForChannel(channel, viewerId, { subject });
        res.json({ schedules: rows });
    } catch (err) {
        console.error('[AgentStream] schedules read failed:', err.message);
        fail(res, 500, 'schedules_failed', 'The schedules could not be read');
    }
});

/** GET /schedules/:id — one schedule (the owner's own, or a public one inside its 24-hour window). */
router.get('/schedules/:id', auth.viewer, async (req, res) => {
    try {
        const subject = req.viewer ? await auth.viewerSubject(req.viewer) : null;
        const schedule = await schedules.get(req.params.id, { subject });
        if (!schedule) return fail(res, 404, 'schedule_not_found', 'No such schedule');
        const mine = req.viewer && schedule.owner && schedule.owner === subject;
        const soon = schedule.visibility === 'public' && schedule.state === 'scheduled'
            && Date.parse(schedule.starts_at) <= Date.now() + schedules.AHEAD_MS;
        if (!mine && !soon) return fail(res, 404, 'schedule_not_found', 'No such schedule');
        res.set('Cache-Control', 'no-store');
        res.json({ schedule });
    } catch (err) {
        console.error('[AgentStream] schedule read failed:', err.message);
        fail(res, 500, 'schedule_failed', 'The schedule could not be read');
    }
});

/** DELETE /schedules/:id — cancel it. */
router.delete('/schedules/:id', auth.publisher, async (req, res) => {
    try {
        const schedule = await schedules.cancel(req.params.id, req.publisher.user);
        res.json({ schedule });
    } catch (err) {
        if (err.status) return fail(res, err.status, err.code, err.message);
        console.error('[AgentStream] schedule cancel failed:', err.message);
        fail(res, 500, 'schedule_failed', 'The schedule could not be cancelled');
    }
});

/** POST /schedules/:id/remind — opt in to the reminder. The answer is the count, never the people. */
router.post('/schedules/:id/remind', auth.viewer, async (req, res) => {
    try {
        if (!req.viewer) return fail(res, 401, 'authentication_required', 'Sign in to set a reminder');
        const subject = await auth.viewerSubject(req.viewer);
        const out = await schedules.remind(req.params.id, subject);
        res.json(out);
    } catch (err) {
        if (err.status) return fail(res, err.status, err.code, err.message);
        console.error('[AgentStream] schedule reminder failed:', err.message);
        fail(res, 500, 'reminder_failed', 'The reminder could not be set');
    }
});

/** POST /schedules/:id/claim — the owner's online desk starts it: the stream and its one publish ticket. */
router.post('/schedules/:id/claim', auth.publisher, async (req, res) => {
    try {
        const out = await schedules.claim(req.params.id, req.publisher.user, { go: false });
        res.status(201).json(out);
    } catch (err) {
        if (err.status) return fail(res, err.status, err.code, err.message);
        console.error('[AgentStream] schedule claim failed:', err.message);
        fail(res, 500, 'schedule_failed', 'The schedule could not be started');
    }
});

/** POST /schedules/:id/go — the owner's Go for a chatplays schedule; it starts the stream like a claim. */
router.post('/schedules/:id/go', auth.publisher, async (req, res) => {
    try {
        const out = await schedules.claim(req.params.id, req.publisher.user, { go: true });
        res.status(201).json(out);
    } catch (err) {
        if (err.status) return fail(res, err.status, err.code, err.message);
        console.error('[AgentStream] schedule go failed:', err.message);
        fail(res, 500, 'schedule_failed', 'The schedule could not be started');
    }
});

// ── Read ───────────────────────────────────────────────────────

/**
 * GET /mine — the caller's own agent streams (GET / is S2's public list), newest first with the live one at the front, at most 20, and `?live=1` for
 * only the live one. This is the lookup Codes, Actor and the Dock make to find out which stream is the person's ("the
 * signed-in person's own live agent stream", Agent Streams S1: the embed is minted server-side with their token). It is
 * never a directory: no session carries nobody's rows, and another person's stream is never in the answer.
 */
router.get('/mine', auth.viewer, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        if (!req.viewer) return res.json({ streams: [] });
        const onlyLive = String(req.query.live || '') === '1';
        const rows = (await service.listByUser(req.viewer.id))
            .filter((row) => !onlyLive || row.state === 'live')
            .sort((a, b) => ((b.state === 'live') - (a.state === 'live')))
            .slice(0, 20);
        res.json({ streams: rows.map(service.publicView) });
    } catch (err) {
        console.error('[AgentStream] list failed:', err.message);
        fail(res, 500, 'list_failed', 'The agent streams could not be read');
    }
});

router.get('/:id', auth.viewer, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        const isOwner = !!(req.viewer && Number(req.viewer.id) === Number(row.user_id));
        const secret = typeof req.query.k === 'string' ? req.query.k : null;
        const presented = typeof req.query.vt === 'string' ? await tickets.findViewById(req.query.vt, row.managed_stream_id) : null;
        const allowed = isOwner || presented || await service.mayView(row, { viewer: req.viewer, secret });
        if (!allowed) return fail(res, 404, 'agent_stream_not_found', 'No such agent stream');

        const stream = service.publicView(row);
        if (isOwner && row.visibility === 'unlisted' && row.unlisted_secret) stream.page_url = `${stream.page_url}?k=${encodeURIComponent(row.unlisted_secret)}`;
        const view = (isOwner || row.visibility !== 'public')
            ? await tickets.issueView(row.managed_stream_id, {
                subject: req.viewer ? await auth.viewerSubject(req.viewer) : null,
                via: isOwner ? 'owner' : (row.visibility === 'unlisted' ? 'link' : 'share'),
            })
            : null;
        const moderation = await channelModeration(row.channel_id);
        const isMod = !isOwner && !!(req.viewer && moderation.moderator_ids.includes(Number(req.viewer.id)));
        let parties = null;
        try {
            const count = await require('../chat/chat-client').partyCount(row.public_id);
            if (count && Number.isInteger(Number(count.count))) parties = { count: Math.max(0, Number(count.count)) };
        } catch { /* Chat is optional for a stream */ }
        res.json({
            stream,
            parties,
            live_stream_id: row.live_session_id ? Number(row.live_session_id) : null,
            can_manage: isOwner,
            can_moderate: isOwner || isMod,
            paused: !!Number(row.paused),
            paused_by: row.paused_by || null,
            paused_by_role: row.paused_by_role || null,
            copilot_ready: !!Number(row.copilot_ready),
            // The curtain's reason is the owner's alone; the resource itself never carries it.
            ...(isOwner && Number(row.curtain_up) && row.curtain_reason ? { curtain_reason: row.curtain_reason } : {}),
            ...(view ? { view_ticket: view.ticket, view_ticket_expires_at: view.expires_at } : {}),
        });
    } catch (err) {
        console.error('[AgentStream] read failed:', err.message);
        fail(res, 500, 'read_failed', 'The agent stream could not be read');
    }
});

// ── Visibility and the unlisted link ───────────────────────────

router.put('/:id/visibility', auth.publisher, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (Number(row.user_id) !== Number(req.publisher.user.id)) return fail(res, 403, 'not_your_stream', 'This agent stream belongs to another account');
        const visibility = req.body && req.body.visibility;
        if (!service.VISIBILITIES.includes(visibility)) return fail(res, 400, 'invalid_visibility', 'visibility is private, unlisted or public');
        const next = await service.setVisibility(row, visibility);
        const stream = service.publicView(next);
        if (next.unlisted_secret) stream.page_url = `${stream.page_url}?k=${encodeURIComponent(next.unlisted_secret)}`;
        res.json({ stream });
    } catch (err) {
        console.error('[AgentStream] visibility failed:', err.message);
        fail(res, 500, 'visibility_failed', 'The visibility could not be changed');
    }
});

router.post('/:id/rotate-link', auth.publisher, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (Number(row.user_id) !== Number(req.publisher.user.id)) return fail(res, 403, 'not_your_stream', 'This agent stream belongs to another account');
        if (row.visibility !== 'unlisted') return fail(res, 409, 'not_unlisted', 'Only an unlisted stream has a link secret');
        const secret = await service.rotateLink(row);
        const stream = service.publicView(row);
        stream.page_url = `${stream.page_url}?k=${encodeURIComponent(secret)}`;
        res.json({ stream });
    } catch (err) {
        console.error('[AgentStream] rotate link failed:', err.message);
        fail(res, 500, 'rotate_failed', 'The link could not be rotated');
    }
});

// ── The publish ticket ─────────────────────────────────────────

router.post('/:id/ticket', auth.publisher, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (Number(row.user_id) !== Number(req.publisher.user.id)) return fail(res, 403, 'not_your_stream', 'This agent stream belongs to another account');
        if (row.state === 'ended') return fail(res, 409, 'agent_stream_ended', 'This agent stream has ended');
        const publish = await tickets.issuePublish(row.managed_stream_id);
        res.json({ publish: { whip_url: service.whipUrl(row.public_id), ...publish } });
    } catch (err) {
        console.error('[AgentStream] ticket renew failed:', err.message);
        fail(res, 500, 'ticket_failed', 'The publish ticket could not be renewed');
    }
});

router.delete('/:id/ticket', auth.publisher, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (Number(row.user_id) !== Number(req.publisher.user.id)) return fail(res, 403, 'not_your_stream', 'This agent stream belongs to another account');
        await tickets.revokeAll(row.managed_stream_id);
        // The kill switch: the desk loses its session now, never at its next renewal.
        const current = await service.getByManagedStreamId(row.managed_stream_id);
        await service.end(current, { reason: 'ticket_revoked' });
        res.json({ ok: true, stream: service.publicView(await service.getByManagedStreamId(row.managed_stream_id)) });
    } catch (err) {
        console.error('[AgentStream] ticket revoke failed:', err.message);
        fail(res, 500, 'revoke_failed', 'The publish ticket could not be revoked');
    }
});

// ── What the desk reads and sends ──────────────────────────────

router.get('/:id/state', deskOrOwner, async (req, res) => {
    try {
        const row = req.agent;
        const encode = row.visibility === 'public' || service.viewersNow(row.live_session_id) > 0;
        res.set('Cache-Control', 'no-store');
        res.json({
            viewers: service.viewersNow(row.live_session_id),
            encode,
            mode: row.mode,
            paused: !!Number(row.paused),
            paused_by: row.paused_by || null,
            paused_by_role: row.paused_by_role || null,
            curtain: {
                up: !!Number(row.curtain_up),
                since: Number(row.curtain_up) ? service.iso(row.curtain_since) : null,
                ...(Number(row.curtain_up) && row.curtain_reason ? { reason: row.curtain_reason } : {}),
            },
            ends_at: service.iso(await tickets.currentExpiry(row.managed_stream_id)),
            // S4: the lines the desk has not read yet (it polls with the last id it spoke), and the voice it speaks
            // them in. The state contract's v2 shape carries both; Live never mixes the audio, the desk does.
            lines: await voice.linesAfter(row.managed_stream_id, req.query.after, 20),
            voice: voice.voiceState(row),
            // S4: where the recording's captions live, so a VOD player can attach the WebVTT as a text track.
            captions_url: voice.captionsUrl(row),
        });
    } catch (err) {
        console.error('[AgentStream] state failed:', err.message);
        fail(res, 500, 'state_failed', 'The state could not be read');
    }
});

router.put('/:id/frame', deskOrOwner, express.raw({ type: ['image/jpeg', 'image/webp'], limit: service.MAX_FRAME_BYTES }), async (req, res) => {
    try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) return fail(res, 415, 'frame_not_an_image', 'Send the frame as image/jpeg or image/webp');
        if (req.body.length > service.MAX_FRAME_BYTES) return fail(res, 413, 'frame_too_large', 'A frame is at most 200 KB');
        if (!await service.setFrame(req.agent, req.body)) return fail(res, 415, 'frame_not_an_image', 'Send the frame as JPEG or WebP');
        res.status(204).end();
    } catch (err) {
        console.error('[AgentStream] frame failed:', err.message);
        fail(res, 500, 'frame_failed', 'The frame could not be stored');
    }
});

router.get('/:id/frame', auth.viewer, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        const isOwner = !!(req.viewer && Number(req.viewer.id) === Number(row.user_id));
        const ticket = typeof req.query.vt === 'string' ? await tickets.findViewById(req.query.vt, row.managed_stream_id) : null;
        const allowed = isOwner || ticket || await service.mayView(row, { viewer: req.viewer, secret: typeof req.query.k === 'string' ? req.query.k : null });
        if (!allowed) return fail(res, 404, 'agent_stream_not_found', 'No such agent stream');
        const picture = row.last_frame_path ? await frames.read(row.last_frame_path) : null;
        if (!picture) return fail(res, 404, 'no_frame', 'The desk has not sent a frame yet');
        res.set('Content-Type', picture.type);
        res.set('Cache-Control', 'no-store');
        res.set('ETag', `"${service.sha256(picture.bytes).slice(0, 32)}"`);
        res.send(picture.bytes);
    } catch (err) {
        console.error('[AgentStream] frame read failed:', err.message);
        fail(res, 500, 'frame_read_failed', 'The frame could not be read');
    }
});

router.post('/:id/curtain', deskOrOwner, async (req, res) => {
    try {
        const body = req.body || {};
        if (typeof body.up !== 'boolean') return fail(res, 400, 'invalid_curtain', 'up is true or false');
        const reason = service.CURTAIN_REASONS.includes(body.reason) ? body.reason : 'detector';
        const row = await service.setCurtain(req.agent, body.up, reason);
        // The consumers are paused/resumed by the SFU, and every player learns the screen is private (never why).
        try { require('../streaming/curtains').apply(row.live_session_id); } catch (err) { console.warn('[AgentStream] curtain apply:', err.message); }
        res.json({ curtain: { up: !!Number(row.curtain_up), since: service.iso(row.curtain_since) } });
    } catch (err) {
        console.error('[AgentStream] curtain failed:', err.message);
        fail(res, 500, 'curtain_failed', 'The curtain could not be set');
    }
});

router.post('/:id/end', deskOrOwner, async (req, res) => {
    try {
        const row = await service.end(req.agent, { reason: req.ticket ? 'desk_ended' : 'owner_ended' });
        res.json({ stream: service.publicView(row) });
    } catch (err) {
        console.error('[AgentStream] end failed:', err.message);
        fail(res, 500, 'end_failed', 'The stream could not be ended');
    }
});

// ── The chat plays mode (S6) ───────────────────────────────────────

/**
 * PUT /:id/plays — the owner's controls on the owner page: the time box (5 to 30 minutes), the cap (money) and
 * Go. Go arms the session once: the first request of a session waits for it. The owner may change the time box
 * and the cap at any time; a new Go after a Wipe now arms the session again.
 */
router.put('/:id/plays', auth.publisher, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (Number(row.user_id) !== Number(req.publisher.user.id)) return fail(res, 403, 'not_your_stream', 'This agent stream belongs to another account');
        const body = req.body || {};
        const set = {};
        if (body.time_box_minutes !== undefined) {
            const box = plays.cleanTimeBox(body.time_box_minutes);
            if (box === null) return fail(res, 400, 'invalid_time_box', 'The time box is 5 to 30 minutes');
            set.plays_time_box_minutes = box;
        }
        if (body.cap_cents !== undefined) {
            const cap = plays.cleanCap(body.cap_cents);
            if (cap === null) return fail(res, 400, 'invalid_cap', 'That cap is not a number');
            set.plays_cap_cents = cap;
        }
        if (body.go === true) {
            // Go arms the session: it waits for a sandbox worker, like the mode does.
            const worker = await sandbox.workerFor(row.owner_subject);
            if (!worker.ok) return fail(res, 409, 'chatplays_needs_sandbox_worker', worker.reason);
            set.plays_armed_at = new Date();
        }
        if (!Object.keys(set).length) return fail(res, 400, 'nothing_to_change', 'Nothing to change');
        const next = await service.update(row, { set });
        res.set('Cache-Control', 'no-store');
        res.json({ plays: plays.playsState(next) });
    } catch (err) {
        console.error('[AgentStream] the plays settings failed:', err.message);
        fail(res, 500, 'plays_settings_failed', 'The chat plays settings could not be saved');
    }
});

/**
 * POST /:id/plays/queue — the desk reports the queue it works: the requests with their votes and the current
 * one. Live keeps the last report and the overlay draws its top three.
 */
router.post('/:id/plays/queue', deskOrOwner, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        const next = await service.update(row, { set: { plays_queue: plays.cleanQueue(req.body || {}) } });
        res.set('Cache-Control', 'no-store');
        res.json({ plays: plays.playsState(next), top: plays.queueTop(next, 3) });
    } catch (err) {
        console.error('[AgentStream] the queue report failed:', err.message);
        fail(res, 500, 'plays_queue_failed', 'The queue could not be reported');
    }
});

/**
 * POST /:id/plays/worker — the sandbox worker checks in for the stream's owner. The publish ticket (or the
 * owner's session) names the stream, so the worker is registered for that owner and for nobody else.
 * GET  /:id/plays/worker — what the owner page shows: is there a worker, and is it healthy?
 */
router.post('/:id/plays/worker', auth.sandboxRegistrar, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        // The worker says whose sandbox it is, and it must be this stream's owner: a worker registered for
        // somebody else does not make this stream safe to run in.
        if (String(row.owner_subject || '') !== String(req.sandboxWorker.subject)) {
            return fail(res, 403, 'sandbox_worker.not_yours', 'This worker works for another account');
        }
        const body = req.body || {};
        const out = await sandbox.checkIn({
            subject: row.owner_subject,
            service: req.sandboxWorker.service,
            isolation: body.isolation || null,
        });
        if (!out.ok) {
            return fail(res, 422, out.code, 'A worker that cannot say it is isolated is not registered');
        }
        res.set('Cache-Control', 'no-store');
        res.json({ worker: await sandbox.state(row.owner_subject) });
    } catch (err) {
        console.error('[AgentStream] the worker check-in failed:', err.message);
        fail(res, 500, 'plays_worker_failed', 'The worker could not check in');
    }
});

router.get('/:id/plays/queue', auth.viewer, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (!await watchable(req, row)) return fail(res, 404, 'agent_stream_not_found', 'No such agent stream');
        // The queue the desk reported: the current request with who asked for it, and the next three with
        // their votes. The overlay draws this; it is the room's own business, so it is what the viewers see.
        const top = plays.queueTop(row, 3);
        res.set('Cache-Control', 'no-store');
        res.json({ queue: top });
    } catch (err) {
        console.error('[AgentStream] the queue read failed:', err.message);
        fail(res, 500, 'plays_queue_failed', 'The queue could not be read');
    }
});

router.get('/:id/plays/worker', auth.publisher, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (Number(row.user_id) !== Number(req.publisher.user.id)) return fail(res, 403, 'not_your_stream', 'This agent stream belongs to another account');
        res.set('Cache-Control', 'no-store');
        res.json({ worker: await sandbox.state(row.owner_subject) });
    } catch (err) {
        console.error('[AgentStream] the worker state failed:', err.message);
        fail(res, 500, 'plays_worker_failed', 'The worker state could not be read');
    }
});

// ── The four controls (S5) ────────────────────────────────────

/**
 * POST /:id/control — pause (paused true/false), curtain (up true/false), mute (muted true/false) or end, pressed by
 * the owner or the channel's moderators. A moderator may not resume a pause the owner set, and every press is logged
 * with who pressed it. `end` ends the stream and stops the room's Co-pilot reading; the task keeps running off
 * camera.
 */
router.post('/:id/control', auth.viewer, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (req.viewer && req.viewer.is_banned) return fail(res, 403, 'user_banned', 'A banned account cannot press a control');
        const role = await roleOn(row, req.viewer);
        if (!role) return fail(res, 403, 'not_moderator', 'Only the owner or a channel moderator may press this');
        const body = req.body || {};
        const control = (service.CONTROLS.includes(body.control) || body.control === 'wipe') ? body.control : null;
        if (!control) return fail(res, 400, 'invalid_control', 'control is pause, curtain, mute, end or wipe');
        const handle = String(req.viewer.username || '').toLowerCase().slice(0, 32);
        if (!/^[a-z0-9_]{2,32}$/.test(handle)) return fail(res, 409, 'no_handle', 'This account has no handle to log');
        const by = { handle, role };
        let next = row;
        let paused = null;
        if (control === 'pause') {
            const want = body.paused === undefined ? !Number(row.paused) : !!body.paused;
            const r = await service.setPaused(row, { paused: want, by });
            if (!r.allowed) return fail(res, 403, 'owner_pause', 'A moderator cannot resume a pause the owner set');
            next = r.row;
            paused = !!Number(next.paused);
        } else if (control === 'curtain') {
            const up = body.up === undefined ? !Number(row.curtain_up) : !!body.up;
            next = await service.setCurtain(row, up, 'manual');
            try { require('../streaming/curtains').apply(next.live_session_id); } catch { /* no SFU in a test */ }
        } else if (control === 'mute') {
            const muted = body.muted === undefined ? !Number(row.voice_muted) : !!body.muted;
            next = await service.update(row, { set: { voice_muted: !!muted } });
        } else if (control === 'end') {
            next = await service.end(row, { reason: `ended_by_${role}` });
        } else if (control === 'wipe') {
            // S6: Wipe now stops the run and resets the sandbox. The desk reads it in the state it polls.
            next = await service.update(row, { set: { plays_wiped_at: new Date() } });
        }
        await require('../db/database').run(
            `INSERT INTO agent_stream_controls (managed_stream_id, control, by_handle, by_role, paused, paused_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [row.managed_stream_id, control, handle, role, control === 'pause' ? paused : null,
                control === 'pause' ? (paused ? handle : null) : (Number(next.paused) ? next.paused_by : null)]
        );
        res.set('Cache-Control', 'no-store');
        res.json({
            control: { control, by, at: new Date().toISOString(), stream: row.public_id, paused_by: Number(next.paused) ? next.paused_by : null },
            paused: !!Number(next.paused), paused_by: next.paused_by || null,
            curtain: { up: !!Number(next.curtain_up) },
            muted: !!Number(next.voice_muted),
            state: next.state,
        });
    } catch (err) {
        console.error('[AgentStream] control failed:', err.message);
        fail(res, 500, 'control_failed', 'The control could not be pressed');
    }
});

/**
 * GET /:id/controls — what the owner (and a moderator) pressed, newest first. `live` is the pause in force, so the
 * page and a task's service can read it without the log.
 */
router.get('/:id/controls', auth.viewer, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (req.viewer && req.viewer.is_banned) return fail(res, 403, 'user_banned', 'A banned account cannot read the controls');
        const role = await roleOn(row, req.viewer);
        if (!role) return fail(res, 403, 'not_moderator', 'Only the owner or a channel moderator may read this');
        const rows = await require('../db/database').all(
            `SELECT control, by_handle, by_role, paused, paused_by, at FROM agent_stream_controls
              WHERE managed_stream_id = ? ORDER BY id DESC LIMIT 50`, [row.managed_stream_id]);
        res.set('Cache-Control', 'no-store');
        res.json({
            controls: rows.map((r) => ({
                control: r.control,
                by: { handle: r.by_handle, role: r.by_role },
                at: service.iso(r.at),
                stream: row.public_id,
                paused_by: r.paused_by || null,
            })),
            live: { paused: !!Number(row.paused), paused_by: row.paused_by || null, paused_by_role: row.paused_by_role || null },
        });
    } catch (err) {
        console.error('[AgentStream] controls read failed:', err.message);
        fail(res, 500, 'controls_failed', 'The controls could not be read');
    }
});

// ── Steps, chapters and one-tap clips (S2) ─────────────────────

// The steps the overlay draws. `after=<id>` returns only what is newer (the page's live poll); otherwise the newest 20
// are answered oldest first. A viewer follows the same rule as the page, so a private stream's steps stay private.
router.get('/:id/steps', auth.viewer, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (!await watchable(req, row)) return fail(res, 404, 'agent_stream_not_found', 'No such agent stream');
        const after = req.query.after;
        const stepsOut = after !== undefined
            ? await steps.after(row.managed_stream_id, after, 50)
            : await steps.recent(row.managed_stream_id, req.query.limit || 20);
        res.set('Cache-Control', 'no-store');
        res.json({ steps: stepsOut });
    } catch (err) {
        console.error('[AgentStream] steps read failed:', err.message);
        fail(res, 500, 'steps_failed', 'The steps could not be read');
    }
});

// A step is posted by the desk (publish ticket) or by the person's own session; Codes and Actor use their service
// token with live.agent_stream.publish, which auth.publisher already accepts. The limits are the design's.
router.post('/:id/steps', deskOrOwner, async (req, res) => {
    try {
        const step = await steps.add(req.agent, req.body || {});
        // S4: in narrated mode the voice writes a line about this step. A refused line (the house filters) or a spent
        // allowance is silent, never an error: the step itself is what the caller came for.
        try { await voice.writer.onStep(req.agent, step); } catch (err) { console.warn('[AgentStream] voice line failed:', err.message); }
        res.status(201).json({ step });
    } catch (err) {
        if (err && err.status) return fail(res, err.status, err.code, err.message);
        console.error('[AgentStream] step failed:', err.message);
        fail(res, 500, 'step_failed', 'The step could not be stored');
    }
});

// The recording's chapters: every step that started, at its offset from the stream's start.
router.get('/:id/chapters', auth.viewer, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (!await watchable(req, row)) return fail(res, 404, 'agent_stream_not_found', 'No such agent stream');
        const out = await steps.chapters(row);
        res.set('Cache-Control', 'no-store');
        res.json(out);
    } catch (err) {
        console.error('[AgentStream] chapters failed:', err.message);
        fail(res, 500, 'chapters_failed', 'The chapters could not be read');
    }
});

// One tap: a failed step, or the final passed one, becomes a clip through Media's own clip tools. Only a signed-in
// viewer who may watch the recording can ask, and the window comes from the step (five seconds before, fifteen after).
router.post('/:id/clips', auth.viewer, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (!req.viewer) return fail(res, 401, 'authentication_required', 'Sign in to clip a step');
        if (!await watchable(req, row)) return fail(res, 404, 'agent_stream_not_found', 'No such agent stream');
        if (!row.vod_id) return fail(res, 409, 'no_recording', 'This stream has no recording to clip');
        const window = await steps.clipWindow(row, req.body && req.body.step_id);
        const step = window.step;
        if (step.status !== 'failed' && step.status !== 'passed') {
            return fail(res, 409, 'not_clippable', 'Only a failed step or the final passed one can be clipped');
        }
        if (step.status === 'passed') {
            const later = await require('../db/database').get('SELECT id FROM agent_stream_steps WHERE managed_stream_id = ? AND id > ? LIMIT 1', [row.managed_stream_id, step.id]);
            if (later) return fail(res, 409, 'not_final', 'Only the final passed step can be clipped');
        }
        const media = require('../media-client');
        const made = await media.createClip({
            vod_id: row.vod_id,
            start_s: window.start_s,
            end_s: window.end_s,
            title: String(step.title).slice(0, 120),
            user_id: req.viewer.id,
        }).catch((err) => { throw Object.assign(new Error(err.message || 'Media refused the clip'), { status: 502, code: 'clip_failed' }); });
        res.status(201).json({ clip: made });
    } catch (err) {
        if (err && err.status) return fail(res, err.status, err.code, err.message);
        console.error('[AgentStream] clip failed:', err.message);
        fail(res, 500, 'clip_failed', 'The clip could not be made');
    }
});

// ── View tickets ───────────────────────────────────────────────

router.post('/:id/view-ticket', auth.viewer, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        const secret = (req.body && typeof req.body.k === 'string') ? req.body.k : (typeof req.query.k === 'string' ? req.query.k : null);
        const isOwner = !!(req.viewer && Number(req.viewer.id) === Number(row.user_id));
        // A page renews with the ticket it holds, before it expires, while the renewal chain lasts (four hours).
        const renewal = (req.body && typeof req.body.renew === 'string') ? req.body.renew : (typeof req.query.renew === 'string' ? req.query.renew : null);
        const previous = renewal ? await tickets.findViewById(renewal, row.managed_stream_id) : null;
        if (!isOwner && !previous) {
            const allowed = await service.mayView(row, { viewer: req.viewer, secret });
            if (!allowed) return fail(res, 403, 'view_not_allowed', 'This stream is not shared with you');
        }
        const view = await tickets.issueView(row.managed_stream_id, {
            subject: req.viewer ? await auth.viewerSubject(req.viewer) : null,
            via: isOwner ? 'owner' : (row.visibility === 'unlisted' ? 'link' : 'share'),
            renewsUntil: previous ? previous.renews_until : null,
        });
        res.json(view);
    } catch (err) {
        console.error('[AgentStream] view ticket failed:', err.message);
        fail(res, 500, 'view_ticket_failed', 'A view ticket could not be minted');
    }
});

/**
 * POST /:id/copilot — the task's service declares whether it can read the room's digest (Codes and Actor do). The
 * owner's mode switch then allows Co-pilot on a public or unlisted stream.
 */
router.post('/:id/copilot', deskOrOwner, async (req, res) => {
    try {
        const body = req.body || {};
        if (typeof body.ready !== 'boolean') return fail(res, 400, 'invalid_ready', 'ready is true or false');
        const next = await service.setCopilotReady(req.agent, body.ready);
        res.json({ copilot_ready: !!Number(next.copilot_ready), mode: next.mode });
    } catch (err) {
        console.error('[AgentStream] copilot ready failed:', err.message);
        fail(res, 500, 'copilot_failed', 'The Co-pilot state could not be set');
    }
});

// ── The agent's voice (S4) ───────────────────────────────────

// The owner chooses the mode (Watch or Narrated), the voice, the personality and the mute; a channel moderator can
// mute it too. A cloned voice is the person's own and only with their explicit opt-in, so `own` needs `own_consent`.
// The lines themselves are read by the desk (the state poll) and shown to the page as captions.
function cleanVoiceId(value) {
    if (value === null || value === '') return null;
    if (typeof value !== 'string') return undefined;
    const id = value.trim();
    return /^[A-Za-z0-9_.:-]{1,64}$/.test(id) ? id : undefined;
}

// The voice state: the mode, the personality, the voice, the mute and (when the allowance ran out) the message.
router.get('/:id/voice', auth.viewer, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (!await watchable(req, row)) return fail(res, 404, 'agent_stream_not_found', 'No such agent stream');
        res.set('Cache-Control', 'no-store');
        res.json({ voice: voice.voiceState(row) });
    } catch (err) {
        console.error('[AgentStream] voice read failed:', err.message);
        fail(res, 500, 'voice_failed', 'The voice could not be read');
    }
});

router.put('/:id/voice', auth.publisher, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (Number(row.user_id) !== Number(req.publisher.user.id)) return fail(res, 403, 'not_your_stream', 'This agent stream belongs to another account');
        const body = req.body || {};
        const set = {};
        if (body.mode !== undefined) {
            if (!['watch', 'narrated', 'copilot', 'chatplays'].includes(body.mode)) return fail(res, 400, 'invalid_mode', 'mode is watch, narrated, copilot or chatplays');
            if (body.mode === 'chatplays') {
                // Chat plays needs a sandbox worker: a request runs in a network-isolated worker, not in the
                // owner's own Codes worker, Node or desk. There is no such worker yet, so the mode is refused.
                const worker = await sandbox.workerFor(row.owner_subject);
                if (!worker.ok) return fail(res, 409, 'chatplays_needs_sandbox_worker', worker.reason);
                if (!['public', 'unlisted'].includes(row.visibility)) return fail(res, 422, 'chatplays_needs_public', 'Chat plays needs a public or unlisted stream');
                if (!Number(row.copilot_ready)) return fail(res, 422, 'chatplays_not_ready', "This task's service cannot work the queue yet");
                if (!Number(row.plays_cap_cents)) return fail(res, 422, 'chatplays_needs_budget', 'Chat plays needs a budget: set the cap first');
            }
            if (body.mode === 'copilot') {
                // Co-pilot needs a public or unlisted stream and a task's service that can read a digest.
                if (!['public', 'unlisted'].includes(row.visibility)) return fail(res, 422, 'copilot_needs_public', 'Co-pilot needs a public or unlisted stream');
                if (!Number(row.copilot_ready)) return fail(res, 422, 'copilot_not_ready', "This task's service cannot read a digest yet");
            }
            set.mode = body.mode;
        }
        if (body.personality !== undefined) {
            if (!voice.PERSONALITIES.includes(body.personality)) return fail(res, 400, 'invalid_personality', 'personality is calm, hype, dry or roast');
            set.personality = body.personality;
        }
        if (body.voice !== undefined) {
            const id = cleanVoiceId(body.voice);
            if (id === undefined) return fail(res, 400, 'invalid_voice', 'That voice name is not allowed');
            set.voice = id;
        }
        if (body.own !== undefined) {
            const own = !!body.own;
            // The person's own cloned voice: only with their explicit opt-in, and the moment they said yes is kept.
            if (own && body.own_consent !== true) return fail(res, 422, 'own_voice_needs_consent', 'Your own cloned voice needs your consent');
            set.voice_own = own;
            set.voice_own_consent_at = own ? new Date() : null;
        }
        if (body.muted !== undefined) set.voice_muted = !!body.muted;
        if (!Object.keys(set).length) return fail(res, 400, 'nothing_to_change', 'Nothing to change');
        // A new choice gets a new try at the allowance: the pause was about the old one.
        if (set.mode || set.personality || set.voice) set.voice_paused = null;
        const next = await service.update(row, { set });
        res.json({ voice: voice.voiceState(next) });
    } catch (err) {
        console.error('[AgentStream] voice settings failed:', err.message);
        fail(res, 500, 'voice_settings_failed', 'The voice settings could not be saved');
    }
});

// The mute: the owner's kill switch, and a channel moderator's. It takes effect within a second (the desk checks
// it on every poll and stops speaking at once).
router.post('/:id/voice/mute', auth.viewer, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        const body = req.body || {};
        if (typeof body.muted !== 'boolean') return fail(res, 400, 'invalid_muted', 'muted is true or false');
        const isOwner = !!(req.viewer && Number(req.viewer.id) === Number(row.user_id));
        let allowed = isOwner;
        if (!allowed) {
            const permissions = require('../auth/permissions');
            allowed = await permissions.canModerateChannel(req.viewer, row.channel_id);
        }
        if (!allowed) return fail(res, 403, 'cannot_mute_voice', 'You cannot mute this voice');
        const next = await service.update(row, { set: { voice_muted: body.muted } });
        res.json({ voice: voice.voiceState(next) });
    } catch (err) {
        console.error('[AgentStream] voice mute failed:', err.message);
        fail(res, 500, 'voice_mute_failed', 'The voice could not be muted');
    }
});

// The lines the page draws as captions (the desk has its own copy in the state poll).
router.get('/:id/lines', auth.viewer, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (!await watchable(req, row)) return fail(res, 404, 'agent_stream_not_found', 'No such agent stream');
        const lines = await voice.linesAfter(row.managed_stream_id, req.query.after, 50);
        res.set('Cache-Control', 'no-store');
        res.json({ lines, voice: voice.voiceState(row) });
    } catch (err) {
        console.error('[AgentStream] lines read failed:', err.message);
        fail(res, 500, 'lines_failed', 'The lines could not be read');
    }
});

// The recording's captions as WebVTT: the same lines, timed from the start of the stream.
router.get('/:id/captions.vtt', auth.viewer, async (req, res) => {
    try {
        const row = await load(req, res);
        if (!row) return;
        if (!await watchable(req, row)) return fail(res, 404, 'agent_stream_not_found', 'No such agent stream');
        const cues = await voice.captions(row.managed_stream_id, row.started_at);
        res.set('Content-Type', 'text/vtt; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        res.send(voice.webvtt(cues));
    } catch (err) {
        console.error('[AgentStream] captions failed:', err.message);
        fail(res, 500, 'captions_failed', 'The captions could not be read');
    }
});

module.exports = router;
