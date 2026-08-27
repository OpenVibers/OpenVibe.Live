/**
 * AI Chat Viewers — public surface. The director engine (./engine) is the only engine;
 * every lifecycle/chat hook in the server and the routes go through this module.
 */
'use strict';
const engine = require('./engine');

module.exports = {
    version: 'v3',
    engineForUser() { return engine; },
    hasWorker: (streamId) => engine.hasWorker(streamId),
    startForStream: (stream) => engine.startForStream(stream),
    stopForStream: (streamId) => engine.stopForStream(streamId),
    stopForUser: (userId) => engine.stopForUser(userId),
    applyConfigForUser: (userId) => engine.applyConfigForUser(userId),
    reloadForUser: (userId) => engine.applyConfigForUser(userId),
    onRealChatMessage: (streamId, ev) => engine.onChatEvent(streamId, ev),
    onChatEvent: (streamId, ev) => engine.onChatEvent(streamId, ev),
    onModCommand: (channelUserId, streamId, args, opts) => engine.onModCommand(channelUserId, streamId, args, opts),
    status: (userId) => engine.status(userId),
    preview: (userId) => engine.preview(userId),
    nudge: (userId) => engine.nudge(userId),
    engine,
};
