'use strict';
/**
 * OpenRe ingest switch — Live-side schema (roadmap Wave 7, ADR-009). Additive and idempotent:
 *
 *   managed_streams.ingest_authority  'live' (default) | 'openre'   who ingests RTMP for this slot
 *   managed_streams.openre_stream_id  the OpenRe stream definition serving the slot (std_…)
 *   openre_sessions                   Live's projection of OpenRe ingest sessions it mirrors into
 *                                     `streams` (rebuilt from openre.session.* events; the
 *                                     revision guard makes out-of-order delivery harmless)
 *
 * With every slot on 'live' (the default) nothing reads these columns differently from before.
 */
function ensure(db) {
    const cols = db.prepare('PRAGMA table_info(managed_streams)').all().map(c => c.name);
    if (cols.length && !cols.includes('ingest_authority')) {
        db.exec("ALTER TABLE managed_streams ADD COLUMN ingest_authority TEXT NOT NULL DEFAULT 'live'");
    }
    if (cols.length && !cols.includes('openre_stream_id')) {
        db.exec('ALTER TABLE managed_streams ADD COLUMN openre_stream_id TEXT DEFAULT NULL');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS openre_sessions (
        session_id        TEXT PRIMARY KEY,
        managed_stream_id INTEGER,
        stream_id         INTEGER,
        state             TEXT NOT NULL,
        revision          INTEGER NOT NULL DEFAULT 0,
        started_at        DATETIME,
        ended_at          DATETIME,
        confirmed_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_openre_sessions_stream ON openre_sessions(stream_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_openre_sessions_state ON openre_sessions(state)');
}

module.exports = { ensure };
