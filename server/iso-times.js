'use strict';
// openvibe-sdk/site (0.174.0) is the one implementation every site shares (the consolidation of 2026-11-16).
// Times leave with their zone (openvibe.design rule 148).
const { SQL_TEXT_TIME, TIME_KEY, isoJsonTimes, isoTime, normalizeTimes } = require('openvibe-sdk/site');

module.exports = { SQL_TEXT_TIME, TIME_KEY, isoJsonTimes, isoTime, normalizeTimes };
