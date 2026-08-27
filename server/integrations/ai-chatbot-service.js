/**
 * ai-chatbot-service.js — compatibility shim.
 * The AI chat viewers engine lives in ../ai/viewers (index.js picks v2/v3 per site setting
 * and per-channel override). Every lifecycle hook + chat hook in the server goes through
 * this module so nothing else needs to know which engine is active.
 */
'use strict';
module.exports = require('../ai/viewers');
