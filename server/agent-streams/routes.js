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
const tickets = require('./tickets');
const frames = require('./frames');
const steps = require('./steps');

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
            return res.json({ agents: rows.map(service.cardView) });
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
        if (!title) return fail(res, 400, 'invalid_title', 'A title of 1–200 characters is required');
        if (!task) return fail(res, 400, 'invalid_task', 'task needs source (codes, actor, desk, node), ref and title');
        if (!visibility) return fail(res, 400, 'invalid_visibility', 'visibility is private, unlisted or public');
        if (allowSites === null) return fail(res, 400, 'invalid_allow_sites', 'allow_sites is a list of at most 50 http(s) addresses');

        const row = await service.create({ user: req.publisher.user, title, task, visibility, allowSites });
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

// ── Read ───────────────────────────────────────────────────────

/**
 * GET / — the caller's own agent streams, newest first with the live one at the front, at most 20, and `?live=1` for
 * only the live one. This is the lookup Codes, Actor and the Dock make to find out which stream is the person's ("the
 * signed-in person's own live agent stream", Agent Streams S1: the embed is minted server-side with their token). It is
 * never a directory: no session carries nobody's rows, and another person's stream is never in the answer.
 */
router.get('/', auth.viewer, async (req, res) => {
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
        res.json({
            stream,
            live_stream_id: row.live_session_id ? Number(row.live_session_id) : null,
            can_manage: isOwner,
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
            curtain: {
                up: !!Number(row.curtain_up),
                since: Number(row.curtain_up) ? service.iso(row.curtain_since) : null,
                ...(Number(row.curtain_up) && row.curtain_reason ? { reason: row.curtain_reason } : {}),
            },
            ends_at: service.iso(await tickets.currentExpiry(row.managed_stream_id)),
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

module.exports = router;
