/**
 * OpenVibe.Live — Docs pages
 *
 * Serves the Markdown files in ./docs as HTML at /docs/<name> (and /docs/<name>.md), so a
 * link such as https://openvibe.live/docs/whip#publishing-from-a-browser works without
 * sending people to GitHub. Heading ids follow GitHub's slug rules, so anchors copied from
 * GitHub keep working here and vice versa.
 *
 * The renderer covers exactly the Markdown subset the docs use — headings, paragraphs,
 * bullet/numbered lists, tables, fenced code, blockquotes, horizontal rules, and inline
 * code / bold / italic / links — with no dependency. Everything is HTML-escaped before
 * any inline formatting is applied, so document text can never inject markup.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const DOCS_DIR = path.join(__dirname, '../../docs');
const GITHUB_BLOB = 'https://github.com/OpenVibers/OpenVibe.Live/blob/main';

// ── Helpers ──────────────────────────────────────────────────

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// GitHub-style heading anchor: lowercase, drop punctuation, spaces → hyphens.
function slugify(text, used) {
    const base = String(text)
        .toLowerCase()
        .replace(/<[^>]+>/g, '')
        .replace(/&[a-z]+;|&#\d+;/g, '')
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        // Each space becomes a hyphen — GitHub does not collapse runs, so "VODs & Clips"
        // is "vods--clips" there, and anchors must round-trip between the two.
        .replace(/\s/g, '-');
    let slug = base || 'section';
    let n = 1;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    return slug;
}

/**
 * Rewrite a link target from the Markdown source so it works from /docs/<name>:
 *   other-doc.md#x     → /docs/other-doc#x   (served here)
 *   ../public/x.html   → /x.html             (served from the web root)
 *   ../SETUP.md, hardware/README.md, …       → the GitHub blob URL
 * Absolute URLs and same-page anchors pass through untouched.
 */
function rewriteHref(href) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(href)) return href;
    const [target, hash] = href.split('#');
    const anchor = hash ? `#${hash}` : '';
    const clean = target.replace(/^\.\//, '');
    const docMatch = clean.match(/^([a-z0-9-]+)\.md$/i);
    if (docMatch) return `/docs/${docMatch[1]}${anchor}`;
    const publicMatch = clean.match(/^\.\.\/public\/(.+)$/);
    if (publicMatch) return `/${publicMatch[1]}${anchor}`;
    const repoPath = clean.startsWith('../') ? clean.slice(3) : `docs/${clean}`;
    return `${GITHUB_BLOB}/${repoPath}${anchor}`;
}

/**
 * Inline formatting on already-escaped text. Code spans are lifted out first so that
 * `**`, `*`, `[`, and `<https://…>` inside them are left alone.
 */
function renderInline(escaped) {
    const codes = [];
    let text = escaped.replace(/`([^`]+)`/g, (_, code) => {
        codes.push(`<code>${code}</code>`);
        return `\u0000${codes.length - 1}\u0000`;
    });
    text = text
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
            const target = rewriteHref(href.replace(/&amp;/g, '&'));
            const external = /^https?:\/\//i.test(target) && !target.startsWith('https://openvibe.live');
            return `<a href="${escapeHtml(target)}"${external ? ' rel="noopener"' : ''}>${label}</a>`;
        })
        .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, url) => `<a href="${url}">${url}</a>`)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    return text.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

function splitTableRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

// ── Block renderer ───────────────────────────────────────────

function renderMarkdown(markdown) {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const usedSlugs = new Set();
    const headings = [];
    let title = null;
    let i = 0;

    const flushParagraph = (buf) => {
        if (buf.length) out.push(`<p>${renderInline(escapeHtml(buf.join(' ')))}</p>`);
        buf.length = 0;
    };

    const para = [];
    while (i < lines.length) {
        const line = lines[i];

        // Fenced code
        const fence = line.match(/^```\s*([\w+-]*)\s*$/);
        if (fence) {
            flushParagraph(para);
            const lang = fence[1];
            const code = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
            i++; // closing fence
            out.push(`<pre${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(code.join('\n'))}</code></pre>`);
            continue;
        }

        // Heading
        const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (heading) {
            flushParagraph(para);
            const level = heading[1].length;
            const html = renderInline(escapeHtml(heading[2]));
            const id = slugify(heading[2], usedSlugs);
            if (level === 1 && title === null) title = heading[2];
            if (level === 2) headings.push({ id, text: heading[2] });
            out.push(`<h${level} id="${id}">${html}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`);
            i++;
            continue;
        }

        // Horizontal rule
        if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            flushParagraph(para);
            out.push('<hr>');
            i++;
            continue;
        }

        // Blockquote
        if (/^>/.test(line)) {
            flushParagraph(para);
            const quote = [];
            while (i < lines.length && /^>/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
            // Blank quote lines separate paragraphs; consecutive lines join.
            const paras = quote.join('\n').split(/\n\s*\n/).map(p => p.replace(/\n/g, ' ').trim()).filter(Boolean);
            out.push(`<blockquote>${paras.map(p => `<p>${renderInline(escapeHtml(p))}</p>`).join('')}</blockquote>`);
            continue;
        }

        // Table: header row followed by a |---| separator
        if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
            flushParagraph(para);
            const header = splitTableRow(line);
            i += 2;
            const rows = [];
            while (i < lines.length && /^\|/.test(lines[i])) rows.push(splitTableRow(lines[i++]));
            const cell = (tag, c) => `<${tag}>${renderInline(escapeHtml(c))}</${tag}>`;
            out.push('<div class="table-wrap"><table>'
                + `<thead><tr>${header.map(c => cell('th', c)).join('')}</tr></thead>`
                + `<tbody>${rows.map(r => `<tr>${r.map(c => cell('td', c)).join('')}</tr>`).join('')}</tbody>`
                + '</table></div>');
            continue;
        }

        // Lists (bulleted or numbered); indented lines continue the current item.
        const listStart = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
        if (listStart && listStart[1].length === 0) {
            flushParagraph(para);
            const ordered = /\d/.test(listStart[2]);
            const items = [];
            while (i < lines.length) {
                const m = lines[i].match(/^([-*+]|\d+[.)])\s+(.*)$/);
                if (m && (/\d/.test(m[1]) === ordered)) {
                    items.push([m[2]]);
                    i++;
                } else if (items.length && /^\s{2,}\S/.test(lines[i])) {
                    items[items.length - 1].push(lines[i].trim());
                    i++;
                } else {
                    break;
                }
            }
            const tag = ordered ? 'ol' : 'ul';
            out.push(`<${tag}>${items.map(parts => `<li>${parts.map(p => renderInline(escapeHtml(p))).join('<br>')}</li>`).join('')}</${tag}>`);
            continue;
        }

        // Blank line ends a paragraph
        if (!line.trim()) {
            flushParagraph(para);
            i++;
            continue;
        }

        para.push(line.trim());
        i++;
    }
    flushParagraph(para);

    return { html: out.join('\n'), title, headings };
}

// ── Page shell ───────────────────────────────────────────────

function renderPage({ name, title, html, headings }) {
    const pageTitle = title ? `${title} — OpenVibe.Live Docs` : 'OpenVibe.Live Docs';
    const toc = headings.length
        ? `<nav class="toc" aria-label="On this page">${headings.map(h => `<a href="#${h.id}">${escapeHtml(h.text)}</a>`).join('')}</nav>`
        : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(pageTitle)}</title>
    <link rel="icon" href="/assets/favicon.ico">
    <style>
        :root { --bg: #0d0d0f; --bg-2: #16161a; --bg-3: #1e1e24; --text: #e8e6e3; --text-2: #9a9a9a; --muted: #666;
                --accent: #8b5cf6; --accent-light: #a78bfa; --border: #2a2a32; }
        * { box-sizing: border-box; }
        html, body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        a { color: var(--accent-light); }
        .top { display: flex; align-items: center; gap: 14px; padding: 12px 20px; border-bottom: 1px solid var(--border); background: var(--bg-2); font-size: 0.9rem; }
        .top .brand { font-weight: 700; color: var(--text); text-decoration: none; display: flex; align-items: center; gap: 8px; }
        .top .brand::before { content: ''; width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(135deg, #8b5cf6, #6d28d9); }
        .top .sep { color: var(--muted); }
        .top .right { margin-left: auto; display: flex; gap: 14px; }
        main { max-width: 880px; margin: 0 auto; padding: 24px 20px 64px; }
        h1 { font-size: 1.9rem; margin: 0 0 12px; line-height: 1.25; }
        h2 { font-size: 1.35rem; margin: 2.2em 0 0.6em; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
        h3 { font-size: 1.1rem; margin: 1.8em 0 0.5em; }
        h4 { font-size: 1rem; margin: 1.5em 0 0.4em; }
        h1, h2, h3, h4 { scroll-margin-top: 16px; }
        .anchor { margin-left: 8px; color: var(--muted); text-decoration: none; opacity: 0; font-weight: 400; }
        h1:hover .anchor, h2:hover .anchor, h3:hover .anchor, h4:hover .anchor, .anchor:focus { opacity: 1; }
        p, ul, ol, blockquote, pre, .table-wrap { margin: 0 0 1em; }
        li { margin: 0.25em 0; }
        code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--bg-3); padding: 1px 5px; border-radius: 4px; }
        pre { background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; overflow-x: auto; position: relative; }
        pre code { background: none; padding: 0; font-size: 0.85rem; line-height: 1.5; }
        pre[data-lang]::before { content: attr(data-lang); position: absolute; top: 6px; right: 12px; font-size: 0.7rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
        blockquote { border-left: 3px solid var(--accent); background: rgba(139, 92, 246, 0.08); padding: 10px 16px; border-radius: 0 8px 8px 0; }
        blockquote p:last-child { margin: 0; }
        .table-wrap { overflow-x: auto; }
        table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
        th, td { text-align: left; padding: 8px 10px; border: 1px solid var(--border); vertical-align: top; }
        th { background: var(--bg-2); }
        tr:nth-child(even) td { background: rgba(255, 255, 255, 0.02); }
        hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
        .toc { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 0.85rem; margin: 0 0 24px; padding: 12px 14px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px; }
        .toc a { color: var(--text-2); text-decoration: none; }
        .toc a:hover { color: var(--accent-light); }
        .foot { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 0.85rem; color: var(--text-2); }
    </style>
</head>
<body>
<header class="top">
    <a class="brand" href="/">OpenVibe.Live</a><span class="sep">/</span><a href="/docs">Docs</a>
    <div class="right"><a href="${GITHUB_BLOB}/docs/${escapeHtml(name)}.md" rel="noopener">Source on GitHub</a></div>
</header>
<main>
${toc}
${html}
<p class="foot">This page is rendered from <code>docs/${escapeHtml(name)}.md</code> in the <a href="https://github.com/OpenVibers/OpenVibe.Live" rel="noopener">OpenVibe.Live repository</a>. Found a mistake? Edit it there.</p>
</main>
</body>
</html>`;
}

// ── Routes ───────────────────────────────────────────────────

function loadDoc(name) {
    if (!/^[a-z0-9-]+$/i.test(name)) return null;
    const file = path.join(DOCS_DIR, `${name}.md`);
    if (!file.startsWith(DOCS_DIR + path.sep)) return null;
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function sendDoc(req, res, name) {
    const markdown = loadDoc(name);
    if (markdown === null) return res.status(404).type('text/plain').send('No such doc');
    const rendered = renderMarkdown(markdown);
    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(renderPage({ name, ...rendered }));
}

router.get('/', (req, res) => sendDoc(req, res, 'README'));
router.get('/:name.md', (req, res) => sendDoc(req, res, req.params.name));
router.get('/:name', (req, res) => sendDoc(req, res, req.params.name));

module.exports = router;
module.exports._renderMarkdown = renderMarkdown;
module.exports._rewriteHref = rewriteHref;
module.exports._slugify = slugify;
