/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Chat Autocomplete System
   Inline suggestions for @mentions, :emotes:, and /commands
   as you type in any chat textarea.
   ═══════════════════════════════════════════════════════════════ */

(() => {
'use strict';

/* ── Config ──────────────────────────────────────────────────── */
const AC_MAX_RESULTS      = 8;
const AC_MIN_QUERY_LEN    = 1;   // Min chars after trigger to start matching
const AC_DEBOUNCE_MS      = 80;  // Debounce input events
const AC_EMOTE_THUMB_SIZE = 22;  // px for emote preview thumbnails

/* ── Slash command definitions ────────────────────────────────── */
const SLASH_COMMANDS = [
    { name: 'help',    desc: 'List available commands' },
    { name: 'tts',     desc: 'Text-to-speech message',   usage: '/tts <message>' },
    { name: 'color',   desc: 'Set your name color',      usage: '/color #hex' },
    { name: 'viewers', desc: 'Show viewer count' },
    { name: 'uptime',  desc: 'Show stream uptime' },
    { name: 'me',      desc: 'Send an action message',   usage: '/me <action>' },
    { name: 'paste',   desc: 'Share a paste in chat',    usage: '/paste <content>' },
    { name: 'slow',    desc: 'Set slow mode (mod)',       usage: '/slow <seconds>' },
    { name: 'ban',     desc: 'Ban a user (mod)',          usage: '/ban <user>' },
    { name: 'unban',   desc: 'Unban a user (mod)',        usage: '/unban <user>' },
    { name: 'timeout', desc: 'Timeout a user (mod)',      usage: '/timeout <user> [s]' },
    { name: 'clear',   desc: 'Clear chat messages (mod)' },
];

/* ── State ────────────────────────────────────────────────────── */
let _acPopup        = null;   // The popup DOM element
let _acItems        = [];     // Current suggestion items [{label, value, type, icon?, url?}]
let _acSelectedIdx  = -1;     // Keyboard-highlighted index
let _acActive       = false;  // Whether popup is visible
let _acTarget       = null;   // The textarea being autocompleted
let _acTriggerStart = -1;     // Character position of the trigger (@, :, /)
let _acTriggerChar  = '';     // '@', ':', or '/'
let _acDebounceId   = null;
let _acClosedByEsc  = false;  // Prevent re-opening until next keystroke after Esc

// Track usernames seen in chat messages for @mention suggestions.
// This supplements the _chatUsersData from the users-list WS message.
const _acSeenUsernames = new Map(); // username → {display_name, color, avatar_url}

/* ═══════════════════════════════════════════════════════════════
   Popup Management
   ═══════════════════════════════════════════════════════════════ */

function _acEnsurePopup() {
    if (_acPopup) return _acPopup;
    const el = document.createElement('div');
    el.className = 'chat-autocomplete-popup';
    el.setAttribute('role', 'listbox');
    el.style.display = 'none';
    document.body.appendChild(el);
    // Clicking an item
    el.addEventListener('mousedown', (e) => {
        // Prevent blur on textarea (which would close popup)
        e.preventDefault();
        const row = e.target.closest('.ac-item');
        if (row) {
            const idx = parseInt(row.dataset.idx, 10);
            if (Number.isFinite(idx)) _acAccept(idx);
        }
    });
    _acPopup = el;
    return el;
}

function _acShow() {
    const popup = _acEnsurePopup();
    popup.style.display = '';
    _acActive = true;
    _acClosedByEsc = false;
}

function _acHide() {
    if (_acPopup) _acPopup.style.display = 'none';
    _acActive = false;
    _acSelectedIdx = -1;
    _acItems = [];
}

function _acPosition() {
    if (!_acTarget || !_acPopup) return;
    // Position popup above the input area
    const inputArea = _acTarget.closest('.chat-input-area') || _acTarget.closest('.chat-input-row') || _acTarget.parentElement;
    if (!inputArea) return;

    const rect = inputArea.getBoundingClientRect();
    const popup = _acPopup;

    // Temporarily show to measure
    popup.style.visibility = 'hidden';
    popup.style.display = '';
    const popupHeight = popup.offsetHeight;
    const popupWidth = popup.offsetWidth;
    popup.style.visibility = '';

    // Place above the input area, left-aligned
    let top = rect.top - popupHeight - 4;
    let left = rect.left;

    // If not enough room above, place below
    if (top < 4) {
        top = rect.bottom + 4;
    }
    // Clamp to viewport
    const vw = window.innerWidth;
    if (left + popupWidth > vw - 4) left = vw - popupWidth - 4;
    if (left < 4) left = 4;

    popup.style.position = 'fixed';
    popup.style.top = top + 'px';
    popup.style.left = left + 'px';
    popup.style.width = Math.min(rect.width, 380) + 'px';
    popup.style.zIndex = '99999';
}

function _acRender() {
    const popup = _acEnsurePopup();
    if (_acItems.length === 0) {
        _acHide();
        return;
    }

    let html = '';
    for (let i = 0; i < _acItems.length; i++) {
        const item = _acItems[i];
        const sel = i === _acSelectedIdx ? ' ac-selected' : '';
        const icon = _acBuildIcon(item);
        const label = _escAc(item.label);
        const desc = item.desc ? `<span class="ac-desc">${_escAc(item.desc)}</span>` : '';
        html += `<div class="ac-item${sel}" data-idx="${i}" role="option" aria-selected="${i === _acSelectedIdx}">`
            + `${icon}<span class="ac-label">${label}</span>${desc}</div>`;
    }
    popup.innerHTML = html;
    _acPosition();
    _acShow();

    // Scroll selected into view
    if (_acSelectedIdx >= 0) {
        const selEl = popup.querySelector('.ac-selected');
        if (selEl) selEl.scrollIntoView({ block: 'nearest' });
    }
}

function _acBuildIcon(item) {
    if (item.type === 'emote' && item.url) {
        return `<img class="ac-emote-thumb" src="${_escAc(item.url)}" alt="" width="${AC_EMOTE_THUMB_SIZE}" height="${AC_EMOTE_THUMB_SIZE}" loading="lazy">`;
    }
    if (item.type === 'user') {
        if (item.avatar_url) {
            return `<img class="ac-user-avatar" src="${_escAc(item.avatar_url)}" alt="" width="18" height="18" loading="lazy">`;
        }
        return '<span class="ac-icon"><i class="fa-solid fa-at"></i></span>';
    }
    if (item.type === 'command') {
        return '<span class="ac-icon"><i class="fa-solid fa-terminal"></i></span>';
    }
    return '';
}

/* ═══════════════════════════════════════════════════════════════
   Trigger Detection & Query Extraction
   ═══════════════════════════════════════════════════════════════ */

/**
 * Look backwards from cursor to find a trigger character.
 * Returns {trigger, query, start} or null.
 */
function _acFindTrigger(text, cursorPos) {
    if (cursorPos <= 0) return null;
    const before = text.slice(0, cursorPos);

    // Walk backwards from cursor
    for (let i = before.length - 1; i >= 0; i--) {
        const ch = before[i];

        // Hit whitespace or newline before finding trigger = no match
        if (ch === ' ' || ch === '\n' || ch === '\r') return null;

        if (ch === '@' || ch === ':' || ch === '/') {
            // Trigger must be at start of input or preceded by whitespace
            if (i > 0 && before[i - 1] !== ' ' && before[i - 1] !== '\n') {
                // Exception: / at position 0 is valid
                if (ch === '/' && i === 0) {
                    // Fall through
                } else {
                    return null;
                }
            }

            const query = before.slice(i + 1);

            // For : trigger, need closing : check — if there's already a closing :, don't trigger
            // (means the emote is already complete)
            if (ch === ':') {
                const afterCursor = text.slice(cursorPos);
                // Not a trigger if the query is empty (just typed ':')
                // but we still want to show suggestions with 1+ char
                // Check: is this an already-closed emote like :emote: ?
                // We only trigger if there's no closing : before cursor
            }

            // / trigger is only valid at position 0 (start of message)
            if (ch === '/' && i !== 0) return null;

            return { trigger: ch, query, start: i };
        }
    }
    return null;
}

/* ═══════════════════════════════════════════════════════════════
   Data Sources
   ═══════════════════════════════════════════════════════════════ */

function _acSearchEmotes(query) {
    if (typeof emoteMap === 'undefined' || !emoteMap) return [];
    const q = query.toLowerCase();
    const results = [];
    for (const [code, emote] of emoteMap) {
        if (code.toLowerCase().includes(q)) {
            results.push({
                label: code,
                value: code + ' ',  // Append space after emote
                type: 'emote',
                url: emote.url,
                // Sort exact-start matches higher
                _score: code.toLowerCase().startsWith(q) ? 0 : 1,
            });
            if (results.length >= AC_MAX_RESULTS * 2) break; // Pre-limit before sort
        }
    }
    results.sort((a, b) => a._score - b._score || a.label.length - b.label.length);
    return results.slice(0, AC_MAX_RESULTS);
}

function _acSearchUsers(query) {
    const q = query.toLowerCase();
    const results = [];
    const seen = new Set();

    // Merge: live users list + seen-in-chat cache
    const candidates = [];

    // Live user list from the users panel
    if (typeof _chatUsersData !== 'undefined' && _chatUsersData?.logged) {
        for (const u of _chatUsersData.logged) {
            candidates.push({
                username: u.username,
                display_name: u.display_name || u.username,
                avatar_url: u.avatar_url || null,
            });
        }
    }

    // Seen-in-chat cache
    for (const [username, data] of _acSeenUsernames) {
        if (!seen.has(username.toLowerCase())) {
            candidates.push({
                username,
                display_name: data.display_name || username,
                avatar_url: data.avatar_url || null,
            });
        }
    }

    for (const u of candidates) {
        const uLower = u.username.toLowerCase();
        const dLower = (u.display_name || '').toLowerCase();
        if (seen.has(uLower)) continue;
        if (uLower.includes(q) || dLower.includes(q)) {
            seen.add(uLower);
            const matchLabel = u.display_name !== u.username
                ? `${u.display_name} (${u.username})`
                : u.username;
            results.push({
                label: matchLabel,
                value: u.username + ' ',  // Insert @username + space
                type: 'user',
                avatar_url: u.avatar_url,
                _score: uLower.startsWith(q) ? 0 : (dLower.startsWith(q) ? 0.5 : 1),
            });
            if (results.length >= AC_MAX_RESULTS * 2) break;
        }
    }

    results.sort((a, b) => a._score - b._score || a.label.length - b.label.length);
    return results.slice(0, AC_MAX_RESULTS);
}

function _acSearchCommands(query) {
    const q = query.toLowerCase();
    return SLASH_COMMANDS
        .filter(c => c.name.startsWith(q))
        .slice(0, AC_MAX_RESULTS)
        .map(c => ({
            label: '/' + c.name,
            value: c.name + ' ',  // Complete the command name + space
            desc: c.desc,
            type: 'command',
        }));
}

/* ═══════════════════════════════════════════════════════════════
   Accept / Insert
   ═══════════════════════════════════════════════════════════════ */

function _acAccept(idx) {
    if (idx < 0 || idx >= _acItems.length || !_acTarget) {
        _acHide();
        return;
    }
    const item = _acItems[idx];
    const el = _acTarget;
    const before = el.value.slice(0, _acTriggerStart);
    const after = el.value.slice(el.selectionStart);

    let insertText;
    if (_acTriggerChar === '@') {
        insertText = '@' + item.value;
    } else if (_acTriggerChar === ':') {
        insertText = item.value;
    } else if (_acTriggerChar === '/') {
        insertText = '/' + item.value;
    } else {
        insertText = item.value;
    }

    el.value = before + insertText + after;
    const newPos = before.length + insertText.length;
    el.setSelectionRange(newPos, newPos);
    el.focus();

    // Trigger auto-resize
    if (typeof _autoResizeTextarea === 'function') _autoResizeTextarea(el);

    _acHide();
}

/* ═══════════════════════════════════════════════════════════════
   Input Handler (debounced)
   ═══════════════════════════════════════════════════════════════ */

function _acOnInput(el) {
    clearTimeout(_acDebounceId);
    if (_acClosedByEsc) return;
    _acDebounceId = setTimeout(() => _acEvaluate(el), AC_DEBOUNCE_MS);
}

function _acEvaluate(el) {
    const cursor = el.selectionStart;
    const text = el.value;

    const found = _acFindTrigger(text, cursor);
    if (!found || found.query.length < AC_MIN_QUERY_LEN) {
        _acHide();
        return;
    }

    _acTarget = el;
    _acTriggerStart = found.start;
    _acTriggerChar = found.trigger;

    let items;
    if (found.trigger === '@') {
        items = _acSearchUsers(found.query);
    } else if (found.trigger === ':') {
        items = _acSearchEmotes(found.query);
    } else if (found.trigger === '/') {
        items = _acSearchCommands(found.query);
    } else {
        items = [];
    }

    if (items.length === 0) {
        _acHide();
        return;
    }

    _acItems = items;
    _acSelectedIdx = 0; // Pre-select first item
    _acRender();
}

/* ═══════════════════════════════════════════════════════════════
   Keyboard Navigation
   ═══════════════════════════════════════════════════════════════ */

function _acOnKeydown(e) {
    // Reset the Esc flag on any keystroke that isn't Esc
    if (e.key !== 'Escape') _acClosedByEsc = false;

    if (!_acActive) {
        // Tab with partial text — force evaluation as tab-complete
        if (e.key === 'Tab' && !e.shiftKey && e.target.classList.contains('chat-textarea')) {
            const el = e.target;
            const found = _acFindTrigger(el.value, el.selectionStart);
            if (found && found.query.length >= AC_MIN_QUERY_LEN) {
                e.preventDefault();
                _acEvaluate(el);
                // Just open the popup — Tab will cycle from here
            }
            return;
        }
        return;
    }

    switch (e.key) {
        case 'ArrowDown':
            e.preventDefault();
            e.stopPropagation();
            _acSelectedIdx = (_acSelectedIdx + 1) % _acItems.length;
            _acRender();
            break;

        case 'ArrowUp':
            e.preventDefault();
            e.stopPropagation();
            _acSelectedIdx = (_acSelectedIdx - 1 + _acItems.length) % _acItems.length;
            _acRender();
            break;

        case 'Tab':
            e.preventDefault();
            e.stopPropagation();
            // Cycle forward through items (Shift+Tab goes backward)
            if (e.shiftKey) {
                _acSelectedIdx = (_acSelectedIdx - 1 + _acItems.length) % _acItems.length;
            } else {
                _acSelectedIdx = (_acSelectedIdx + 1) % _acItems.length;
            }
            _acRender();
            break;

        case 'Enter':
            if (_acSelectedIdx >= 0) {
                e.preventDefault();
                e.stopPropagation();
                _acAccept(_acSelectedIdx);
            }
            // If no selection, let Enter pass through to send
            break;

        case 'Escape':
            e.preventDefault();
            e.stopPropagation();
            _acClosedByEsc = true;
            _acHide();
            break;
    }
}

/* ═══════════════════════════════════════════════════════════════
   Track usernames from incoming chat messages
   ═══════════════════════════════════════════════════════════════ */

/**
 * Call this from the chat message handler to build up the
 * username list for @mention autocomplete.
 */
function acTrackUser(msg) {
    if (!msg) return;
    const username = msg.core_username || msg.username;
    if (!username || username.startsWith('anon_')) return;
    _acSeenUsernames.set(username, {
        display_name: msg.display_name || msg.username || username,
        color: msg.color || null,
        avatar_url: msg.avatar_url || null,
    });
    // Cap size
    if (_acSeenUsernames.size > 500) {
        const first = _acSeenUsernames.keys().next().value;
        _acSeenUsernames.delete(first);
    }
}

/* ═══════════════════════════════════════════════════════════════
   Initialization — Attach events (delegated)
   ═══════════════════════════════════════════════════════════════ */

function _acInit() {
    // Input handler (delegated)
    document.addEventListener('input', (e) => {
        if (e.target.classList.contains('chat-textarea')) {
            _acOnInput(e.target);
        }
    }, true);

    // Keydown handler — must fire before the chat handler to intercept
    // arrows/tab/enter/esc when popup is open
    document.addEventListener('keydown', (e) => {
        if (e.target.classList.contains('chat-textarea')) {
            _acOnKeydown(e);
        }
    }, { capture: true });  // capture phase = fires before chat.js handler

    // Close on blur
    document.addEventListener('focusout', (e) => {
        if (e.target.classList.contains('chat-textarea')) {
            // Small delay so click on popup item registers first
            setTimeout(() => {
                if (!_acTarget || document.activeElement !== _acTarget) {
                    _acHide();
                }
            }, 150);
        }
    }, true);

    // Close on window resize/scroll (popup position goes stale)
    window.addEventListener('resize', () => { if (_acActive) _acPosition(); });
}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _acInit);
} else {
    _acInit();
}

/* ── Public API ─────────────────────────────────────────────── */
window.acIsActive  = () => _acActive;
window.acTrackUser = acTrackUser;

/* ── Utility ─────────────────────────────────────────────────── */
function _escAc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

})();
