'use strict';
// Request analytics within ADR-021 (see tracker.js, privacy.js, retention.js).
const { AnalyticsTracker } = require('./tracker');
const privacy = require('./privacy');
const retention = require('./retention');
const { ensureSchema } = require('./schema');

module.exports = { AnalyticsTracker, privacy, retention, ensureSchema };
