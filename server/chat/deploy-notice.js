'use strict';
// ═══════════════════════════════════════════════════════════════
// Deploy notices in chat — one tidy, rolling message instead of a line per restart.
//
// Only commits that were never announced are announced (site setting `deploy_last_announced`); a
// restart with no new code says nothing. The deploy is a durable OpenVibe.Events event,
// live.release.deployed (server/events/release-events.js), queued in the SAME transaction that
// records the commits as announced. OpenVibe.Chat consumes that event, stores the rolling message
// (folding consecutive deploys into ONE row by head commit — compatibility register C-84, proven on
// the 2026-09-23 22:14 UTC deploy) and broadcasts the card. With Events publishing off there is no
// other way to Chat (its ingress has no deploy endpoint), so the commits stay unannounced and the
// next boot tries again.
// ═══════════════════════════════════════════════════════════════
const { execFile } = require('child_process');
const path = require('path');

const REPO_DIR = path.join(__dirname, '..', '..');
const SETTING = 'deploy_last_announced';
const MAX_COMMITS = 40;

const git = (args, timeout = 5000) => new Promise((resolve) => {
    // -c safe.directory=*: the release layout's worktrees are root-owned and the service user only reads them.
    execFile('git', ['-c', 'safe.directory=*', ...args], { cwd: REPO_DIR, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out || '')));
});

const parseLog = (raw) => raw.trim().split('\n').filter(Boolean).map((line) => {
    const [hash, short, date, ...rest] = line.split('\x1f');
    return { hash, short, date, subject: rest.join(' ').trim().slice(0, 200) };
}).filter(c => /^[0-9a-f]{40}$/.test(c.hash || ''));

/** Commits on HEAD that have not been announced yet (newest first). */
async function newCommits(db) {
    const head = (await git(['rev-parse', 'HEAD'], 3000)).trim();
    if (!/^[0-9a-f]{40}$/.test(head)) return { head: '', previous: null, commits: [] };
    const last = String(db.getSetting(SETTING) || '').trim();
    const previous = /^[0-9a-f]{40}$/.test(last) ? last : null;
    if (last === head) return { head, previous, commits: [] };
    const fmt = '--pretty=format:%H%x1f%h%x1f%aI%x1f%s';
    let raw = '';
    if (/^[0-9a-f]{40}$/.test(last)) raw = await git(['--no-pager', 'log', fmt, '-n', String(MAX_COMMITS), `${last}..${head}`]);
    // First run, or history was rewritten: announce the current commit only, never a backlog.
    if (!raw.trim()) raw = await git(['--no-pager', 'log', fmt, '-n', '1', head]);
    return { head, previous, commits: parseLog(raw) };
}

/**
 * Announce this boot's new commits. Safe to call once after boot.
 * @returns {Promise<{ announced: number, event_id?: string|null }>}
 */
async function announce({ db, log = console }) {
    const { head, previous, commits } = await newCommits(db);
    if (!head || !commits.length) return { announced: 0 };

    // Live's outbox exists before the transaction (idempotent; null while Events is off).
    let outbox = null;
    try { outbox = require('../events/stream-events'); if (!outbox.init()) outbox = null; } catch (err) { log.warn('[Deploy notice] Events outbox unavailable:', err.message); outbox = null; }
    let eventId = null;
    // Recording the commits as announced and queueing live.release.deployed are one commit: the
    // event exists if and only if this deploy counts as announced.
    const recordDeploy = () => {
        db.setSetting(SETTING, head);
        if (outbox) {
            const env = require('../events/release-events').record({ head, previous, commits });
            eventId = env ? env.event_id : null;
        }
    };
    const inTransaction = (fn) => db.getDb().tx(fn);

    // Live still decides what shipped; OpenVibe.Chat stores the rolling message and shows it (its
    // own copy of this module). It learns the commits from the live.release.deployed event only.
    // Chat's ingress has no deploy endpoint: with Events publishing off the commits are not
    // recorded as announced and the next boot tries again (OpenVibe.Chat docs/chat-ingress.md).
    if (!outbox) { log.warn('[Deploy notice] Events outbox unavailable; left unannounced for the next boot'); return { announced: 0, event_id: null }; }
    try { inTransaction(recordDeploy); } catch (err) { log.warn('[Deploy notice] not recorded:', err.message); return { announced: 0, event_id: null }; }
    outbox.kick();
    return { announced: commits.length, event_id: eventId };
}

module.exports = { announce, newCommits, parseLog, SETTING };
