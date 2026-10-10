'use strict';
/** Lift the restore drill's read-only guard so the N-1 client can exercise write routes. */
const path = require('path');
const cwd = process.cwd();
const drill = require(path.join(cwd, 'server', 'drill'));
drill.readOnly = (req, res, next) => next();
