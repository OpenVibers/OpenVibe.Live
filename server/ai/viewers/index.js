/**
 * AI Chat Viewers — engine selector.
 * site_settings.ai_viewers_engine ('v2' | 'v3') picks the default; a channel can override
 * with settings_json.engine. Both engines expose the same lifecycle surface, so the rest
 * of the server (go-live hooks, chat hook, routes) never cares which one is running.
 */
'use strict';
const db = require('../../db/database');

function _v2() { return require('./engine'); }
function _v3() { return require('./v3/engine'); }

function engineForUser(userId) {
    let override = '';
    try { override = (JSON.parse(db.getChannelAiConfig(userId).settings_json || '{}') || {}).engine || ''; } catch { /* */ }
    const site = String(db.getSetting('ai_viewers_engine') || 'v2');
    return (override || site) === 'v3' ? _v3() : _v2();
}
function engineForStream(streamId) {
    if (_v3().hasWorker(streamId)) return _v3();
    if (_v2().hasWorker(streamId)) return _v2();
    return null;
}

module.exports = {
    get version() { return String(db.getSetting('ai_viewers_engine') || 'v2'); },
    engineForUser,
    hasWorker(streamId) { return !!engineForStream(streamId); },
    startForStream(stream) { if (!stream || !stream.user_id) return; return engineForUser(stream.user_id).startForStream(stream); },
    stopForStream(streamId) { const e = engineForStream(streamId); if (e) return e.stopForStream(streamId); },
    stopForUser(userId) { _v2().stopForUser(userId); _v3().stopForUser(userId); },
    applyConfigForUser(userId) {
        // If the channel switched engines, stop the other one first.
        const want = engineForUser(userId);
        const other = want === _v3() ? _v2() : _v3();
        try { other.stopForUser(userId); } catch { /* */ }
        return want.applyConfigForUser(userId);
    },
    reloadForUser(userId) { return this.applyConfigForUser(userId); },
    onRealChatMessage(streamId, ev) { const e = engineForStream(streamId); if (e) return e.onRealChatMessage(streamId, ev); },
    onChatEvent(streamId, ev) { const e = engineForStream(streamId); if (e && e.onChatEvent) return e.onChatEvent(streamId, ev); if (e) return e.onRealChatMessage(streamId, ev); },
    onModCommand(channelUserId, streamId, args, opts) { const e = engineForUser(channelUserId); return e.onModCommand ? e.onModCommand(channelUserId, streamId, args, opts) : 'This channel runs the legacy AI viewers engine — switch to v3 for chat commands.'; },
    status(userId) { const e = engineForUser(userId); return e.status ? e.status(userId) : { engine: 'v2', running: _v2().hasWorker ? [..._v2().workers.values()].some(w => w.userId === userId) : false }; },
    preview(userId) { const e = engineForUser(userId); return e.preview ? e.preview(userId) : Promise.resolve({ error: 'Preview needs the v3 engine' }); },
    nudge(userId) { const e = engineForUser(userId); return e.nudge ? e.nudge(userId) : false; },
    v2: _v2, v3: _v3,
};
