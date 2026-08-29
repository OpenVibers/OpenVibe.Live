'use strict';

// Regression tests for the on-site docs renderer (server/docs/routes.js).
// Every docs/*.md must render without leaking raw Markdown, heading anchors must match
// GitHub's slugs (links are shared between the site and the repo), and relative links
// must be rewritten to places that exist on the site.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _renderMarkdown: render, _rewriteHref: rewriteHref, _slugify: slugify } = require('../server/docs/routes');

// ── Heading slugs (GitHub-compatible) ──
const used = new Set();
assert.strictEqual(slugify('Publishing from a browser', used), 'publishing-from-a-browser');
assert.strictEqual(slugify('Cross-origin (CORS)', used), 'cross-origin-cors');
assert.strictEqual(slugify('VODs & Clips', used), 'vods--clips');
assert.strictEqual(slugify('Publishing from a browser', used), 'publishing-from-a-browser-1', 'duplicate headings get a numeric suffix');
console.log('✅ heading slugs match GitHub');

// ── Link rewriting ──
assert.strictEqual(rewriteHref('broadcasting.md'), '/docs/broadcasting');
assert.strictEqual(rewriteHref('whip.md#publishing-from-a-browser'), '/docs/whip#publishing-from-a-browser');
assert.strictEqual(rewriteHref('../public/whip-publisher.html'), '/whip-publisher.html');
assert.strictEqual(rewriteHref('../SETUP.md'), 'https://github.com/OpenVibers/OpenVibe.Live/blob/main/SETUP.md');
assert.strictEqual(rewriteHref('https://example.com/x'), 'https://example.com/x');
assert.strictEqual(rewriteHref('#endpoint'), '#endpoint');
assert.strictEqual(rewriteHref('/whip-publisher.html'), '/whip-publisher.html');
console.log('✅ relative links rewritten to on-site or GitHub targets');

// ── Inline formatting + escaping ──
const inline = render('Text (CORS `*`) and `fetch()`. **bold**, `code **kept**`, <https://a.b/c>, and <script>x</script>.').html;
assert.ok(inline.includes('(CORS <code>*</code>)'), 'code span with no stray placeholder spaces');
assert.ok(inline.includes('<code>code **kept**</code>'), 'markdown inside code spans is left alone');
assert.ok(inline.includes('<strong>bold</strong>'));
assert.ok(inline.includes('<a href="https://a.b/c">https://a.b/c</a>'), 'autolinks');
assert.ok(inline.includes('&lt;script&gt;x&lt;/script&gt;'), 'raw HTML is escaped, never emitted');
assert.ok(!inline.includes(String.fromCharCode(0)), 'no placeholder bytes leak into output');
console.log('✅ inline formatting and HTML escaping');

// ── Blocks ──
const blocks = render([
    '# Title',
    '',
    '> quoted line one',
    '> quoted line two',
    '',
    '| A | B |',
    '|---|---|',
    '| 1 | `2` |',
    '',
    '1. first',
    '   continued',
    '2. second',
    '',
    '- bullet',
    '',
    '```bash',
    'curl -X POST "<url>"',
    '```',
].join('\n'));
assert.strictEqual(blocks.title, 'Title');
assert.ok(blocks.html.includes('<blockquote><p>quoted line one quoted line two</p></blockquote>'));
assert.ok(blocks.html.includes('<th>A</th>') && blocks.html.includes('<td><code>2</code></td>'), 'tables');
assert.ok(blocks.html.includes('<ol><li>first<br>continued</li><li>second</li></ol>'), 'ordered list with continuation line');
assert.ok(blocks.html.includes('<ul><li>bullet</li></ul>'));
assert.ok(blocks.html.includes('<pre data-lang="bash"><code>curl -X POST &quot;&lt;url&gt;&quot;</code></pre>'), 'fenced code is escaped verbatim');
console.log('✅ block elements');

// ── Every shipped doc renders cleanly with the anchors people link to ──
const docsDir = path.join(__dirname, '../docs');
const leakPatterns = [/```/, /\*\*/, /^\s*\|/m, /\]\(/, /^#{1,6} /m];
for (const file of fs.readdirSync(docsDir).filter(f => f.endsWith('.md'))) {
    const result = render(fs.readFileSync(path.join(docsDir, file), 'utf8'));
    assert.ok(result.title, `${file}: has an H1 title`);
    const textOnly = result.html
        .replace(/<pre[\s\S]*?<\/pre>/g, '')
        .replace(/<code>[\s\S]*?<\/code>/g, '')
        .replace(/<[^>]+>/g, '');
    for (const re of leakPatterns) assert.ok(!re.test(textOnly), `${file}: raw markdown leaked (${re})`);
}
const whip = render(fs.readFileSync(path.join(docsDir, 'whip.md'), 'utf8')).html;
assert.ok(whip.includes('id="publishing-from-a-browser"'), 'the browser-publishing anchor that is linked publicly must exist');
assert.ok(whip.includes('href="/whip-publisher.html"'), 'link to the hosted publisher resolves on-site');
console.log('✅ all docs/*.md render without leaking markdown; public anchors present');

console.log('\n✅ All docs renderer tests passed');
