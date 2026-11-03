'use strict';
// The report-only policy for rendered documents (server/web/assets.js cspReportOnly): inline scripts by hash, and
// the shared navbar's inline speculation rules by their own CSP 3 keyword (11-03: every guest's direct /broadcast load
// reported one).
//   node test/csp-report-only.test.js
const assert = require('assert');
const crypto = require('crypto');
const { cspReportOnly } = require('../server/web/assets');

const inline = 'window.x = 1;';
const policy = cspReportOnly(`<html><head><script>${inline}</script><script type="application/ld+json">{"a":1}</script><script src="/js/app.js"></script></head></html>`);
const elem = policy.split('; ').find((d) => d.startsWith('script-src-elem '));
assert.ok(elem, 'a script-src-elem directive');
assert.ok(elem.includes("'inline-speculation-rules'"), 'inline speculation rules are allowed');
assert.ok(elem.includes(`'sha256-${crypto.createHash('sha256').update(inline, 'utf8').digest('base64')}'`), 'the inline script by its hash');
assert.ok(!elem.includes("'unsafe-inline'"), 'never unsafe-inline for elements');
assert.strictEqual((elem.match(/'sha256-/g) || []).length, 1, 'JSON-LD and src scripts need no hash');
assert.ok(policy.includes('report-uri /api/csp-report'));
console.log('csp report-only: all checks passed');
