/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Documentation page (/documentation): tab scroller and copy-as-Markdown.

   Split out of app.js, which every page used to download and parse. This file loads with its
   route (public/features.json); it runs after app.js and relies on app.js globals.
   ═══════════════════════════════════════════════════════════════ */
// ── Docs → clean Markdown ────────────────────────────────────────────────────
// Convert the docs HTML (headings, paragraphs, lists, code blocks, and the .doc-table
// endpoint tables) into proper Markdown so "Copy All"/"Copy Section" paste as real Markdown
// (GitHub-flavored tables, fenced code) instead of tab-separated innerText.
function _docsInlineMd(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const cls = node.className || '';
    if (tag === 'i' && /\bfa-/.test(cls)) return ''; // FontAwesome icon — no text
    const inner = Array.from(node.childNodes).map(_docsInlineMd).join('');
    switch (tag) {
        case 'code': return '`' + node.textContent + '`';
        case 'strong': case 'b': return '**' + inner.trim() + '**';
        case 'em': case 'i': return inner.trim() ? '*' + inner.trim() + '*' : '';
        case 'a': { const href = node.getAttribute('href') || ''; return href ? `[${inner.trim()}](${href})` : inner; }
        case 'br': return '\n';
        default: return inner;
    }
}
function _docsCell(c) { return _docsInlineMd(c).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim(); }
function _docsTableMd(table) {
    let header = Array.from(table.querySelectorAll('thead th')).map(_docsCell);
    let bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    if (!header.length) {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (rows[0]) header = Array.from(rows[0].children).map(_docsCell);
        bodyRows = rows.slice(1);
    }
    const out = [];
    if (header.length) {
        out.push('| ' + header.join(' | ') + ' |');
        out.push('| ' + header.map(() => '---').join(' | ') + ' |');
    }
    for (const tr of bodyRows) {
        const cells = Array.from(tr.children).map(_docsCell);
        if (cells.length) out.push('| ' + cells.join(' | ') + ' |');
    }
    return out.join('\n');
}
function _docsToMarkdown(root) {
    const lines = [];
    const walk = (el) => {
        for (const node of el.childNodes) {
            if (node.nodeType === 3) { const t = node.textContent.trim(); if (t) lines.push(t); continue; }
            if (node.nodeType !== 1) continue;
            const tag = node.tagName.toLowerCase();
            if (/^h[1-6]$/.test(tag)) {
                lines.push('', '#'.repeat(Number(tag[1])) + ' ' + _docsInlineMd(node).trim(), '');
            } else if (tag === 'p') {
                const t = _docsInlineMd(node).trim(); if (t) lines.push(t, '');
            } else if (tag === 'ul' || tag === 'ol') {
                Array.from(node.children).filter(li => li.tagName === 'LI').forEach((li, i) => {
                    lines.push((tag === 'ol' ? (i + 1) + '. ' : '- ') + _docsInlineMd(li).replace(/\s*\n\s*/g, ' ').trim());
                });
                lines.push('');
            } else if (tag === 'pre') {
                lines.push('```', (node.textContent || '').replace(/\n+$/, ''), '```', '');
            } else if (tag === 'table') {
                lines.push(_docsTableMd(node), '');
            } else if (tag === 'hr') {
                lines.push('', '---', '');
            } else {
                walk(node); // container — recurse
            }
        }
    };
    walk(root);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function copyDocsForAI() {
    const el = document.getElementById('docs-ai-content');
    if (!el) return;
    // Non-active tabs are display:none; reveal all so the converter sees every tab, then restore
    // (synchronous — no visible flash).
    const tabs = Array.from(el.querySelectorAll('.doc-tab-content'));
    const prevDisplay = tabs.map(t => t.style.display);
    tabs.forEach(t => { t.style.display = ''; });
    const text = _docsToMarkdown(el);
    tabs.forEach((t, i) => { t.style.display = prevDisplay[i]; });
    _docsCopy(text, 'docs-copy-btn', 'Copied all!');
}

function _docsCopy(text, btnId, label) {
    const flash = () => {
        const toast = document.getElementById('docs-copy-toast');
        const btn = document.getElementById(btnId);
        if (toast) { toast.style.display = 'block'; setTimeout(() => { toast.style.display = 'none'; }, 4000); }
        if (btn) { const orig = btn.innerHTML; btn.innerHTML = `<i class="fa-solid fa-check"></i> ${label}`; setTimeout(() => { btn.innerHTML = orig; }, 3000); }
    };
    navigator.clipboard.writeText(text).then(flash).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        flash();
    });
}

function showDocTab(tabName, btn) {
    document.querySelectorAll('.doc-tab-content').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.docs-tab').forEach(el => el.classList.remove('active'));
    const target = document.querySelector(`.doc-tab-content[data-doc-tab="${tabName}"]`);
    if (target) target.style.display = '';
    if (btn) {
        btn.classList.add('active');
        // Keep the selected tab fully visible in the scrollable bar.
        try { btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }); } catch { /* */ }
    }
}

// Tab-bar overflow affordance: arrow buttons + edge fades when tabs overflow,
// plain mouse wheel scrolls the bar horizontally (no shift needed).
function initDocsTabScroller() {
    const wrap = document.getElementById('docs-tab-wrap');
    const bar = document.getElementById('docs-tab-bar');
    if (!wrap || !bar) return;
    const update = () => {
        wrap.classList.toggle('can-scroll-left', bar.scrollLeft > 4);
        wrap.classList.toggle('can-scroll-right', bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 4);
    };
    if (!wrap._scrollerInit) {
        wrap._scrollerInit = true;
        bar.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        const L = document.getElementById('docs-tab-arrow-left');
        const R = document.getElementById('docs-tab-arrow-right');
        if (L) L.onclick = () => bar.scrollBy({ left: -Math.max(200, bar.clientWidth * 0.6), behavior: 'smooth' });
        if (R) R.onclick = () => bar.scrollBy({ left: Math.max(200, bar.clientWidth * 0.6), behavior: 'smooth' });
        bar.addEventListener('wheel', (e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && bar.scrollWidth > bar.clientWidth) {
                bar.scrollLeft += e.deltaY;
                e.preventDefault();
            }
        }, { passive: false });
    }
    // Widths are 0 until the page is actually displayed — measure on next frame.
    requestAnimationFrame(update);
}

function copyDocSection() {
    const active = document.querySelector('.doc-tab-content[style=""], .doc-tab-content:not([style*="display: none"]):not([style*="display:none"])');
    if (!active) return;
    _docsCopy(_docsToMarkdown(active), 'docs-copy-section-btn', 'Copied!');
}
