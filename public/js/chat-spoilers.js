/**
 * OpenVibe.Live — chat spoilers, as on Discord: ||hidden text|| anywhere in a message, and /spoiler <text>, which
 * OpenVibe.Chat sends as one. A hidden part shows as a bar until clicked (or Enter/Space on it).
 *
 * The raw text is split before any HTML is made, so a marker can never land inside a link's or an emote's attribute;
 * each part is then rendered by the caller's own renderer (emotes.js parseEmotes, the kiosk's linkify) and a hidden
 * one is wrapped in .chat-spoiler (chat-shared.css). Loaded with the chat (features.json chatExtras), the popout and
 * the kiosk, not on the home page's first load.
 */
(function () {
    'use strict';
    const SPOILER_RE = /\|\|([\s\S]+?)\|\|/g;

    /** [{ spoiler, text }]: only a non-empty ||…|| pair is a spoiler; anything else stays text. */
    function split(text) {
        const raw = String(text ?? '');
        const out = [];
        let last = 0;
        for (const m of raw.matchAll(SPOILER_RE)) {
            if (!m[1].trim()) continue;
            if (m.index > last) out.push({ spoiler: false, text: raw.slice(last, m.index) });
            out.push({ spoiler: true, text: m[1] });
            last = m.index + m[0].length;
        }
        if (last < raw.length || !out.length) out.push({ spoiler: false, text: raw.slice(last) });
        return out;
    }

    /** Render text with spoilers: `render` turns one plain part into safe HTML. */
    function withSpoilers(text, render) {
        return split(text).map((p) => (p.spoiler
            ? `<span class="chat-spoiler" role="button" tabindex="0" aria-label="Spoiler, select to show">${render(p.text)}</span>`
            : render(p.text))).join('');
    }

    /** Plain text with every spoiler's content replaced (reply snippets, TTS): nothing hidden shows or is spoken. */
    function mask(text) {
        return String(text ?? '').replace(SPOILER_RE, (m, inner) => (inner.trim() ? '[spoiler]' : m));
    }

    // A click (or Enter/Space) on a hidden spoiler shows it and does nothing else: a link inside it does not open.
    function reveal(e) {
        const s = e.target && e.target.closest ? e.target.closest('.chat-spoiler:not(.revealed)') : null;
        if (!s || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        e.stopPropagation();
        s.classList.add('revealed');
        s.removeAttribute('role');
        s.removeAttribute('tabindex');
        s.removeAttribute('aria-label');
    }

    if (!window.OpenVibeSpoilers) {
        document.addEventListener('click', reveal, true);
        document.addEventListener('keydown', reveal, true);
    }
    window.OpenVibeSpoilers = { split, withSpoilers, mask };
})();
