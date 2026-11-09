'use strict';
/**
 * Content and AI Moments keep their subtitle whole on a phone. A two-line clamp cut AI Moments' "Everything here is
 * AI-generated" (the disclosure) to "Everything here is AI-…" (signed-in sweep, 2026-11-09; pages are short by design,
 * never by hiding).
 *
 *   node test/feed-subtitle-whole.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/features/content.css'), 'utf8');
const rules = css.match(/\.cf-sub\s*\{[^}]*\}/g) || [];
assert.ok(rules.length >= 1, '.cf-sub is styled');
for (const r of rules) assert.ok(!/line-clamp|overflow:\s*hidden|text-overflow/.test(r), `.cf-sub is never clipped: ${r}`);
const html = fs.readFileSync(path.join(__dirname, '..', 'public/fragments/moments.html'), 'utf8');
assert.ok(/class="cf-sub">[^<]*Everything here is AI-generated\./.test(html), 'the AI disclosure is in the subtitle');
console.log('feed subtitles: whole on a phone, the AI disclosure included');
