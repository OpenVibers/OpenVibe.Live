/**
 * ai-chatbot-service.js — compatibility shim.
 *
 * The AI "fake viewers" system was rewritten as AI Chat Viewers 2.0 (persistent
 * per-channel roster + brains, live-situation context, per-streamer budgeting).
 * The new engine lives in ../ai/viewers/engine.js. This module re-exports that
 * singleton so the existing lifecycle hook points keep working unchanged:
 *
 *   startForStream(stream) · stopForStream(streamId) · stopForUser(userId)
 *   applyConfigForUser(userId) · reloadForUser(userId) · hasWorker(streamId)
 *   onRealChatMessage(streamId, { username, message, userId })
 *
 * Call sites: index.js, streaming/whip-handler.js, streaming/routes.js,
 * chat/chat-server.js.
 */
'use strict';
module.exports = require('../ai/viewers/engine');
