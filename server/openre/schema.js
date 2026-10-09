'use strict';
/**
 * OpenRestream ingest switch — Live-side schema (roadmap Wave 7, ADR-009).
 *
 * The schema this module used to create at boot now lives in migrations/0002_live.sql, which owns every table
 * and column (the production runtime role cannot run DDL):
 *
 *   managed_streams.ingest_authority  'live' (default) | 'openre'   who ingests RTMP for this slot
 *   managed_streams.openre_stream_id  the OpenRestream stream definition serving the slot (std_…)
 *   openre_sessions                   Live's projection of OpenRestream ingest sessions it mirrors into
 *                                     `streams` (rebuilt from openre.session.* events; the
 *                                     revision guard makes out-of-order delivery harmless)
 *
 * With every slot on 'live' (the default) nothing reads these columns differently from before.
 */
module.exports = {};
