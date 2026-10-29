'use strict';
/**
 * Copy a page's noindex rule into an X-Robots-Tag response header.
 *
 * Google's 2026-10-26 UGC guidance asks a platform to keep link-shared pages out of Search with
 * "a robots meta tag or X-Robots-Tag HTTP response header"; sending both means a client that never
 * parses the head (or a proxy that strips it) still sees the rule. The value mirrors the meta tag,
 * so the page and the response never disagree.
 */
const ROBOTS_TAG_RE = /<meta[^>]*\bname=["']robots["'][^>]*>/i;
const CONTENT_RE = /\bcontent=["']([^"']*)["']/i;
const NOINDEX_RE = /(?:^|[\s,;])noindex(?:[\s,;]|$)/i;

/** The page's robots content when it says noindex, else null. */
function noindexOf(html) {
    const tag = ROBOTS_TAG_RE.exec(String(html || ''));
    const content = tag && CONTENT_RE.exec(tag[0]);
    return content && NOINDEX_RE.test(content[1]) ? content[1].replace(/\s+/g, '') : null;
}

/** Set X-Robots-Tag on `res` when `html` carries a noindex robots meta tag. */
function setRobotsHeader(res, html) {
    const robots = noindexOf(html);
    if (robots) res.set('X-Robots-Tag', robots);
    return robots;
}

module.exports = { setRobotsHeader, noindexOf };
