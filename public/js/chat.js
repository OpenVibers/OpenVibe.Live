/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Chat Client (WebSocket)
   ═══════════════════════════════════════════════════════════════ */

let chatWs = null;
let chatStreamId = null;
let chatChannelUserId = null; // streamer's user id — stable room across slots + offline
let chatRenderTargetId = null;

function esc(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toast(message, type = 'info') {
    // Delegate to the app-level toast saved in app.js (loaded before this file).
    // Do NOT use window.toast here — chat.js's own function declaration overwrites
    // window.toast, so that check is always self-referential and causes infinite recursion.
    if (typeof window._appToast === 'function') {
        return window._appToast(message, type);
    }
    if (typeof console !== 'undefined' && console.log) {
        console.log(`[Chat toast ${type}] ${String(message)}`);
    }
}

// ── Chat mode (Global / Voice Call) ──────────────────────────
let chatMode = 'global'; // 'global' or 'voice'

// ── Floating chat widget state ───────────────────────────────
let _fcwOpen = false;
let _fcwUnread = 0;
let _fcwDragging = false;
let _fcwDragOffset = { x: 0, y: 0 };

// ── Background broadcast chat ────────────────────────────────
// When the user is broadcasting and navigates away, the chat WS
// is kept alive in the background so TTS messages still play.
let _bgBroadcastWs = null;
let _bgBroadcastStreamId = null;

// ── Chat auto-reconnect state ────────────────────────────────
let _chatReconnectTimer = null;
let _chatReconnectDelay = 2000;
const CHAT_RECONNECT_BASE = 2000;
const CHAT_RECONNECT_MAX = 30000;
let _chatIntentionalClose = false;
let _chatActive = false; // true whenever we have an active/desired chat connection (including global)
let _chatIsReconnecting = false; // true during auto-reconnect to prevent clearing messages

// ── Voice-call invite overlays + sounds ─────────────────────
let _incomingVcCall = null;
let _incomingVcCallTimeout = null;
let _outgoingVcCall = null;
let _vcRingLoopTimer = null;
let _vcAudioCtx = null;

// ── Cross-feed: secondary global WS for piping messages into stream chat ──
let _globalFeedWs = null;
let _globalFeedReconnectTimer = null;
let _globalFeedReconnectDelay = 3000;
const _GLOBAL_FEED_RECONNECT_MAX = 20000;

// ── Vibe coding widget ──────────────────────────────────────
function _loadVibeWidgetCollapsedPreference() {
    try {
        return localStorage.getItem('openvibe_vibe_widget_collapsed') === '1';
    } catch {
        return false;
    }
}

function _saveVibeWidgetCollapsedPreference(collapsed) {
    try {
        if (collapsed) {
            localStorage.setItem('openvibe_vibe_widget_collapsed', '1');
            return;
        }
        localStorage.removeItem('openvibe_vibe_widget_collapsed');
    } catch {
        // Ignore storage failures so the widget still works in restricted contexts.
    }
}

let _vibeWidgetState = {
    key: null,
    panel: null,
    feed: null,
    indicator: null,
    settings: null,
    publisher: null,
    events: [],
    timers: [],
    collapsed: _loadVibeWidgetCollapsedPreference(),
    userScrolledUp: false,
    unreadCount: 0,
    refreshTimer: null,
    syncState: 'idle',
    lastSyncedAt: 0,
    openDisclosures: new Set(),
};
const VIBE_WIDGET_FALLBACK_MAX = 18;
const VIBE_WIDGET_REFRESH_MS = 5000;
const VIBE_WIDGET_SCROLL_THRESHOLD = 56;

// ── Slow mode state ─────────────────────────────────────────
let chatSlowModeSeconds = 0;
let chatSlowModeCooldownTimer = null;
let chatSlowModeCooldownEnd = 0;

// ── Reply-to state ──────────────────────────────────────────
let _chatReplyTo = null; // { id, username, user_id, message }

// Relay username colors, keyed by source_platform. Used for BOTH live and history
// so external (RS/Twitch/Kick/YouTube) names keep a consistent color — history rows
// don't persist a color, so without this they'd fall back to grey.
const PLATFORM_NAME_COLORS = { rs: '#7dd3fc', robotstreamer: '#7dd3fc', twitch: '#9146ff', kick: '#53fc18', youtube: '#ff0000', yt: '#ff0000' };
function relayColorFor(msg) {
    let sp = msg && msg.source_platform ? String(msg.source_platform).toLowerCase() : '';
    // Global-forwarded relay history messages can arrive without source_platform — fall back
    // to the "[RS]/[Twitch]/…" username prefix so they keep their platform colour (not grey).
    if (!PLATFORM_NAME_COLORS[sp] && msg) {
        const fromName = parseRelayUsername(msg.username || msg.displayName || '').platform;
        if (fromName) sp = fromName.toLowerCase();
    }
    return PLATFORM_NAME_COLORS[sp] || null;
}

// Relay platform → icon badge (replaces the old "[Twitch]/[RS]" text prefixes).
const RELAY_BADGE = {
    twitch:        { icon: 'fa-brands fa-twitch',  color: '#9146ff', label: 'Twitch' },
    kick:          { icon: 'fa-solid fa-bolt',     color: '#53fc18', label: 'Kick' },
    youtube:       { icon: 'fa-brands fa-youtube', color: '#ff0000', label: 'YouTube' },
    yt:            { icon: 'fa-brands fa-youtube', color: '#ff0000', label: 'YouTube' },
    rs:            { icon: 'fa-solid fa-robot',    color: '#7dd3fc', label: 'RobotStreamer' },
    robotstreamer: { icon: 'fa-solid fa-robot',    color: '#7dd3fc', label: 'RobotStreamer' },
};
function relayBadgeHTML(platform) {
    const b = RELAY_BADGE[(platform || '').toLowerCase()];
    if (!b) return '';
    return `<span class="chat-badge chat-relay-badge" data-tip="${b.label}" style="--relay-color:${b.color}"><i class="${b.icon}"></i></span>`;
}

// ── Chat settings (persisted to localStorage) ────────────────
const CHAT_SETTINGS_KEY = 'openvibe_chat_settings';
const CHAT_SETTINGS_DEFAULTS = {
    // Appearance
    showTimestamps: false,
    timestampFormat: '12h',       // '12h' or '24h'
    fontSize: 'default',          // 'small', 'default', 'large'
    showAvatars: true,
    showBadges: true,
    readableColors: false,        // Force minimum contrast on name colors
    alternateBackground: false,   // Zebra-stripe messages
    // Emotes
    animatedEmotes: true,         // Show animated/GIF emotes
    emoteScale: 'default',        // 'small', 'default', 'large'
    // Behavior
    showDeletedMessages: false,   // Show <deleted> instead of hiding
    showSystemMessages: true,     // Join/part/system messages
    mentionHighlight: true,       // Highlight messages containing your @name
    autoScroll: true,             // Auto-scroll to bottom on new messages
    autoDeleteMinutes: 0,         // Auto-delete your own new messages after N minutes (0 = off)
    // Notifications
    flashOnMention: true,         // Flash browser tab on @mention
    soundOnMention: false,        // Play a sound on @mention
    autoDeclineCalls: false,      // Auto-decline incoming voice calls
    // Widget
    showFloatingChat: true,       // Show floating global chat button on non-chat pages
    fullscreenOverlayChat: true,  // Show OBS-style chat overlay in fullscreen live player
    compactMode: false,           // Compact message layout (popout & popout-compatible surfaces)
    // Cross-feed — show messages from other sources while in a stream chat
    showGlobalInStream: true,     // Show global chat messages in stream chat (on by default)
    showAllStreamsInStream: true, // Show messages from ALL live streams in stream chat (on by default)
    showOtherSlotsInStream: true, // Show chat from this streamer's OTHER live slots (on by default)
    // TTS
    ttsEnabled: true,             // TTS participation toggle. ON = your messages are read normally;
                                  // OFF prepends "." to your messages so TTS skips them (and mutes local playback).
                                  // Defaults ON so messages aren't dot-prefixed/muted-styled by default.
    streamingTtsEnabled: true,    // Separate TTS toggle while broadcasting live
    channelTtsAlways: false,      // Hear your own channel's chat TTS even while NOT live
    ttsVolume: 80,                // TTS message volume (0–100)
    soundVolume: 80,              // Chat !sound / soundboard clip volume (0–100), independent of TTS
    // Chat sounds (soundboard + channel !sound commands) — independent of TTS
    soundsEnabled: true,          // Play chat sound clips (default on)
    // Per-source TTS — which relay platforms contribute to TTS
    ttsSrcNative: true,           // Native OpenVibe.Live chat
    ttsSrcRS: true,               // RobotStreamer relay
    ttsSrcKick: true,             // Kick relay
    ttsSrcYoutube: true,          // YouTube relay
    ttsSrcTwitch: true,           // Twitch relay
};
let chatSettings = { ...CHAT_SETTINGS_DEFAULTS };
let chatSettingsPanelOpen = false;
const CHAT_SELF_DELETE_MINUTES = 3;
let chatSelfDeletePolicy = {
    allowAutoDelete: true,
    allowDeleteAll: true,
    minMinutes: CHAT_SELF_DELETE_MINUTES,
};
let chatSlurPolicy = {
    enabled: false,
    useBuiltin: true,
    disabledCategories: [],
    terms: [],
    regexes: [],
    message: '',
    announcedForKey: null,
};
// Built-in slur category definitions — MUST stay in sync with server/chat/moderation-utils.js
// (The server module is the authoritative source; update both when changing patterns.)
//
// N-word pattern note: (?:a+[sz]?|e+r+[sz]?) catches base + plural forms:
//   nigga, niggas, niggaz, nigger, niggers, niggaz
// The second pattern catches the "nicker/knicker" alternate-root family.
const CHAT_CORE_SLUR_CATEGORIES = [
    { key: 'n_word', label: 'N-word and variants', patterns: ['\\bn+i+g+g+(?:a+[sz]?|e+r+[sz]?)\\b', '\\b[kn]*n+h?i+c?k+e+r+s?\\b'] },
    { key: 'antisemitic', label: 'Antisemitic slurs', patterns: ['\\bk+\\s*y+\\s*k+\\s*e+\\b', '\\bj+\\s*e+\\s*w+\\s*s?\\s+w+\\s*i+\\s*l+\\s*l+\\s+n+\\s*o+\\s*t+\\s+r+\\s*e+\\s*p+\\s*l+\\s*a+\\s*c+\\s*e+\\b'] },
    { key: 'homophobic', label: 'Homophobic slurs', patterns: ['\\bf+\\s*a+\\s*g+(?:o+\\s*t+)?[sz]?\\b'] },
    { key: 'racial', label: 'Racial slurs (spic, chink)', patterns: ['\\bs+\\s*p+\\s*i+\\s*c+[sz]?\\b', '\\bc+\\s*h+\\s*i+\\s*n+\\s*k+[sz]?\\b'] },
];
for (const cat of CHAT_CORE_SLUR_CATEGORIES) {
    cat.compiled = cat.patterns.map((src) => { try { return new RegExp(src, 'i'); } catch { return null; } }).filter(Boolean);
}
const FULLSCREEN_CHAT_IDLE_MS = 2600;
const FULLSCREEN_CHAT_FADE_MS = 9000;
const FULLSCREEN_CHAT_MAX_MESSAGES = 7;
// Cap on the main chat container so a busy session doesn't accumulate unbounded nodes.
const MAIN_CHAT_MAX_MESSAGES = 500;
let _fullscreenChatIdleTimer = null;
let _fullscreenChatRecent = [];

function normalizeChatAutoDeleteMinutes(value) {
    const minutes = parseInt(value, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) return 0;
    return Math.max(CHAT_SELF_DELETE_MINUTES, minutes);
}

function canUseViewerAutoDeleteHere() {
    return !chatStreamId || !!chatSelfDeletePolicy.allowAutoDelete;
}

function canUseViewerDeleteAllHere() {
    return !chatStreamId || !!chatSelfDeletePolicy.allowDeleteAll;
}

let _settingsSyncTimer = null;

function loadChatSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY));
        if (saved) {
            chatSettings = { ...CHAT_SETTINGS_DEFAULTS, ...saved };
            // Migration: the TTS toggle changed from a receiver-side mute to a
            // sender-side "prefix '.' to skip TTS" control that defaults ON. Old
            // saved settings may carry ttsEnabled:false from the previous default,
            // which would dot-prefix/mute every message — reset it once.
            if (!saved.ttsSendModeV2) {
                chatSettings.ttsEnabled = true;
                chatSettings.ttsSendModeV2 = true;
                try { localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(chatSettings)); } catch { /* */ }
            }
        }
    } catch { /* use defaults */ }
    chatSettings.autoDeleteMinutes = normalizeChatAutoDeleteMinutes(chatSettings.autoDeleteMinutes);
    // Async server sync — merge server settings on top of local
    _syncSettingsFromServer();
}
function saveChatSettings() {
    chatSettings.autoDeleteMinutes = normalizeChatAutoDeleteMinutes(chatSettings.autoDeleteMinutes);
    try { localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(chatSettings)); } catch { }
    applyChatSettings();
    // Debounced push to server
    _debounceSyncSettingsToServer();
}

function _syncSettingsFromServer() {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch('/api/auth/preferences', { headers: { 'Authorization': `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (data?.chatSettings && typeof data.chatSettings === 'object' && Object.keys(data.chatSettings).length > 0) {
                // Server wins on conflicts
                chatSettings = { ...CHAT_SETTINGS_DEFAULTS, ...chatSettings, ...data.chatSettings };
                chatSettings.autoDeleteMinutes = normalizeChatAutoDeleteMinutes(chatSettings.autoDeleteMinutes);
                try { localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(chatSettings)); } catch { }
                applyChatSettings();
                syncSettingsPanelUI();
                syncTTSToggleButtons();
            }
        })
        .catch(() => { /* offline — use local */ });
}

function _debounceSyncSettingsToServer() {
    if (_settingsSyncTimer) clearTimeout(_settingsSyncTimer);
    _settingsSyncTimer = setTimeout(() => {
        const token = localStorage.getItem('token');
        if (!token) return;
        fetch('/api/auth/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ chatSettings })
        }).catch(() => { /* silent fail */ });
    }, 500);
}

function _vcEnsureAudioContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!_vcAudioCtx) {
        try { _vcAudioCtx = new Ctx(); } catch { return null; }
    }
    if (_vcAudioCtx.state === 'suspended') {
        _vcAudioCtx.resume().catch(() => { });
    }
    return _vcAudioCtx;
}

function _vcPlayTone(frequency, durationMs = 150, { type = 'sine', gain = 0.05, delayMs = 0 } = {}) {
    const ctx = _vcEnsureAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime + (delayMs / 1000);
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0001), now + 0.02);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + (durationMs / 1000));

    osc.connect(amp);
    amp.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + (durationMs / 1000) + 0.03);
}

function _vcPlayPattern(steps) {
    let offset = 0;
    for (const step of steps) {
        if (step.freq) {
            _vcPlayTone(step.freq, step.ms || 140, {
                type: step.type || 'sine',
                gain: step.gain ?? 0.055,
                delayMs: offset,
            });
        }
        offset += step.ms || 0;
        offset += step.pause || 0;
    }
    return offset;
}

function _vcStopRingLoop() {
    if (_vcRingLoopTimer) {
        clearInterval(_vcRingLoopTimer);
        _vcRingLoopTimer = null;
    }
}

function _vcStartIncomingRing() {
    _vcStopRingLoop();
    const pattern = [
        { freq: 740, ms: 130, pause: 70, gain: 0.065 },
        { freq: 988, ms: 170, pause: 820, gain: 0.075 },
    ];
    const loopMs = _vcPlayPattern(pattern) + 40;
    _vcRingLoopTimer = setInterval(() => _vcPlayPattern(pattern), loopMs);
}

function _vcStartOutgoingRingback() {
    _vcStopRingLoop();
    const pattern = [
        { freq: 440, ms: 150, pause: 90, gain: 0.05 },
        { freq: 440, ms: 150, pause: 900, gain: 0.05 },
    ];
    const loopMs = _vcPlayPattern(pattern) + 40;
    _vcRingLoopTimer = setInterval(() => _vcPlayPattern(pattern), loopMs);
}

function _vcPlayAcceptedTone() {
    _vcPlayPattern([
        { freq: 523, ms: 110, pause: 40, gain: 0.06 },
        { freq: 659, ms: 130, pause: 30, gain: 0.06 },
        { freq: 784, ms: 180, gain: 0.06 },
    ]);
}

function _vcPlayDeclinedTone() {
    _vcPlayPattern([
        { freq: 370, ms: 150, pause: 60, gain: 0.06, type: 'triangle' },
        { freq: 262, ms: 220, gain: 0.06, type: 'triangle' },
    ]);
}

function _dismissIncomingVcCallOverlay() {
    if (_incomingVcCall?.el?.parentNode) _incomingVcCall.el.parentNode.removeChild(_incomingVcCall.el);
    _incomingVcCall = null;
    if (_incomingVcCallTimeout) {
        clearTimeout(_incomingVcCallTimeout);
        _incomingVcCallTimeout = null;
    }
    _vcStopRingLoop();
}

function _dismissOutgoingVcCallOverlay() {
    if (_outgoingVcCall?.el?.parentNode) _outgoingVcCall.el.parentNode.removeChild(_outgoingVcCall.el);
    _outgoingVcCall = null;
    _vcStopRingLoop();
}

function _showOutgoingVcCallOverlay(targetName, targetUserId, channelId, channelName) {
    _dismissOutgoingVcCallOverlay();

    const safeTargetName = esc(targetName || 'User');
    const overlay = document.createElement('div');
    overlay.className = 'vc-call-toast-overlay vc-call-toast-outgoing';
    overlay.innerHTML = `
        <div class="vc-call-toast-card">
            <div class="vc-call-toast-ring"></div>
            <div class="vc-call-toast-main">
                <div class="vc-call-toast-title">Calling ${safeTargetName}</div>
                <div class="vc-call-toast-subtitle" data-vc-call-status>Ringing...</div>
            </div>
            <button class="vc-call-toast-action vc-call-toast-cancel" type="button" data-vc-cancel-call>
                <i class="fa-solid fa-xmark"></i>
                Cancel
            </button>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('[data-vc-cancel-call]')?.addEventListener('click', () => {
        _dismissOutgoingVcCallOverlay();
        toast('Call canceled', 'info');
    });

    _outgoingVcCall = {
        el: overlay,
        statusEl: overlay.querySelector('[data-vc-call-status]'),
        targetUserId: Number(targetUserId) || 0,
        targetName,
        channelId: String(channelId || ''),
        channelName: channelName || 'Voice Channel',
    };

    _vcStartOutgoingRingback();
}

function _setOutgoingVcCallStatus(text, tone = null, autoDismissMs = 1800) {
    if (!_outgoingVcCall) return;
    if (_outgoingVcCall.statusEl) _outgoingVcCall.statusEl.textContent = text;
    _vcStopRingLoop();
    if (tone === 'accepted') _vcPlayAcceptedTone();
    if (tone === 'declined') _vcPlayDeclinedTone();
    if (autoDismissMs > 0) {
        setTimeout(() => {
            _dismissOutgoingVcCallOverlay();
        }, autoDismissMs);
    }
}

async function _sendVcCallResponse({ callerUserId, channelId, channelName, status }) {
    if (!callerUserId || !channelId || !status) return;
    try {
        await api('/streams/voice-channels/call-user/respond', {
            method: 'POST',
            body: {
                caller_user_id: Number(callerUserId),
                channel_id: String(channelId),
                channel_name: String(channelName || 'Voice Channel'),
                status: String(status),
            },
        });
    } catch {
        // Non-fatal. Joining/declining should still continue client-side.
    }
}

function _showIncomingVcCallOverlay(msg) {
    const callerUserId = Number(msg.fromUserId || 0);
    const channelId = String(msg.channelId || '');
    if (!callerUserId || !channelId) return;

    if (typeof callState !== 'undefined' && callState.joined && callState.channelId !== channelId) {
        _sendVcCallResponse({
            callerUserId,
            channelId,
            channelName: msg.channelName || 'Voice Channel',
            status: 'busy',
        });
        if (typeof toast === 'function') toast(`${msg.fromDisplayName || msg.fromUsername || 'Someone'} tried to call you`, 'info');
        return;
    }

    if (chatSettings.autoDeclineCalls) {
        _sendVcCallResponse({
            callerUserId,
            channelId,
            channelName: msg.channelName || 'Voice Channel',
            status: 'declined',
        });
        return;
    }

    _dismissIncomingVcCallOverlay();

    const callerName = esc(msg.fromDisplayName || msg.fromUsername || 'Someone');
    const channelName = esc(String(msg.channelName || 'Voice Channel'));
    const avatarUrl = msg.fromAvatarUrl ? esc(String(msg.fromAvatarUrl)) : '';

    const overlay = document.createElement('div');
    overlay.className = 'vc-call-overlay';
    overlay.innerHTML = `
        <div class="vc-call-card">
            <div class="vc-call-ring"></div>
            <div class="vc-call-avatar-wrap">
                ${avatarUrl ? `<img class="vc-call-avatar" src="${avatarUrl}" alt="${callerName}">` : '<div class="vc-call-avatar vc-call-avatar-fallback"><i class="fa-solid fa-user"></i></div>'}
            </div>
            <div class="vc-call-heading">Incoming Call</div>
            <div class="vc-call-caller">${callerName}</div>
            <div class="vc-call-channel">${channelName}</div>
            <div class="vc-call-actions">
                <button type="button" class="vc-call-btn vc-call-btn-decline" data-vc-decline>
                    <i class="fa-solid fa-phone-slash"></i>
                    Decline
                </button>
                <button type="button" class="vc-call-btn vc-call-btn-accept" data-vc-accept>
                    <i class="fa-solid fa-phone"></i>
                    Accept
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    _incomingVcCall = {
        el: overlay,
        callerUserId,
        callerName: msg.fromDisplayName || msg.fromUsername || 'Someone',
        channelId,
        channelName: msg.channelName || 'Voice Channel',
    };

    overlay.querySelector('[data-vc-decline]')?.addEventListener('click', async () => {
        const state = _incomingVcCall;
        _dismissIncomingVcCallOverlay();
        if (!state) return;
        await _sendVcCallResponse({
            callerUserId: state.callerUserId,
            channelId: state.channelId,
            channelName: state.channelName,
            status: 'declined',
        });
        toast('Call declined', 'info');
    });

    overlay.querySelector('[data-vc-accept]')?.addEventListener('click', async () => {
        const state = _incomingVcCall;
        _dismissIncomingVcCallOverlay();
        if (!state) return;
        await _sendVcCallResponse({
            callerUserId: state.callerUserId,
            channelId: state.channelId,
            channelName: state.channelName,
            status: 'accepted',
        });
        await acceptVcInvite(state.channelId, state.channelName);
    });

    _incomingVcCallTimeout = setTimeout(async () => {
        const state = _incomingVcCall;
        _dismissIncomingVcCallOverlay();
        if (!state) return;
        await _sendVcCallResponse({
            callerUserId: state.callerUserId,
            channelId: state.channelId,
            channelName: state.channelName,
            status: 'no-answer',
        });
    }, 30000);

    _vcStartIncomingRing();
}

function _handleVcCallResponse(msg) {
    if (!_outgoingVcCall) return;
    const expectedUser = Number(_outgoingVcCall.targetUserId || 0);
    const fromUser = Number(msg.fromUserId || 0);
    if (expectedUser && fromUser && expectedUser !== fromUser) return;
    if (_outgoingVcCall.channelId && msg.channelId && _outgoingVcCall.channelId !== msg.channelId) return;

    const who = msg.fromDisplayName || msg.fromUsername || _outgoingVcCall.targetName || 'User';
    const status = String(msg.status || '').toLowerCase();
    if (status === 'accepted') {
        _setOutgoingVcCallStatus(`${who} accepted`, 'accepted', 1400);
        if (typeof toast === 'function') toast(`${who} accepted your call`, 'success');
        return;
    }
    if (status === 'busy') {
        _setOutgoingVcCallStatus(`${who} is busy`, 'declined', 2000);
        if (typeof toast === 'function') toast(`${who} is already in another call`, 'info');
        return;
    }
    if (status === 'no-answer') {
        _setOutgoingVcCallStatus(`No answer from ${who}`, 'declined', 2200);
        if (typeof toast === 'function') toast(`${who} did not answer`, 'info');
        return;
    }
    _setOutgoingVcCallStatus(`${who} declined`, 'declined', 1800);
    if (typeof toast === 'function') toast(`${who} declined your call`, 'error');
}

function bindContainedChatScroll() {
    const selectors = [
        '.chat-sidebar',
        '.global-chat-main',
        '.offline-global-chat',
        '.chat-vibe-widget-feed',
        '.chat-messages',
        '.global-chat-messages',
        '.fullscreen-chat-messages',
        '.chat-users-panel',
        '.rewards-panel',
    ];

    document.querySelectorAll(selectors.join(', ')).forEach(el => {
        if (!el || el.dataset.scrollContainBound === '1') return;
        el.dataset.scrollContainBound = '1';

        const findNestedScrollable = (node) => {
            while (node && node !== el) {
                if (node instanceof HTMLElement) {
                    const style = window.getComputedStyle(node);
                    const isScrollable = /(auto|scroll)/.test(style.overflowY || '') && node.scrollHeight > node.clientHeight;
                    if (isScrollable) return node;
                }
                node = node.parentElement;
            }
            return null;
        };

        const containScroll = (deltaY, event) => {
            const canScroll = el.scrollHeight > (el.clientHeight + 1);
            if (!canScroll) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            const atTop = el.scrollTop <= 0;
            const atBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight;
            if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
                event.preventDefault();
            }
            event.stopPropagation();
        };

        el.addEventListener('wheel', (event) => {
            if (Math.abs(event.deltaY) >= Math.abs(event.deltaX || 0)) {
                const nestedScrollable = findNestedScrollable(event.target);
                if (nestedScrollable && nestedScrollable !== el) {
                    return;
                }
                containScroll(event.deltaY, event);
            }
        }, { passive: false });

        let lastTouchY = null;
        el.addEventListener('touchstart', (event) => {
            if (event.touches && event.touches.length) {
                lastTouchY = event.touches[0].clientY;
            }
        }, { passive: true });
        el.addEventListener('touchmove', (event) => {
            if (!event.touches || !event.touches.length || lastTouchY == null) return;
            const currentY = event.touches[0].clientY;
            const deltaY = lastTouchY - currentY;
            lastTouchY = currentY;
            // Same bail-out the wheel handler has: touches inside a nested scrollable
            // (settings panel, users panel, …) scroll THAT element — without this the
            // sidebar's containScroll preventDefault()s every finger-scroll on mobile.
            const nestedScrollable = findNestedScrollable(event.target);
            if (nestedScrollable && nestedScrollable !== el) return;
            containScroll(deltaY, event);
        }, { passive: false });
        el.addEventListener('touchend', () => { lastTouchY = null; }, { passive: true });
        el.addEventListener('touchcancel', () => { lastTouchY = null; }, { passive: true });
    });
}

function applyChatSettings() {
    bindContainedChatScroll();
    // Font size
    document.querySelectorAll('.chat-messages, .global-chat-messages').forEach(el => {
        el.classList.remove('chat-font-small', 'chat-font-large');
        if (chatSettings.fontSize === 'small') el.classList.add('chat-font-small');
        if (chatSettings.fontSize === 'large') el.classList.add('chat-font-large');
    });
    // Animated emotes
    document.documentElement.classList.toggle('chat-no-animated-emotes', !chatSettings.animatedEmotes);
    // Emote scale
    document.documentElement.classList.remove('chat-emote-small', 'chat-emote-large');
    if (chatSettings.emoteScale === 'small') document.documentElement.classList.add('chat-emote-small');
    if (chatSettings.emoteScale === 'large') document.documentElement.classList.add('chat-emote-large');
    // Avatars
    document.documentElement.classList.toggle('chat-hide-avatars', !chatSettings.showAvatars);
    // Badges
    document.documentElement.classList.toggle('chat-hide-badges', !chatSettings.showBadges);
    // Alternate backgrounds
    document.documentElement.classList.toggle('chat-alt-bg', chatSettings.alternateBackground);
    // System messages
    document.documentElement.classList.toggle('chat-hide-system', !chatSettings.showSystemMessages);
    // Cross-slot chat visibility ("Show All Chats Under This Streamer")
    document.documentElement.classList.toggle('chat-hide-otherslots', chatSettings.showOtherSlotsInStream === false);
    // Compact mode (used by popout and any surface that renders .pc-msgs or .chat-messages)
    document.querySelectorAll('.chat-messages, .global-chat-messages, #pc-msgs').forEach(el => {
        el.classList.toggle('compact', !!chatSettings.compactMode);
    });
    // Sync all settings panel checkboxes/selects if any are open
    syncSettingsPanelUI();
    updateFullscreenChatOverlayState();
}
function syncSettingsPanelUI() {
    document.querySelectorAll('.chat-settings-panel').forEach(panel => {
        panel.querySelectorAll('[data-setting]').forEach(el => {
            const key = el.dataset.setting;
            if (el.type === 'checkbox') el.checked = chatSettings[key];
            else if (el.type === 'range') el.value = chatSettings[key];
            else if (el.tagName === 'SELECT') el.value = chatSettings[key];
        });

        const autoDeleteSelect = panel.querySelector('[data-setting="autoDeleteMinutes"]');
        if (autoDeleteSelect) {
            autoDeleteSelect.disabled = !canUseViewerAutoDeleteHere();
        }

        const deleteBtn = panel.querySelector('.csp-delete-own-btn');
        if (deleteBtn) {
            deleteBtn.disabled = !canUseViewerDeleteAllHere();
            deleteBtn.title = canUseViewerDeleteAllHere()
                ? 'Delete all of your messages from this chat'
                : 'Disabled by the streamer for this chat';
        }

        const hint = panel.querySelector('.csp-self-delete-hint');
        if (hint) {
            const scopeLabel = chatStreamId ? 'this stream chat' : 'global chat';
            if (!chatStreamId) {
                hint.textContent = `Applies to your own new messages in ${scopeLabel}. Minimum ${chatSelfDeletePolicy.minMinutes} minutes.`;
            } else if (!canUseViewerAutoDeleteHere() && !canUseViewerDeleteAllHere()) {
                hint.textContent = 'This streamer has disabled viewer self-delete tools in this chat.';
            } else if (!canUseViewerAutoDeleteHere()) {
                hint.textContent = 'Manual delete-all is allowed here, but auto-delete timers are disabled by the streamer.';
            } else if (!canUseViewerDeleteAllHere()) {
                hint.textContent = `Auto-delete is allowed here, but manual delete-all is disabled by the streamer. Minimum ${chatSelfDeletePolicy.minMinutes} minutes.`;
            } else {
                hint.textContent = `Applies to your own new messages in ${scopeLabel}. Minimum ${chatSelfDeletePolicy.minMinutes} minutes.`;
            }
        }
    });
    syncTTSToggleButtons();
}

function isBroadcastingLiveForTTS() {
    return typeof isStreaming === 'function' && isStreaming();
}

// ── Own-channel TTS: one speaking tab per device ─────────────────────────────
// "TTS On My Channel When Live" must play in exactly ONE tab per browser no matter
// how many chats/popouts the streamer has open — otherwise every tab speaks every
// message on top of each other. The first tab takes a Web Lock and becomes the
// speaker; the rest stand by and take over automatically when it closes. Browsers
// without the Web Locks API keep the old every-tab behavior.
let _ownTtsLeader = !(typeof navigator !== 'undefined' && 'locks' in navigator);
(function _startOwnTtsLeadership() {
    if (_ownTtsLeader) return;
    try {
        // Queued (not ifAvailable) request = proper leader election: every tab waits
        // in line, and the INSTANT the speaking tab closes, the browser grants the
        // lock to the next one — TTS recovers by itself with no polling gap.
        navigator.locks.request('openvibe-own-channel-tts', () => {
            _ownTtsLeader = true;
            return new Promise(() => { }); // hold until this tab closes
        }).catch(() => { _ownTtsLeader = true; }); // lock machinery failed → don't go silent
    } catch { _ownTtsLeader = true; }
})();
function isOwnChannelTtsSpeaker() { return _ownTtsLeader; }

// Is the ACTIVE chat surface the logged-in user's OWN channel? Works on every
// surface — channel page, offline chat, popout — unlike isStreaming(), which only
// exists on the broadcast page (that gap is why own-channel TTS died in popouts
// after a live-stream swap).
function _isOwnChannelChat() {
    return !!(typeof currentUser !== 'undefined' && currentUser && chatChannelUserId
        && Number(chatChannelUserId) === Number(currentUser.id));
}
// Own-channel TTS gating: live context (a stream id is joined) follows "TTS On My
// Channel When Live"; offline channel chat follows "TTS On My Channel When Offline".
function _ownChannelTtsWanted() {
    return chatStreamId ? !!chatSettings.streamingTtsEnabled : !!chatSettings.channelTtsAlways;
}

// Who this tab is chatting as — set by the server's 'auth' confirmation.
let _myChatIdentity = null;
// Set before a same-socket surface rejoin (live↔offline swap) so the re-issued auth
// confirmation doesn't post a second "Chatting as …" notice.
let _suppressNextAuthNotice = false;

// A user must NEVER hear their own message's TTS locally. The speaker button under
// the input is a SENDER-side control (does your message get read out on the
// streamer's end), not a local monitor — playing it locally meant senders heard
// every message twice: once in their tab, once through the stream audio. The one
// exception is the streamer listening to their OWN channel while live (they ARE the
// audience there) — those paths deliberately don't call this filter.
function _isOwnTtsMessage(msg) {
    try {
        if (msg.sender_key && _myChatIdentity && _myChatIdentity.key) {
            return msg.sender_key === _myChatIdentity.key;
        }
        // Legacy payloads without sender_key: match by name.
        const name = String(msg.core_username || msg.username || '');
        if (!name || !_myChatIdentity) return false;
        return name === _myChatIdentity.name || (!!_myChatIdentity.core && name === _myChatIdentity.core);
    } catch { return false; }
}

// ── Cross-tab settings sync ──────────────────────────────────────────────────
// chatSettings persist in localStorage; the storage event fires in every OTHER
// tab on save, so a toggle flipped anywhere applies everywhere immediately —
// turning TTS off in one tab silences all of them instead of looking broken.
window.addEventListener('storage', (e) => {
    if (e.key !== CHAT_SETTINGS_KEY || !e.newValue) return;
    try {
        const next = JSON.parse(e.newValue);
        if (!next || typeof next !== 'object') return;
        const ttsWasOn = !!chatSettings.ttsEnabled;
        const streamTtsWasOn = !!chatSettings.streamingTtsEnabled;
        const alwaysWasOn = !!chatSettings.channelTtsAlways;
        chatSettings = { ...CHAT_SETTINGS_DEFAULTS, ...next };
        chatSettings.autoDeleteMinutes = normalizeChatAutoDeleteMinutes(chatSettings.autoDeleteMinutes);
        applyChatSettings();
        syncTTSToggleButtons();
        // TTS switched off elsewhere → stop anything already queued/speaking here too.
        if ((ttsWasOn && !chatSettings.ttsEnabled) || (streamTtsWasOn && !chatSettings.streamingTtsEnabled)
            || (alwaysWasOn && !chatSettings.channelTtsAlways)) cancelAllTTS();
    } catch { /* ignore malformed writes */ }
});

/** True when the main chat WS is connected to the user's own broadcast stream */
function _isViewingOwnBroadcastChat() {
    if (!isBroadcastingLiveForTTS()) return false;
    // If background WS exists, we navigated away from our own broadcast page
    if (_bgBroadcastStreamId) return false;
    return true;
}

function getChatTTSSettingKey(options = {}) {
    if (options.button) {
        const inBroadcastPage = !!options.button.closest('#page-broadcast');
        if (inBroadcastPage && isBroadcastingLiveForTTS()) return 'streamingTtsEnabled';
    }
    if (options.streaming || options.forceStreaming || options.page === 'broadcast') {
        return 'streamingTtsEnabled';
    }
    return 'ttsEnabled';
}

function isChatTTSEnabled(options = {}) {
    const key = getChatTTSSettingKey(options);
    return !!chatSettings[key];
}

/** Chat sound clips (soundboard + channel !sound commands) — independent of TTS. */
function isChatSoundsEnabled() {
    return chatSettings.soundsEnabled !== false;
}

/**
 * Apply the streamer's per-channel emote display size. `percent` is 50–300
 * (100 = default). Sets a CSS variable read by the .chat-emote height rules.
 */
function applyChannelEmoteScale(percent) {
    let pct = parseInt(percent, 10);
    if (!Number.isFinite(pct)) pct = 100;
    pct = Math.min(300, Math.max(50, pct));
    try { document.documentElement.style.setProperty('--chat-emote-scale', String(pct / 100)); } catch { /* no-op */ }
}

/** Returns true if TTS should fire for a message with the given source_platform string */
function _isTTSEnabledForSource(sourcePlatform) {
    const src = (sourcePlatform || '').toLowerCase();
    if (!src || src === 'native' || src === 'live') return chatSettings.ttsSrcNative !== false;
    if (src === 'rs' || src === 'robotstreamer') return chatSettings.ttsSrcRS !== false;
    if (src === 'kick') return chatSettings.ttsSrcKick !== false;
    if (src === 'youtube') return chatSettings.ttsSrcYoutube !== false;
    if (src === 'twitch') return chatSettings.ttsSrcTwitch !== false;
    return true; // unknown source: allow by default
}

function refreshChatTTSContext() {
    syncTTSToggleButtons();
    syncSettingsPanelUI();
}
// Initialize on load
loadChatSettings();

// ── Context menu state ───────────────────────────────────────
let activeContextMenu = null;

/**
 * Detect which chat UI is active (channel page vs broadcast page vs global chat page vs offline)
 * and return the correct input + messages container elements.
 */
function getChatEl() {
    // Global chat page
    const chatPage = document.getElementById('page-chat');
    if (chatPage && chatPage.classList.contains('active')) {
        return {
            input: document.getElementById('global-chat-input'),
            messages: document.getElementById('global-chat-messages'),
            isGlobal: true,
        };
    }
    // Offline channel page with global chat — only if the channel page is actually active
    const channelPage = document.getElementById('page-channel');
    if (channelPage && channelPage.classList.contains('active')) {
        const offlineArea = document.getElementById('ch-offline-area');
        if (offlineArea && offlineArea.style.display !== 'none') {
            const offlineChat = document.getElementById('offline-chat-messages');
            if (offlineChat) {
                return {
                    input: document.getElementById('offline-chat-input'),
                    messages: offlineChat,
                    isGlobal: true,
                };
            }
        }
    }
    const bcPage = document.getElementById('page-broadcast');
    const isBroadcast = bcPage && bcPage.classList.contains('active');
    if (isBroadcast) {
        return {
            input: document.getElementById('bc-chat-input'),
            messages: document.getElementById('bc-chat-messages'),
        };
    }
    const popoutMessages = document.getElementById('pc-msgs');
    if (popoutMessages) {
        return {
            input: document.getElementById('pc-input'),
            messages: popoutMessages,
            isPopout: true,
        };
    }
    return {
        input: document.getElementById('chat-input'),
        messages: document.getElementById('chat-messages'),
    };
}

function getChatRenderTargetId() {
    return getChatEl().messages?.id || null;
}

function _getVibeWidgetContext() {
    let streamData = currentStreamData;
    if ((!streamData || streamData.id !== chatStreamId) && typeof broadcastState !== 'undefined' && broadcastState?.streams && chatStreamId) {
        const stateEntry = broadcastState.streams instanceof Map
            ? broadcastState.streams.get(chatStreamId)
            : broadcastState.streams[chatStreamId];
        if (stateEntry?.streamData) {
            streamData = stateEntry.streamData;
        }
    }
    const username = streamData?.username || currentUser?.username || null;
    const slotRef = streamData?.managed_stream_slug || streamData?.managed_stream_id || null;
    const managedStreamId = streamData?.managed_stream_id || null;
    if (!username || !slotRef || !managedStreamId) return null;
    return { username, slotRef, managedStreamId };
}

function _clearVibeWidgetTimers() {
    (_vibeWidgetState.timers || []).forEach((timerId) => clearTimeout(timerId));
    _vibeWidgetState.timers = [];
}

function _clearVibeWidgetRefreshTimer() {
    if (_vibeWidgetState.refreshTimer) {
        clearInterval(_vibeWidgetState.refreshTimer);
        _vibeWidgetState.refreshTimer = null;
    }
}

function _setVibeWidgetCollapsed(collapsed) {
    _vibeWidgetState.collapsed = !!collapsed;
    _saveVibeWidgetCollapsedPreference(_vibeWidgetState.collapsed);
    if (_vibeWidgetState.panel) {
        _renderVibeWidget();
    }
}

function _toggleVibeWidgetCollapsed() {
    _setVibeWidgetCollapsed(!_vibeWidgetState.collapsed);
}

function _resetVibeWidget(removePanel = false) {
    _clearVibeWidgetTimers();
    _clearVibeWidgetRefreshTimer();
    _vibeWidgetState.key = null;
    _vibeWidgetState.settings = null;
    _vibeWidgetState.publisher = null;
    _vibeWidgetState.events = [];
    _vibeWidgetState.userScrolledUp = false;
    _vibeWidgetState.unreadCount = 0;
    _vibeWidgetState.syncState = 'idle';
    _vibeWidgetState.lastSyncedAt = 0;
    if (removePanel && _vibeWidgetState.panel) {
        _vibeWidgetState.panel.remove();
        _vibeWidgetState.panel = null;
        _vibeWidgetState.feed = null;
        _vibeWidgetState.indicator = null;
        _vibeWidgetState.openDisclosures.clear();
        return;
    }
    if (_vibeWidgetState.feed) {
        _vibeWidgetState.feed.innerHTML = '';
    }
    _hideVibeWidgetNewMessagesIndicator();
    if (_vibeWidgetState.panel) {
        _vibeWidgetState.panel.style.display = 'none';
    }
}

function _getVibeWidgetHost() {
    const { messages } = getChatEl();
    if (!messages) return null;
    return messages.closest('#chat-sidebar, .chat-sidebar, .bc-chat-sidebar, .chat-panel, .bc-ws-panel, .bc-chat-panel')
        || messages.parentElement
        || null;
}

function _ensureVibeWidgetPanel() {
    const host = _getVibeWidgetHost();
    if (!host) return null;
    let panel = host.querySelector('.chat-vibe-widget');
    if (!panel) {
        panel = document.createElement('section');
        panel.className = 'chat-vibe-widget';
        panel.innerHTML = '<div class="chat-vibe-widget-head"><div class="chat-vibe-widget-title"><i class="fa-solid fa-code"></i> <span>Vibe Coding</span></div><div class="chat-vibe-widget-actions"><div class="chat-vibe-widget-status">Live</div><button type="button" class="chat-vibe-widget-toggle" aria-expanded="true">Hide</button></div></div><div class="chat-vibe-widget-feed" tabindex="0" aria-label="Vibe coding event feed"></div><button type="button" class="chat-vibe-new-msgs-indicator is-hidden" aria-hidden="true"><i class="fa-solid fa-arrow-down"></i> New messages below</button>';
        const header = host.querySelector('.chat-header, .global-chat-header');
        if (header) header.after(panel);
        else host.prepend(panel);
    }
    if (panel.dataset.vibeWidgetBound !== '1') {
        const toggle = panel.querySelector('.chat-vibe-widget-toggle');
        if (toggle) {
            toggle.addEventListener('click', () => {
                _toggleVibeWidgetCollapsed();
            });
        }
        panel.dataset.vibeWidgetBound = '1';
    }
    _vibeWidgetState.panel = panel;
    _vibeWidgetState.feed = panel.querySelector('.chat-vibe-widget-feed');
    _vibeWidgetState.indicator = panel.querySelector('.chat-vibe-new-msgs-indicator');
    if (_vibeWidgetState.feed && _vibeWidgetState.feed.dataset.vibeWidgetScrollBound !== '1') {
        _vibeWidgetState.feed.dataset.vibeWidgetScrollBound = '1';
        _vibeWidgetState.feed.addEventListener('scroll', () => {
            _syncVibeWidgetScrollState();
        }, { passive: true });
        _vibeWidgetState.feed.addEventListener('toggle', (event) => {
            const details = event.target.closest('details');
            if (!details || !details.dataset.vibeDisclosureKey) return;
            if (details.open) {
                _vibeWidgetState.openDisclosures.add(details.dataset.vibeDisclosureKey);
            } else {
                _vibeWidgetState.openDisclosures.delete(details.dataset.vibeDisclosureKey);
            }
        });
    }
    if (_vibeWidgetState.indicator && _vibeWidgetState.indicator.dataset.vibeWidgetIndicatorBound !== '1') {
        _vibeWidgetState.indicator.dataset.vibeWidgetIndicatorBound = '1';
        _vibeWidgetState.indicator.addEventListener('click', () => {
            _scrollVibeWidgetToBottom();
        });
    }
    return panel;
}

function _getVibeWidgetFetchLimit() {
    return Math.max(VIBE_WIDGET_FALLBACK_MAX, parseInt(_vibeWidgetState.settings?.max_events, 10) || 0);
}

function _getVibeWidgetEventKey(event) {
    if (!event) return '';
    return String(
        event.eventId
        || [event.sessionId || '', event.sequence || '', event.eventType || '', event.summary || '', event.occurredAt || ''].join(':')
    );
}

function _sortVibeWidgetEvents(events) {
    return (Array.isArray(events) ? events.slice() : []).sort((left, right) => {
        const leftSeq = Number(left?.sequence || 0);
        const rightSeq = Number(right?.sequence || 0);
        if (leftSeq && rightSeq && leftSeq !== rightSeq) {
            return leftSeq - rightSeq;
        }

        const leftTime = Date.parse(left?.occurredAt || '') || 0;
        const rightTime = Date.parse(right?.occurredAt || '') || 0;
        if (leftTime !== rightTime) {
            return leftTime - rightTime;
        }

        return _getVibeWidgetEventKey(left).localeCompare(_getVibeWidgetEventKey(right));
    });
}

function _replaceVibeWidgetEvents(events) {
    const deduped = [];
    const seen = new Set();
    _sortVibeWidgetEvents(events).forEach((event) => {
        const key = _getVibeWidgetEventKey(event);
        if (!key || seen.has(key)) return;
        seen.add(key);
        deduped.push(event);
    });
    const maxStored = Math.max(_getVibeWidgetFetchLimit() * 3, VIBE_WIDGET_FALLBACK_MAX);
    _vibeWidgetState.events = deduped.slice(-maxStored);
}

function _mergeVibeWidgetEvents(events) {
    const existingKeys = new Set(_vibeWidgetState.events.map((event) => _getVibeWidgetEventKey(event)));
    const nextEvents = _vibeWidgetState.events.slice();
    let added = 0;
    (Array.isArray(events) ? events : []).forEach((event) => {
        const key = _getVibeWidgetEventKey(event);
        if (!key || existingKeys.has(key)) return;
        existingKeys.add(key);
        nextEvents.push(event);
        added += 1;
    });
    if (!added) return 0;
    _replaceVibeWidgetEvents(nextEvents);
    return added;
}

function _isVibeWidgetNearBottom() {
    const feed = _vibeWidgetState.feed;
    if (!feed) return true;
    return (feed.scrollHeight - feed.scrollTop - feed.clientHeight) < VIBE_WIDGET_SCROLL_THRESHOLD;
}

function _showVibeWidgetNewMessagesIndicator() {
    const indicator = _vibeWidgetState.indicator;
    if (!indicator || _vibeWidgetState.collapsed || !_vibeWidgetState.unreadCount) return;
    indicator.innerHTML = `<i class="fa-solid fa-arrow-down"></i> ${_vibeWidgetState.unreadCount} new message${_vibeWidgetState.unreadCount !== 1 ? 's' : ''} below`;
    indicator.style.display = '';
    indicator.classList.remove('is-hidden');
    indicator.classList.add('is-visible');
    indicator.setAttribute('aria-hidden', 'false');
}

function _hideVibeWidgetNewMessagesIndicator() {
    if (_vibeWidgetState.indicator) {
        _vibeWidgetState.indicator.style.display = '';
        _vibeWidgetState.indicator.classList.remove('is-visible');
        _vibeWidgetState.indicator.classList.add('is-hidden');
        _vibeWidgetState.indicator.setAttribute('aria-hidden', 'true');
    }
}

function _scrollVibeWidgetToBottom() {
    const feed = _vibeWidgetState.feed;
    if (!feed) return;
    feed.scrollTop = feed.scrollHeight;
    _vibeWidgetState.userScrolledUp = false;
    _vibeWidgetState.unreadCount = 0;
    _hideVibeWidgetNewMessagesIndicator();
}

function _syncVibeWidgetScrollState() {
    if (_isVibeWidgetNearBottom()) {
        _vibeWidgetState.userScrolledUp = false;
        _vibeWidgetState.unreadCount = 0;
        _hideVibeWidgetNewMessagesIndicator();
        return;
    }
    _vibeWidgetState.userScrolledUp = true;
}

function _ensureVibeWidgetRefreshTimer() {
    if (_vibeWidgetState.refreshTimer) return;
    _vibeWidgetState.refreshTimer = setInterval(() => {
        if (!_vibeWidgetState.key || document.hidden) return;
        refreshVibeWidgetFeed().catch(() => { });
    }, VIBE_WIDGET_REFRESH_MS);
}

function _formatVibeEventTime(value) {
    const time = Date.parse(value || '');
    if (!time) return '';
    try {
        return new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    } catch {
        return '';
    }
}

function _normalizeVibeDisplayText(value) {
    return String(value || '')
        .replace(/\r/g, ' ')
        .replace(/`+/g, '')
        .replace(/\binlineReference\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'reference')
        .replace(/\s*#{1,6}\s*/g, ' ')
        .replace(/\s+([.,;:!?])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function _truncateVibeDisplayText(value, maxChars = 84) {
    const text = _normalizeVibeDisplayText(value);
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(24, maxChars - 1)).trim()}…`;
}

function _splitVibeNarrative(value, maxSegments = 3) {
    const text = _normalizeVibeDisplayText(value);
    if (!text) return [];
    const parts = text
        .split(/(?<=[.!?])\s+(?=(?:[A-Z0-9✅❌•-]))/g)
        .map((part) => _normalizeVibeDisplayText(part))
        .filter(Boolean);
    if (parts.length <= 1) return [text];
    if (parts.length <= maxSegments) return parts;
    const tailCount = Math.max(1, maxSegments - 1);
    const head = _normalizeVibeDisplayText(parts.slice(0, parts.length - tailCount).join(' '));
    return [head, ...parts.slice(-tailCount)].filter(Boolean);
}

function _extractVibeListParts(value) {
    const text = _normalizeVibeDisplayText(value);
    if (!text || !/\s[•-]\s/.test(text) && !/^[•-]\s/.test(text)) {
        return { lead: text, items: [] };
    }
    const startsWithBullet = /^[•-]\s/.test(text);
    const normalized = startsWithBullet ? text.replace(/^[•-]\s+/, '') : text;
    const parts = normalized
        .split(/\s+[•-]\s+/g)
        .map((part) => _normalizeVibeDisplayText(part))
        .filter(Boolean);
    if (parts.length < 2) {
        return { lead: text, items: [] };
    }
    if (startsWithBullet) {
        return { lead: '', items: parts };
    }
    return { lead: parts[0], items: parts.slice(1) };
}

function _pushUniqueVibeBlock(blocks, blockText) {
    const text = _normalizeVibeDisplayText(blockText);
    if (!text) return;
    const normalized = text.toLowerCase();
    const exactIndex = blocks.findIndex((block) => block.normalized === normalized);
    if (exactIndex >= 0) return;
    const containingIndex = blocks.findIndex((block) => text.includes(block.text) && text.length > block.text.length);
    if (containingIndex >= 0) {
        blocks[containingIndex] = { text, normalized };
        for (let index = blocks.length - 1; index >= 0; index -= 1) {
            if (index === containingIndex) continue;
            if (text.includes(blocks[index].text)) {
                blocks.splice(index, 1);
            }
        }
        return;
    }
    if (blocks.some((block) => block.text.includes(text))) return;
    blocks.push({ text, normalized });
}

function _createVibeTurn(event, key) {
    const occurredAt = event?.occurredAt || '';
    return {
        kind: 'turn',
        key,
        occurredAt,
        lastAt: occurredAt,
        promptText: '',
        responseBlocks: [],
        thinkingBlocks: [],
        sourceLabel: _normalizeVibeDisplayText(event?.publisher?.integrationLabel || ''),
        tools: new Map(),
        files: new Map(),
    };
}

function _isVibeExecutionToolName(toolName) {
    const normalized = _normalizeVibeDisplayText(toolName).toLowerCase();
    return normalized === 'run_in_terminal'
        || normalized === 'create_and_run_task'
        || normalized === 'run_notebook_cell';
}

function _hasMeaningfulVibeToolPreview(tool) {
    const preview = _normalizeVibeDisplayText(tool?.preview || '');
    if (!preview) return false;
    const normalizedName = _normalizeVibeDisplayText(tool?.name || '').toLowerCase();
    return preview.toLowerCase() !== `used ${normalizedName}`;
}

function _formatVibeToolLabel(toolName) {
    const normalized = _normalizeVibeDisplayText(toolName);
    if (!normalized) return 'Tool';
    return normalized
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function _canReuseLoosePromptTurn(turn, promptText, event) {
    if (!turn || !promptText) return false;
    if (_normalizeVibeDisplayText(turn.promptText).toLowerCase() !== promptText.toLowerCase()) {
        return false;
    }
    return _canMergeLooseVibeEvent(turn, event);
}

function _claimPendingVibePromptTurn(pendingPromptTurns, event) {
    for (let index = 0; index < pendingPromptTurns.length; index += 1) {
        const candidate = pendingPromptTurns[index];
        if (!_canMergeLooseVibeEvent(candidate, event)) continue;
        pendingPromptTurns.splice(index, 1);
        return candidate;
    }
    return null;
}

function _addVibeToolToTurn(turn, event) {
    const toolName = _normalizeVibeDisplayText(event?.tool?.name || event?.summary || 'tool');
    if (!toolName) return;
    const existing = turn.tools.get(toolName);
    const argumentsPreview = _normalizeVibeDisplayText(event?.tool?.argumentsPreview || '');
    const resultPreview = _normalizeVibeDisplayText(event?.tool?.resultPreview || '');
    const preview = [
        argumentsPreview,
        resultPreview,
        event?.summary,
    ]
        .map((value) => _normalizeVibeDisplayText(value))
        .find((value) => value && value.toLowerCase() !== toolName.toLowerCase()) || '';
    turn.tools.set(toolName, {
        name: toolName,
        label: _formatVibeToolLabel(toolName),
        count: (existing?.count || 0) + 1,
        argumentsPreview: argumentsPreview || existing?.argumentsPreview || '',
        resultPreview: resultPreview || existing?.resultPreview || '',
        preview: preview || existing?.preview || '',
        isExecution: _isVibeExecutionToolName(toolName),
    });
}

function _addVibeFileToTurn(turn, event) {
    const fileName = _normalizeVibeDisplayText(event?.file?.relativePath || event?.file?.name || event?.summary || 'file');
    if (!fileName) return;
    const existing = turn.files.get(fileName);
    const operation = event?.file?.operation === 'save' ? 'save' : 'edit';
    const changeCount = Math.max(0, Number(event?.file?.changeCount || 0));
    const snippet = _normalizeVibeDisplayText(event?.file?.snippet || '');
    turn.files.set(fileName, {
        name: fileName,
        count: (existing?.count || 0) + 1,
        changeCount: (existing?.changeCount || 0) + changeCount,
        edited: !!existing?.edited || operation === 'edit',
        saved: !!existing?.saved || operation === 'save',
        snippet: snippet || existing?.snippet || '',
    });
}

function _getExplicitVibeTurnKey(event) {
    const requestId = _normalizeVibeDisplayText(event?.metadata?.requestId);
    const responseId = _normalizeVibeDisplayText(event?.metadata?.responseId);
    if (requestId || responseId) {
        return `turn:${requestId || responseId}:${responseId || ''}`;
    }
    return '';
}

function _ensureVibeTurn(items, turns, key, event) {
    let turn = turns.get(key);
    if (turn) return turn;
    turn = _createVibeTurn(event, key);
    turns.set(key, turn);
    items.push(turn);
    return turn;
}

function _canMergeLooseVibeEvent(turn, event) {
    if (!turn || !event || event?.eventType === 'prompt' || event?.eventType === 'session.status') {
        return false;
    }
    const turnTime = Date.parse(turn.lastAt || turn.occurredAt || '') || 0;
    const eventTime = Date.parse(event?.occurredAt || '') || 0;
    if (turnTime && eventTime && Math.abs(eventTime - turnTime) > (5 * 60 * 1000)) {
        return false;
    }
    return true;
}

function _getVibeTurnTimeValue(turn, preferLast = false) {
    if (!turn) return 0;
    const preferred = Date.parse(preferLast ? (turn.lastAt || turn.occurredAt || '') : (turn.occurredAt || turn.lastAt || '')) || 0;
    if (preferred) return preferred;
    return Date.parse(turn.occurredAt || turn.lastAt || '') || 0;
}

function _getVibeTurnTextValues(turn) {
    const values = [];
    if (turn?.promptText) values.push(_normalizeVibeDisplayText(turn.promptText));
    (Array.isArray(turn?.responseBlocks) ? turn.responseBlocks : []).forEach((block) => values.push(_normalizeVibeDisplayText(block?.text || block)));
    (Array.isArray(turn?.thinkingBlocks) ? turn.thinkingBlocks : []).forEach((block) => values.push(_normalizeVibeDisplayText(block?.text || block)));
    return values.filter(Boolean);
}

function _getVibeTextTokenCount(leftText, rightText) {
    const leftTokens = Array.from(new Set(_normalizeVibeDisplayText(leftText).toLowerCase().split(/[^a-z0-9]+/g).filter((token) => token.length >= 4)));
    if (!leftTokens.length) return 0;
    const rightTokens = new Set(_normalizeVibeDisplayText(rightText).toLowerCase().split(/[^a-z0-9]+/g).filter((token) => token.length >= 4));
    return leftTokens.reduce((count, token) => count + (rightTokens.has(token) ? 1 : 0), 0);
}

function _getVibeTurnOverlapScore(sourceTurn, targetTurn) {
    const sourceTexts = _getVibeTurnTextValues(sourceTurn);
    const targetTexts = _getVibeTurnTextValues(targetTurn);
    let bestScore = 0;
    sourceTexts.forEach((sourceText) => {
        targetTexts.forEach((targetText) => {
            if (!sourceText || !targetText) return;
            if (sourceText === targetText) {
                bestScore = Math.max(bestScore, 100);
                return;
            }
            if (targetText.includes(sourceText) || sourceText.includes(targetText)) {
                bestScore = Math.max(bestScore, 60);
                return;
            }
            bestScore = Math.max(bestScore, _getVibeTextTokenCount(sourceText, targetText));
        });
    });
    return bestScore;
}

function _mergeVibeBlockHistory(existingBlocks, incomingBlocks, placeIncomingFirst) {
    const ordered = placeIncomingFirst
        ? [...(incomingBlocks || []), ...(existingBlocks || [])]
        : [...(existingBlocks || []), ...(incomingBlocks || [])];
    const merged = [];
    ordered.forEach((block) => {
        const text = _normalizeVibeDisplayText(block?.text || block);
        if (!text) return;
        const normalized = text.toLowerCase();
        if (merged.some((item) => item.normalized === normalized)) return;
        merged.push({ text, normalized });
    });
    return merged;
}

function _mergeVibeTurnIntoTarget(targetTurn, sourceTurn) {
    if (!targetTurn || !sourceTurn || targetTurn === sourceTurn) return;
    const sourceTime = _getVibeTurnTimeValue(sourceTurn, true);
    const targetStart = _getVibeTurnTimeValue(targetTurn, false);
    const placeIncomingFirst = !!sourceTime && !!targetStart && sourceTime <= targetStart;

    targetTurn.responseBlocks = _mergeVibeBlockHistory(targetTurn.responseBlocks, sourceTurn.responseBlocks, placeIncomingFirst);
    targetTurn.thinkingBlocks = _mergeVibeBlockHistory(targetTurn.thinkingBlocks, sourceTurn.thinkingBlocks, placeIncomingFirst);

    sourceTurn.tools.forEach((tool, toolName) => {
        const existing = targetTurn.tools.get(toolName);
        targetTurn.tools.set(toolName, {
            name: tool.name,
            label: existing?.label || tool?.label || _formatVibeToolLabel(tool.name),
            count: (existing?.count || 0) + (tool?.count || 0),
            argumentsPreview: existing?.argumentsPreview || tool?.argumentsPreview || '',
            resultPreview: existing?.resultPreview || tool?.resultPreview || '',
            preview: existing?.preview || tool?.preview || '',
            isExecution: !!existing?.isExecution || !!tool?.isExecution,
        });
    });

    sourceTurn.files.forEach((file, fileName) => {
        const existing = targetTurn.files.get(fileName);
        targetTurn.files.set(fileName, {
            name: file.name,
            count: (existing?.count || 0) + (file?.count || 0),
            changeCount: (existing?.changeCount || 0) + (file?.changeCount || 0),
            edited: !!existing?.edited || !!file?.edited,
            saved: !!existing?.saved || !!file?.saved,
            snippet: existing?.snippet || file?.snippet || '',
        });
    });

    if (!targetTurn.sourceLabel && sourceTurn.sourceLabel) {
        targetTurn.sourceLabel = sourceTurn.sourceLabel;
    }
    if (!targetTurn.occurredAt || (sourceTurn.occurredAt && Date.parse(sourceTurn.occurredAt) < Date.parse(targetTurn.occurredAt))) {
        targetTurn.occurredAt = sourceTurn.occurredAt || targetTurn.occurredAt;
    }
    if (!targetTurn.lastAt || (sourceTurn.lastAt && Date.parse(sourceTurn.lastAt) > Date.parse(targetTurn.lastAt))) {
        targetTurn.lastAt = sourceTurn.lastAt || targetTurn.lastAt;
    }
}

function _getVibeLooseMergeScore(sourceTurn, targetTurn) {
    if (!sourceTurn || !targetTurn || sourceTurn === targetTurn || !targetTurn.promptText || sourceTurn.promptText) {
        return -1;
    }

    const sourceTime = _getVibeTurnTimeValue(sourceTurn, true);
    const targetStart = _getVibeTurnTimeValue(targetTurn, false);
    const targetEnd = _getVibeTurnTimeValue(targetTurn, true) || targetStart;
    if (sourceTime && targetStart && (sourceTime < (targetStart - (3 * 60 * 1000)) || sourceTime > (targetEnd + (4 * 60 * 1000)))) {
        return -1;
    }

    let score = _getVibeTurnOverlapScore(sourceTurn, targetTurn);
    if ((sourceTurn.tools.size || sourceTurn.files.size) && sourceTime && targetStart) {
        score += sourceTime >= (targetStart - (60 * 1000)) ? 25 : 10;
    }

    if (sourceTime && targetEnd) {
        const distance = Math.abs(sourceTime - targetEnd);
        score += Math.max(0, 12 - Math.floor(distance / 30000));
    }

    return score;
}

function _normalizeVibeWidgetDisplayItems(items) {
    const turns = items.filter((item) => item?.kind === 'turn');
    const removedKeys = new Set();

    turns.forEach((turn) => {
        if (turn.promptText) return;
        let bestTarget = null;
        let bestScore = -1;
        turns.forEach((candidate) => {
            const score = _getVibeLooseMergeScore(turn, candidate);
            if (score > bestScore) {
                bestScore = score;
                bestTarget = candidate;
            }
        });

        if (bestTarget && bestScore >= 8) {
            _mergeVibeTurnIntoTarget(bestTarget, turn);
            removedKeys.add(turn.key);
        }
    });

    return items
        .filter((item) => !removedKeys.has(item?.key))
        .sort((left, right) => {
            const leftTime = left?.kind === 'turn'
                ? _getVibeTurnTimeValue(left, false)
                : (Date.parse(left?.occurredAt || '') || 0);
            const rightTime = right?.kind === 'turn'
                ? _getVibeTurnTimeValue(right, false)
                : (Date.parse(right?.occurredAt || '') || 0);
            if (leftTime !== rightTime) return leftTime - rightTime;
            return String(left?.key || '').localeCompare(String(right?.key || ''));
        });
}

function _buildVibeWidgetDisplayItems(events) {
    const items = [];
    const turns = new Map();
    const pendingPromptTurns = [];
    let activeLooseTurn = null;
    let lastLoosePromptTurn = null;
    let looseCounter = 0;

    _sortVibeWidgetEvents(events).forEach((event, index) => {
        if (event?.eventType === 'session.status') {
            items.push({
                kind: 'system',
                key: `system:${_getVibeWidgetEventKey(event) || index}`,
                occurredAt: event?.occurredAt || '',
                text: _normalizeVibeDisplayText(event?.summary || 'Copilot session update'),
            });
            activeLooseTurn = null;
            lastLoosePromptTurn = null;
            return;
        }

        const explicitKey = _getExplicitVibeTurnKey(event);
        let turn = null;
        if (event?.eventType === 'prompt') {
            const promptText = _normalizeVibeDisplayText(event?.prompt?.text || event?.summary);
            if (!explicitKey && _canReuseLoosePromptTurn(lastLoosePromptTurn, promptText, event)) {
                turn = lastLoosePromptTurn;
            } else {
                turn = _ensureVibeTurn(items, turns, explicitKey || `prompt:${_getVibeWidgetEventKey(event) || index}`, event);
            }
            activeLooseTurn = turn;
            if (!explicitKey && !pendingPromptTurns.includes(turn)
                && !turn.responseBlocks.length
                && !turn.thinkingBlocks.length
                && !turn.tools.size
                && !turn.files.size) {
                pendingPromptTurns.push(turn);
            }
            lastLoosePromptTurn = explicitKey ? null : turn;
        } else if (explicitKey) {
            turn = _ensureVibeTurn(items, turns, explicitKey, event);
            activeLooseTurn = turn;
            lastLoosePromptTurn = null;
        } else {
            const claimedPromptTurn = _claimPendingVibePromptTurn(pendingPromptTurns, event);
            if (claimedPromptTurn) {
                turn = claimedPromptTurn;
            } else if (_canMergeLooseVibeEvent(activeLooseTurn, event)) {
                turn = activeLooseTurn;
            } else {
                turn = _ensureVibeTurn(items, turns, `loose-group:${looseCounter += 1}:${_getVibeWidgetEventKey(event) || index}`, event);
            }
            activeLooseTurn = turn;
        }

        if (event?.occurredAt) {
            if (!turn.occurredAt || Date.parse(event.occurredAt) < Date.parse(turn.occurredAt)) {
                turn.occurredAt = event.occurredAt;
            }
            if (!turn.lastAt || Date.parse(event.occurredAt) > Date.parse(turn.lastAt)) {
                turn.lastAt = event.occurredAt;
            }
        }
        if (!turn.sourceLabel && event?.publisher?.integrationLabel) {
            turn.sourceLabel = _normalizeVibeDisplayText(event.publisher.integrationLabel);
        }

        if (event?.eventType === 'prompt') {
            const promptText = _normalizeVibeDisplayText(event?.prompt?.text || event?.summary);
            if (promptText) turn.promptText = promptText;
            return;
        }

        if (event?.eventType === 'response') {
            _pushUniqueVibeBlock(turn.responseBlocks, event?.response?.text || event?.summary);
            return;
        }

        if (event?.eventType === 'thinking') {
            _pushUniqueVibeBlock(turn.thinkingBlocks, event?.thinking?.text || event?.summary);
            return;
        }

        if (event?.eventType === 'tool.call') {
            _addVibeToolToTurn(turn, event);
            return;
        }

        if (event?.eventType === 'file.change' || event?.eventType === 'file.save') {
            _addVibeFileToTurn(turn, event);
        }
    });

    const filteredItems = items.filter((item) => item.kind === 'system'
        || item.promptText
        || item.responseBlocks.length
        || item.thinkingBlocks.length
        || item.tools.size
        || item.files.size);

    return _normalizeVibeWidgetDisplayItems(filteredItems);
}

function _renderVibeDisclosure(kind, label, preview, meta, bodyHtml, disclosureKey) {
    if (!bodyHtml) return '';
    const disclosureId = disclosureKey ? ` data-vibe-disclosure-key="${esc(disclosureKey)}"` : '';
    const isOpen = disclosureKey && _vibeWidgetState.openDisclosures.has(disclosureKey);
    return `<details class="chat-vibe-turn-disclosure chat-vibe-turn-disclosure-${esc(kind)}"${disclosureId}${isOpen ? ' open' : ''}><summary><span class="chat-vibe-turn-disclosure-kicker">${esc(label)}</span><span class="chat-vibe-turn-disclosure-title">${esc(preview || label)}</span>${meta ? `<span class="chat-vibe-turn-disclosure-meta">${esc(meta)}</span>` : ''}</summary><div class="chat-vibe-turn-disclosure-body">${bodyHtml}</div></details>`;
}

function _getVibeWidgetItemDomKey(item, index) {
    return String(item?.key || `vibe-item:${index}`);
}

function _createVibeWidgetItemNode(item, itemKey) {
    const html = item.kind === 'system' ? _renderVibeSystemItem(item) : _renderVibeTurnItem(item);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const node = wrapper.firstElementChild;
    if (!node) return null;
    node.dataset.vibeKey = itemKey;
    return node;
}

function _renderVibeParagraphs(text, maxSegments = 3, muted = false) {
    return _splitVibeNarrative(text, maxSegments)
        .map((part) => `<p class="chat-vibe-turn-paragraph${muted ? ' is-muted' : ''}">${esc(part)}</p>`)
        .join('');
}

function _renderVibeRichText(text, maxSegments = 3, muted = false) {
    const { lead, items } = _extractVibeListParts(text);
    if (!items.length) {
        return _renderVibeParagraphs(text, maxSegments, muted);
    }
    const leadHtml = lead ? _renderVibeParagraphs(lead, Math.max(1, maxSegments - 1), muted) : '';
    const listHtml = `<ul class="chat-vibe-turn-bullets">${items.map((item) => `<li class="chat-vibe-turn-list-item${muted ? ' is-muted' : ''}">${esc(item)}</li>`).join('')}</ul>`;
    return `${leadHtml}${listHtml}`;
}

function _renderVibeSystemItem(item) {
    const timestamp = _formatVibeEventTime(item?.occurredAt);
    return `<div class="chat-vibe-system">${timestamp ? `<span class="chat-vibe-system-time">${esc(timestamp)}</span>` : ''}<span class="chat-vibe-system-text">${esc(item?.text || 'Copilot session update')}</span></div>`;
}

function _renderVibeTurnItem(turn) {
    const hasSecondarySections = turn.thinkingBlocks.length || turn.tools.size || turn.files.size;
    const turnClasses = ['chat-vibe-turn'];
    if (!turn.promptText) turnClasses.push('is-compact');
    if (!turn.promptText && !hasSecondarySections) turnClasses.push('is-update');
    const promptHtml = turn.promptText
        ? `<div class="chat-vibe-turn-prompt-row"><div class="chat-vibe-turn-prompt">${esc(turn.promptText)}</div></div>`
        : '';
    const responseBlocks = Array.isArray(turn.responseBlocks) ? turn.responseBlocks : [];
    const primaryResponse = responseBlocks.length ? responseBlocks[responseBlocks.length - 1].text : '';
    let progressBlocks = responseBlocks.slice(0, -1);
    let thinkingBlocks = turn.thinkingBlocks.slice();
    let visibleFallbackText = '';
    let fallbackMuted = false;

    if (!primaryResponse && progressBlocks.length) {
        visibleFallbackText = progressBlocks[progressBlocks.length - 1].text;
        progressBlocks = progressBlocks.slice(0, -1);
        fallbackMuted = false;
    } else if (!primaryResponse && thinkingBlocks.length) {
        visibleFallbackText = thinkingBlocks[thinkingBlocks.length - 1].text;
        thinkingBlocks = thinkingBlocks.slice(0, -1);
        fallbackMuted = true;
    }

    const responseHtml = primaryResponse
        ? _renderVibeRichText(primaryResponse, 3, false)
        : visibleFallbackText
            ? _renderVibeRichText(visibleFallbackText, 2, fallbackMuted)
            : '<p class="chat-vibe-turn-paragraph is-muted">Working…</p>';

    const disclosureBase = turn.key || `turn:${turn.occurredAt || turn.lastAt || Date.now()}`;
    const progressHtml = progressBlocks.length
        ? _renderVibeDisclosure(
            'progress',
            'Progress',
            _truncateVibeDisplayText(progressBlocks[progressBlocks.length - 1].text, 90),
            `${progressBlocks.length} update${progressBlocks.length === 1 ? '' : 's'}`,
            progressBlocks.map((block) => `<p class="chat-vibe-turn-note">${esc(block.text)}</p>`).join(''),
            `${disclosureBase}:progress`
        )
        : '';

    const thinkingHtml = thinkingBlocks.length
        ? _renderVibeDisclosure(
            'thinking',
            'Thinking',
            _truncateVibeDisplayText(thinkingBlocks[thinkingBlocks.length - 1].text, 90),
            `${thinkingBlocks.length} note${thinkingBlocks.length === 1 ? '' : 's'}`,
            thinkingBlocks.map((block) => `<p class="chat-vibe-turn-note">${esc(block.text)}</p>`).join(''),
            `${disclosureBase}:thinking`
        )
        : '';

    const toolEntries = Array.from(turn.tools.values()).sort((left, right) => {
        if ((right?.count || 0) !== (left?.count || 0)) {
            return (right?.count || 0) - (left?.count || 0);
        }
        return String(left?.name || '').localeCompare(String(right?.name || ''));
    });
    const commandEntries = toolEntries.filter((tool) => tool.isExecution);
    const otherToolEntries = toolEntries.filter((tool) => !tool.isExecution);
    const commandTotal = commandEntries.reduce((sum, tool) => sum + (tool.count || 0), 0);
    const commandHtml = commandEntries.length
        ? _renderVibeDisclosure(
            'commands',
            'Commands',
            _truncateVibeDisplayText(commandEntries[commandEntries.length - 1].argumentsPreview || commandEntries[commandEntries.length - 1].preview || commandEntries[0].name, 96),
            `${commandTotal} run${commandTotal === 1 ? '' : 's'}`,
            commandEntries.map((tool) => {
                const subtitle = tool.resultPreview
                    ? 'Completed execution'
                    : tool.argumentsPreview
                        ? 'Ran command'
                        : 'Executed tool';
                return `
                    <div class="chat-vibe-turn-file-card">
                        <div class="chat-vibe-turn-list-row">
                            <div class="chat-vibe-turn-list-main">
                                <div class="chat-vibe-turn-list-title">${esc(tool.label || tool.name)}</div>
                                <div class="chat-vibe-turn-list-subtitle">${esc(subtitle)}</div>
                            </div>
                            <div class="chat-vibe-turn-pill-group"><span class="chat-vibe-turn-pill is-count">${esc(tool.count > 1 ? `x${tool.count}` : '1x')}</span></div>
                        </div>
                        ${tool.argumentsPreview ? `<p class="chat-vibe-turn-note chat-vibe-turn-note-mono is-command">${esc(_truncateVibeDisplayText(tool.argumentsPreview, 180))}</p>` : ''}
                        ${tool.resultPreview ? `<p class="chat-vibe-turn-note">${esc(_truncateVibeDisplayText(tool.resultPreview, 180))}</p>` : ''}
                    </div>`;
            }).join(''),
            `${disclosureBase}:commands`
        )
        : '';
    const toolTotal = otherToolEntries.reduce((sum, tool) => sum + (tool.count || 0), 0);
    const toolsHtml = otherToolEntries.length
        ? _renderVibeDisclosure(
            'tools',
            'Tools',
            otherToolEntries.slice(0, 2).map((tool) => tool.label || tool.name).join(', '),
            `${toolTotal} call${toolTotal === 1 ? '' : 's'}`,
            otherToolEntries.map((tool) => {
                const subtitle = _hasMeaningfulVibeToolPreview(tool)
                    ? _truncateVibeDisplayText(tool.preview, 120)
                    : '';
                return `
                    <div class="chat-vibe-turn-list-row">
                        <div class="chat-vibe-turn-list-main">
                            <div class="chat-vibe-turn-list-title">${esc(tool.label || tool.name)}</div>
                            ${subtitle ? `<div class="chat-vibe-turn-list-subtitle">${esc(subtitle)}</div>` : ''}
                        </div>
                        <div class="chat-vibe-turn-pill-group"><span class="chat-vibe-turn-pill is-count">${esc(tool.count > 1 ? `x${tool.count}` : '1x')}</span></div>
                    </div>`;
            }).join(''),
            `${disclosureBase}:tools`
        )
        : '';

    const fileEntries = Array.from(turn.files.values()).sort((left, right) => {
        if ((right?.changeCount || 0) !== (left?.changeCount || 0)) {
            return (right?.changeCount || 0) - (left?.changeCount || 0);
        }
        return String(left?.name || '').localeCompare(String(right?.name || ''));
    });
    const filesHtml = fileEntries.length
        ? _renderVibeDisclosure(
            'files',
            'Edited files',
            fileEntries.slice(0, 2).map((file) => file.name).join(', '),
            `${fileEntries.length} file${fileEntries.length === 1 ? '' : 's'}`,
            fileEntries.map((file) => {
                const badges = [];
                if (file.changeCount > 0) {
                    badges.push(`<span class="chat-vibe-turn-pill is-edit">${esc(`${file.changeCount} edit${file.changeCount === 1 ? '' : 's'}`)}</span>`);
                }
                if (file.saved) {
                    badges.push('<span class="chat-vibe-turn-pill is-save">saved</span>');
                }
                if (!badges.length && file.edited) {
                    badges.push('<span class="chat-vibe-turn-pill is-edit">edited</span>');
                }
                return `
                    <div class="chat-vibe-turn-file-card">
                        <div class="chat-vibe-turn-list-row">
                            <div class="chat-vibe-turn-list-main">
                                <div class="chat-vibe-turn-list-title is-mono">${esc(file.name)}</div>
                                <div class="chat-vibe-turn-list-subtitle">${esc(file.saved && file.edited ? 'Edited and saved during this turn' : file.saved ? 'Saved in workspace' : 'Edited in workspace')}</div>
                            </div>
                            <div class="chat-vibe-turn-pill-group">${badges.join('')}</div>
                        </div>
                        ${file.snippet ? `<p class="chat-vibe-turn-note chat-vibe-turn-note-mono">${esc(_truncateVibeDisplayText(file.snippet, 180))}</p>` : ''}
                    </div>`;
            }).join(''),
            `${disclosureBase}:files`
        )
        : '';

    return `
        <article class="${turnClasses.join(' ')}">
            ${promptHtml}
            <div class="chat-vibe-turn-response">
                <div class="chat-vibe-turn-response-top">
                    <span class="chat-vibe-turn-time">${esc(_formatVibeEventTime(turn.lastAt || turn.occurredAt))}</span>
                </div>
                <div class="chat-vibe-turn-body">${responseHtml}</div>
                ${progressHtml}
                ${thinkingHtml}
                ${commandHtml}
                ${toolsHtml}
                ${filesHtml}
            </div>
        </article>`;
}

function _renderVibeWidget() {
    const panel = _ensureVibeWidgetPanel();
    if (!panel || !_vibeWidgetState.feed) return;
    const settings = _vibeWidgetState.settings;
    if (!settings?.enabled) {
        _resetVibeWidget(true);
        return;
    }

    panel.style.display = '';
    panel.classList.toggle('is-collapsed', !!_vibeWidgetState.collapsed);
    const titleEl = panel.querySelector('.chat-vibe-widget-title span');
    if (titleEl) titleEl.textContent = settings.widget_title || 'Vibe Coding';
    const statusEl = panel.querySelector('.chat-vibe-widget-status');
    if (statusEl) {
        const shouldShowBadge = _vibeWidgetState.collapsed && _vibeWidgetState.unreadCount > 0;
        statusEl.classList.toggle('is-badge', shouldShowBadge);
        statusEl.classList.toggle('is-hidden', _vibeWidgetState.collapsed && _vibeWidgetState.unreadCount === 0);

        if (shouldShowBadge) {
            statusEl.textContent = `${_vibeWidgetState.unreadCount} new`;
        } else if (_vibeWidgetState.collapsed) {
            statusEl.textContent = '';
        } else {
            let statusText = 'Live';
            if (settings.paused) statusText = 'Paused';
            else if (_vibeWidgetState.syncState === 'retrying') statusText = 'Reconnecting';
            statusEl.textContent = statusText;
            statusEl.classList.remove('is-badge');
            statusEl.classList.remove('is-hidden');
        }
    }
    const toggleEl = panel.querySelector('.chat-vibe-widget-toggle');
    if (toggleEl) {
        toggleEl.textContent = _vibeWidgetState.collapsed ? 'Show' : 'Hide';
        toggleEl.setAttribute('aria-expanded', _vibeWidgetState.collapsed ? 'false' : 'true');
        toggleEl.setAttribute('aria-label', _vibeWidgetState.collapsed ? 'Expand vibe coding widget' : 'Collapse vibe coding widget');
    }
    if (_vibeWidgetState.collapsed) {
        _hideVibeWidgetNewMessagesIndicator();
    }

    const maxEvents = settings.max_events || VIBE_WIDGET_FALLBACK_MAX;
    const previousOffsetFromBottom = _vibeWidgetState.feed.scrollHeight - _vibeWidgetState.feed.scrollTop;
    const shouldStickToBottom = !_vibeWidgetState.userScrolledUp || _isVibeWidgetNearBottom();
    const items = _buildVibeWidgetDisplayItems(_vibeWidgetState.events).slice(-maxEvents);
    if (!items.length) {
        _vibeWidgetState.feed.innerHTML = '<div class="chat-vibe-widget-empty">No coding events yet for this slot.</div>';
        _hideVibeWidgetNewMessagesIndicator();
        return;
    }

    const existingChildren = Array.from(_vibeWidgetState.feed.children);
    const existingByKey = new Map(existingChildren.map((child) => [child.dataset.vibeKey, child]));
    const nextChildren = [];

    items.forEach((item, index) => {
        const itemKey = _getVibeWidgetItemDomKey(item, index);
        const existing = existingByKey.get(itemKey);
        const itemHtml = item.kind === 'system' ? _renderVibeSystemItem(item) : _renderVibeTurnItem(item);

        if (existing) {
            if (existing.innerHTML !== itemHtml) {
                const replacement = _createVibeWidgetItemNode(item, itemKey);
                if (replacement) {
                    _vibeWidgetState.feed.replaceChild(replacement, existing);
                    nextChildren.push(replacement);
                }
            } else {
                nextChildren.push(existing);
            }
            return;
        }

        const node = _createVibeWidgetItemNode(item, itemKey);
        if (!node) return;
        const insertBefore = _vibeWidgetState.feed.children[index] || null;
        _vibeWidgetState.feed.insertBefore(node, insertBefore);
        nextChildren.push(node);
    });

    const nextKeys = new Set(nextChildren.map((child) => child.dataset.vibeKey));
    existingChildren.forEach((child) => {
        if (!nextKeys.has(child.dataset.vibeKey)) {
            child.remove();
        }
    });

    requestAnimationFrame(() => {
        if (!_vibeWidgetState.feed) return;
        if (shouldStickToBottom) {
            _scrollVibeWidgetToBottom();
            return;
        }
        _vibeWidgetState.feed.scrollTop = Math.max(0, _vibeWidgetState.feed.scrollHeight - previousOffsetFromBottom);
        _showVibeWidgetNewMessagesIndicator();
    });
}

function _pushVibeWidgetEvent(event) {
    if (!event) return;
    if (event.publisher) {
        _vibeWidgetState.publisher = event.publisher;
    }
    const wasNearBottom = _isVibeWidgetNearBottom();
    const addedCount = _mergeVibeWidgetEvents([event]);
    if (!addedCount) {
        return;
    }
    _vibeWidgetState.lastSyncedAt = Date.now();
    _vibeWidgetState.syncState = 'live';
    if (!wasNearBottom) {
        _vibeWidgetState.userScrolledUp = true;
        _vibeWidgetState.unreadCount += addedCount;
    } else {
        _vibeWidgetState.userScrolledUp = false;
        _vibeWidgetState.unreadCount = 0;
    }
    _renderVibeWidget();
}

function _handleVibeSocketMessage(msg) {
    if (!msg?.event || !_vibeWidgetState.settings?.enabled) return;
    const delayMs = Math.max(0, parseInt(msg.delay_ms, 10) || parseInt(_vibeWidgetState.settings.delay_ms, 10) || 0);
    if (delayMs > 0) {
        const timerId = setTimeout(() => {
            _vibeWidgetState.timers = _vibeWidgetState.timers.filter((id) => id !== timerId);
            _pushVibeWidgetEvent(msg.event);
        }, delayMs);
        _vibeWidgetState.timers.push(timerId);
        return;
    }
    _pushVibeWidgetEvent(msg.event);
}

async function refreshVibeWidgetFeed() {
    const context = _getVibeWidgetContext();
    if (!context) {
        _resetVibeWidget(true);
        return;
    }

    const widgetKey = `${context.username}:${context.slotRef}`;
    if (_vibeWidgetState.key && _vibeWidgetState.key !== widgetKey) {
        _resetVibeWidget(true);
    }

    const previousKeys = new Set(_vibeWidgetState.events.map((event) => _getVibeWidgetEventKey(event)));
    const wasNearBottom = _isVibeWidgetNearBottom();
    try {
        const data = await api(`/vibe-coding/channel/${encodeURIComponent(context.username)}/${encodeURIComponent(String(context.slotRef))}/events?limit=${_getVibeWidgetFetchLimit()}`);
        _vibeWidgetState.key = widgetKey;
        _vibeWidgetState.settings = data.settings || null;
        _vibeWidgetState.publisher = data.publisher || null;
        _replaceVibeWidgetEvents(Array.isArray(data.events) ? data.events : []);
        const addedCount = _vibeWidgetState.events.reduce((count, event) => {
            return count + (previousKeys.has(_getVibeWidgetEventKey(event)) ? 0 : 1);
        }, 0);
        _vibeWidgetState.lastSyncedAt = Date.now();
        _vibeWidgetState.syncState = 'live';
        if (!wasNearBottom && addedCount > 0) {
            _vibeWidgetState.userScrolledUp = true;
            _vibeWidgetState.unreadCount += addedCount;
        } else if (wasNearBottom) {
            _vibeWidgetState.userScrolledUp = false;
            _vibeWidgetState.unreadCount = 0;
        }
        _ensureVibeWidgetRefreshTimer();
        _renderVibeWidget();
    } catch {
        _vibeWidgetState.syncState = _vibeWidgetState.settings?.enabled ? 'retrying' : 'idle';
        if (_vibeWidgetState.panel && _vibeWidgetState.settings?.enabled) {
            _renderVibeWidget();
        }
    }
}

function getFullscreenChatEls() {
    return {
        container: document.getElementById('video-container'),
        overlay: document.getElementById('fullscreen-chat-overlay'),
        messages: document.getElementById('fullscreen-chat-messages'),
        input: document.getElementById('fullscreen-chat-input'),
    };
}

function isFullscreenChatActive() {
    const { container } = getFullscreenChatEls();
    const page = document.getElementById('page-channel');
    return !!(
        chatSettings.fullscreenOverlayChat &&
        container &&
        document.fullscreenElement === container &&
        page &&
        page.classList.contains('active') &&
        document.getElementById('ch-live-area')?.style.display !== 'none'
    );
}

function clearFullscreenChatMessages() {
    const { messages } = getFullscreenChatEls();
    if (messages) messages.innerHTML = '';
}

function scheduleFullscreenChatIdle() {
    if (_fullscreenChatIdleTimer) clearTimeout(_fullscreenChatIdleTimer);
    const { container, input } = getFullscreenChatEls();
    if (!isFullscreenChatActive() || !container) return;
    if (input && document.activeElement === input) return;
    _fullscreenChatIdleTimer = setTimeout(() => {
        if (!isFullscreenChatActive()) return;
        if (input && document.activeElement === input) return;
        container.classList.add('fs-chat-idle');
    }, FULLSCREEN_CHAT_IDLE_MS);
}

function markFullscreenChatActivity() {
    const { container } = getFullscreenChatEls();
    if (!container) return;
    container.classList.remove('fs-chat-idle');
    scheduleFullscreenChatIdle();
}

function renderFullscreenChatRecent() {
    const { messages } = getFullscreenChatEls();
    if (!messages) return;
    messages.innerHTML = '';
    _fullscreenChatRecent.slice(-FULLSCREEN_CHAT_MAX_MESSAGES).forEach(entry => {
        const el = document.createElement('div');
        el.className = `fullscreen-chat-msg ${entry.kind || 'chat'}`.trim();
        el.innerHTML = entry.html;
        messages.appendChild(el);
        scheduleFullscreenChatFade(el);
    });
}

function updateFullscreenChatOverlayState() {
    const { container, overlay, input } = getFullscreenChatEls();
    if (!container || !overlay) return;

    const active = isFullscreenChatActive();
    container.classList.toggle('fs-chat-enabled', active);
    if (!active) {
        container.classList.remove('fs-chat-idle');
        overlay.setAttribute('aria-hidden', 'true');
        if (_fullscreenChatIdleTimer) { clearTimeout(_fullscreenChatIdleTimer); _fullscreenChatIdleTimer = null; }
        return;
    }

    overlay.setAttribute('aria-hidden', 'false');
    renderFullscreenChatRecent();
    if (input) _autoResizeTextarea(input);
    markFullscreenChatActivity();
}

function scheduleFullscreenChatFade(el) {
    if (!el) return;
    if (el._fadeTimer) clearTimeout(el._fadeTimer);
    if (el._removeTimer) clearTimeout(el._removeTimer);
    el.classList.remove('is-fading');
    el._fadeTimer = setTimeout(() => {
        el.classList.add('is-fading');
    }, FULLSCREEN_CHAT_FADE_MS);
    el._removeTimer = setTimeout(() => {
        el.remove();
    }, FULLSCREEN_CHAT_FADE_MS + 550);
}

function queueFullscreenChatEntry(entry) {
    if (!entry?.html) return;
    _fullscreenChatRecent.push(entry);
    if (_fullscreenChatRecent.length > FULLSCREEN_CHAT_MAX_MESSAGES * 2) {
        _fullscreenChatRecent = _fullscreenChatRecent.slice(-FULLSCREEN_CHAT_MAX_MESSAGES * 2);
    }

    if (!isFullscreenChatActive()) return;

    const { messages } = getFullscreenChatEls();
    if (!messages) return;
    const el = document.createElement('div');
    el.className = `fullscreen-chat-msg ${entry.kind || 'chat'}`.trim();
    el.innerHTML = entry.html;
    messages.appendChild(el);

    while (messages.children.length > FULLSCREEN_CHAT_MAX_MESSAGES) {
        messages.firstElementChild?.remove();
    }

    scheduleFullscreenChatFade(el);
}

function buildFullscreenChatEntry(msg) {
    const badge = chatSettings.showBadges ? getBadgeHTML(msg.role) : '';
    let nameColor = relayColorFor(msg) || msg.color || msg.profile_color || getRoleColor(msg.role);
    if (chatSettings.readableColors) nameColor = ensureReadableColor(nameColor);
    const displayName = esc(msg.username || msg.displayName || `anon${msg.anonId || ''}`);
    const _relayPlatform = (msg.source_platform || parseRelayUsername(msg.username || msg.displayName || '').platform || '').toLowerCase();
    const _relayBadge = relayBadgeHTML(_relayPlatform);
    const _visibleName = _relayBadge ? esc((msg.username || msg.displayName || '').replace(/^\[[^\]]+\]\s*/, '')) : displayName;
    const rawText = msg.message || msg.text || '';
    const text = (typeof parseEmotes === 'function') ? parseEmotes(rawText) : esc(rawText);
    const replyLine = msg.reply_to ? `<div style="font-size:0.72em;opacity:0.5;margin-bottom:1px"><i class="fa-solid fa-reply fa-flip-horizontal" style="font-size:0.65em"></i> @${esc(msg.reply_to.username || 'unknown')}</div>` : '';
    return {
        kind: 'chat',
        html: `${replyLine}<div class="fullscreen-chat-meta"><span class="fullscreen-chat-user" style="color:${esc(nameColor)}">${badge}${_relayBadge}${(msg.is_ai || msg.source_platform === 'ai') ? '<span class="chat-ai-badge">AI</span>' : ''}${_visibleName}</span></div><div class="fullscreen-chat-text">${text}</div>`,
    };
}

function setupFullscreenChatOverlay() {
    document.addEventListener('fullscreenchange', updateFullscreenChatOverlayState);
    document.addEventListener('keydown', () => {
        if (isFullscreenChatActive()) markFullscreenChatActivity();
    }, { passive: true });
    document.addEventListener('focusin', (e) => {
        if (e.target?.id === 'fullscreen-chat-input') markFullscreenChatActivity();
    });
    document.addEventListener('focusout', (e) => {
        if (e.target?.id === 'fullscreen-chat-input') scheduleFullscreenChatIdle();
    });
    ['mousemove', 'mousedown', 'touchstart'].forEach(type => {
        document.addEventListener(type, (e) => {
            const { container } = getFullscreenChatEls();
            if (!container || !isFullscreenChatActive()) return;
            if (e.target === container || container.contains(e.target)) markFullscreenChatActivity();
        }, { passive: true });
    });
}

async function hydrateActiveChatHistory(streamId, { clear = false } = {}) {
    const { messages } = getChatEl();
    if (!messages) return;

    // If clearing, show a loading skeleton rather than an empty panel while
    // we wait for history to arrive — avoids a blank flash on stream restart.
    if (clear) {
        messages.innerHTML = '<div class="chat-loading-history" style="padding:12px;color:var(--text-muted);text-align:center;font-size:0.85rem"><i class="fa-solid fa-spinner fa-spin"></i> Loading history…</div>';
    }

    _loadingHistory = true;
    try {
        // Load emotes BEFORE rendering history — otherwise parseEmotes falls back to
        // plain text and historical messages show raw codes (e.g. "PepeD") instead of
        // the emote image. Deduped with the connect-time load, so it's a single fetch.
        if (typeof loadEmotes === 'function') {
            try { await loadEmotes(streamId); } catch { /* non-fatal — history still renders */ }
        }
        if (streamId) await loadChatHistory(streamId);
        else if (chatChannelUserId) await loadChannelChatHistory(chatChannelUserId);
        else await loadGlobalChatHistory();
    } catch {
        // History failed — just clear the skeleton and let chat continue live
        if (clear) messages.innerHTML = '';
    } finally {
        _loadingHistory = false;
    }

    applyChatSettings();
    // Always scroll to the bottom after loading history — reset scroll state
    // to prevent false "new messages below" indicators on first open
    scrollChatToBottom();
    _chatUserScrolledUp = false;
    _chatUnreadCount = 0;
    _hideChatNewMessagesIndicator();
    // Re-scroll after a frame to catch any late DOM renders
    requestAnimationFrame(() => {
        scrollChatToBottom();
        _chatUserScrolledUp = false;
        _chatUnreadCount = 0;
        _hideChatNewMessagesIndicator();
    });
    // Also scroll the floating chat widget if it's open
    _fcwScrollToBottom();
}

/**
 * Initialize chat for a stream.
 * Idempotent — if already connected to the same stream, skip reconnection.
 */
// The chat input that belongs to each render surface (for carrying a typed draft
// across a live↔offline swap).
function _chatInputIdForTarget(targetId) {
    return {
        'chat-messages': 'chat-input',
        'offline-chat-messages': 'offline-chat-input',
        'global-chat-messages': 'global-chat-input',
        'bc-chat-messages': 'bc-chat-input',
        'pc-msgs': 'pc-input',
    }[targetId] || null;
}

function initChat(streamId, channelUserId = null) {
    const prevChannelUserId = chatChannelUserId;
    chatChannelUserId = channelUserId || null;
    const nextTargetId = getChatRenderTargetId();

    // Same CHANNEL, different surface — a live stream ended (stream id → null) or the
    // channel just went live (null → new id). The chat room is keyed by the STREAMER,
    // not the session, so a full teardown is pointless churn that wiped the scrollback,
    // dropped the socket, and ate whatever the viewer was typing. Instead: rejoin on
    // the SAME socket, move the rendered history and the input draft to the new
    // surface, and the viewer keeps chatting the moment the swap happens.
    if (chatWs && chatWs.readyState === WebSocket.OPEN && _chatActive
        && channelUserId && prevChannelUserId === channelUserId && chatStreamId !== streamId) {
        const prevTargetId = chatRenderTargetId;
        const prevMsgs = prevTargetId ? document.getElementById(prevTargetId) : null;
        const prevInputId = _chatInputIdForTarget(prevTargetId);
        const prevInput = prevInputId ? document.getElementById(prevInputId) : null;
        chatStreamId = streamId;
        chatRenderTargetId = nextTargetId;
        _suppressNextAuthNotice = true;
        try {
            const token = localStorage.getItem('token');
            chatWs.send(JSON.stringify({ type: 'join', streamId, channelUserId, token: token || undefined }));
        } catch { /* send failed → the onclose reconnect path takes over */ }
        // History continuity: transplant the already-rendered messages into the new
        // container instead of clearing + refetching (no skeleton, no jump).
        const nextMsgs = nextTargetId ? document.getElementById(nextTargetId) : null;
        if (nextMsgs && prevMsgs && nextMsgs !== prevMsgs && prevMsgs.children.length) {
            nextMsgs.innerHTML = '';
            while (prevMsgs.firstChild) nextMsgs.appendChild(prevMsgs.firstChild);
        } else if (nextMsgs && !nextMsgs.children.length) {
            hydrateActiveChatHistory(streamId, { clear: true }).catch(() => { });
        }
        // Draft continuity: carry the half-typed message to the new surface's input.
        const nextInputId = _chatInputIdForTarget(nextTargetId);
        const nextInput = nextInputId ? document.getElementById(nextInputId) : null;
        if (prevInput && nextInput && prevInput !== nextInput && prevInput.value && !nextInput.value) {
            nextInput.value = prevInput.value;
            prevInput.value = '';
            try { _autoResizeTextarea(nextInput); } catch { /* */ }
        }
        refreshVibeWidgetFeed().catch(() => { });
        applyChatSettings();
        scrollChatToBottom();
        return;
    }

    // Already connected or actively connecting to this stream — nothing to do
    if (chatWs && chatStreamId === streamId) {
        if (chatWs.readyState === WebSocket.OPEN || chatWs.readyState === WebSocket.CONNECTING) {
            const { messages } = getChatEl();
            const targetChanged = nextTargetId && nextTargetId !== chatRenderTargetId;
            const needsHydrate = chatWs.readyState === WebSocket.OPEN && (!messages || !messages.children.length);
            chatRenderTargetId = nextTargetId;
            if (targetChanged || needsHydrate) {
                hydrateActiveChatHistory(streamId, { clear: true }).catch(() => { });
            }
            refreshVibeWidgetFeed().catch(() => { });
            applyChatSettings();
            return;
        }
    }

    // Reclaim background broadcast WS if it's connected to the same stream
    if (_bgBroadcastWs && _bgBroadcastWs.readyState === WebSocket.OPEN && _bgBroadcastStreamId === streamId) {
        refreshVibeWidgetFeed().catch(() => { });
        destroyChat(); // close any existing foreground chat
        chatWs = _bgBroadcastWs;
        chatStreamId = _bgBroadcastStreamId;
        chatRenderTargetId = nextTargetId;
        _bgBroadcastWs = null;
        _bgBroadcastStreamId = null;
        _chatIntentionalClose = false;
        _chatActive = true;
        // Reattach full message handler
        chatWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                handleChatMessage(msg);
            } catch { /* ignore */ }
        };
        chatWs.onclose = () => {
            addSystemMessage('Chat disconnected');
            if (!_chatIntentionalClose && _chatActive) {
                _scheduleChatReconnect(chatStreamId);
            }
        };
        chatWs.onerror = () => { addSystemMessage('Chat connection error'); };
        // Load history and apply settings
        hydrateActiveChatHistory(streamId, { clear: true }).catch(() => { });
        applyChatSettings();
        return;
    }

    destroyChat();
    chatStreamId = streamId;
    chatRenderTargetId = nextTargetId;
    refreshVibeWidgetFeed().catch(() => { });

    const host = window.location.hostname;
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const token = localStorage.getItem('token');

    // Pass token and stream in URL so the server can authenticate on connect
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (streamId) params.set('stream', streamId);
    const wsUrl = `${protocol}://${host}:${port}/ws/chat?${params.toString()}`;

    const ws = new WebSocket(wsUrl);
    ws._authToken = token || null;
    chatWs = ws;

    _chatIntentionalClose = false;
    _chatActive = true;
    _chatReconnectDelay = CHAT_RECONNECT_BASE;
    if (_chatReconnectTimer) { clearTimeout(_chatReconnectTimer); _chatReconnectTimer = null; }

    // All handlers capture `ws` so stale close/error events from a
    // previously-destroyed WebSocket can't trigger spurious reconnects.
    ws.onopen = () => {
        if (chatWs !== ws) return; // stale — a newer WS replaced us
        ws.send(JSON.stringify({
            type: 'join',
            streamId: streamId,
            channelUserId: chatChannelUserId || undefined,
            token: token || undefined
        }));
        ws._authToken = token || null;
        _chatReconnectDelay = CHAT_RECONNECT_BASE; // reset backoff on success
        addRichSystemMessage('<i class="fa-solid fa-plug-circle-check" style="margin-right:5px;opacity:0.8"></i> Connected to chat');
    };

    // Load emotes + channel sounds for this stream context
    if (typeof loadEmotes === 'function') loadEmotes(streamId);
    if (typeof loadChannelSounds === 'function') loadChannelSounds(streamId);

    ws.onmessage = (e) => {
        if (chatWs !== ws) return;
        try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'auth') {
                ws._openvibenetworkUserId = msg.user_id || null;
                ws._openvibenetworkAuthenticated = !!msg.authenticated;
            }
            handleChatMessage(msg);
        } catch { /* ignore */ }
    };

    ws.onerror = () => {
        if (chatWs !== ws) return;
        addSystemMessage('Chat connection error');
    };

    ws.onclose = () => {
        if (chatWs !== ws) return; // stale close from old socket — ignore
        addSystemMessage('Chat disconnected');
        // Auto-reconnect unless intentionally closed (navigation/destroy)
        // For global chat, chatStreamId is null — use _chatActive to track connection intent
        if (!_chatIntentionalClose && _chatActive) {
            _scheduleChatReconnect(chatStreamId);
        }
    };

    // Load history
    hydrateActiveChatHistory(streamId).catch(() => { });

    // Apply persisted settings to DOM
    applyChatSettings();

    // Start cross-feed if enabled and we're in a stream chat
    _syncGlobalFeed();

    // Track user scroll position — clear indicator when user scrolls to bottom
    const { messages: chatContainer } = getChatEl();
    if (chatContainer && !chatContainer._scrollListenerAttached) {
        chatContainer._scrollListenerAttached = true;
        chatContainer.addEventListener('scroll', () => {
            const nearBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 100;
            if (nearBottom) {
                _chatUserScrolledUp = false;
                _chatUnreadCount = 0;
                _hideChatNewMessagesIndicator();
            } else {
                _chatUserScrolledUp = true;
            }
        }, { passive: true });
    }
}

/**
 * Schedule a chat reconnect with exponential backoff.
 */
function _scheduleChatReconnect(streamId) {
    if (_chatReconnectTimer) return; // already scheduled
    const delay = _chatReconnectDelay;
    _chatReconnectDelay = Math.min(_chatReconnectDelay * 1.5, CHAT_RECONNECT_MAX);
    addSystemMessage(`Reconnecting in ${Math.round(delay / 1000)}s…`);
    _chatReconnectTimer = setTimeout(() => {
        _chatReconnectTimer = null;
        if (_chatIntentionalClose || !_chatActive) return;
        // Reconnect to current stream or global (null)
        const targetStream = chatStreamId ?? streamId ?? null;
        console.log('[Chat] Auto-reconnecting to', targetStream || 'global');
        // Reconnect the WebSocket WITHOUT clearing messages or tearing down the DOM.
        // This prevents the flash/clear that users see during server restarts.
        _reconnectChatWs(targetStream);
    }, delay);
}

/**
 * Reconnect just the WebSocket without clearing the chat UI.
 * Preserves all existing messages — only new messages are appended after reconnect.
 */
function _reconnectChatWs(streamId) {
    _chatIsReconnecting = true;
    // Close stale WS if any
    if (chatWs) {
        try { chatWs.onclose = null; chatWs.onerror = null; chatWs.close(); } catch { }
        chatWs = null;
    }
    chatStreamId = streamId;

    const host = window.location.hostname;
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const token = localStorage.getItem('token');

    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (streamId) params.set('stream', streamId);
    const wsUrl = `${protocol}://${host}:${port}/ws/chat?${params.toString()}`;

    const ws = new WebSocket(wsUrl);
    ws._authToken = token || null;
    chatWs = ws;
    _chatIntentionalClose = false;
    _chatActive = true;

    ws.onopen = () => {
        if (chatWs !== ws) return;
        _chatIsReconnecting = false;
        ws.send(JSON.stringify({ type: 'join', streamId, channelUserId: chatChannelUserId || undefined, token: token || undefined }));
        _chatReconnectDelay = CHAT_RECONNECT_BASE;
        addSystemMessage('Reconnected to chat');
    };

    ws.onmessage = (e) => {
        if (chatWs !== ws) return;
        try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'auth') {
                ws._openvibenetworkUserId = msg.user_id || null;
                ws._openvibenetworkAuthenticated = !!msg.authenticated;
            }
            handleChatMessage(msg);
        } catch { }
    };

    ws.onerror = () => {
        if (chatWs !== ws) return;
        _chatIsReconnecting = false;
        addSystemMessage('Chat connection error');
    };

    ws.onclose = () => {
        if (chatWs !== ws) return;
        _chatIsReconnecting = false;
        addSystemMessage('Chat disconnected');
        if (!_chatIntentionalClose && _chatActive) {
            _scheduleChatReconnect(chatStreamId);
        }
    };

    // Restart cross-feed if applicable
    _syncGlobalFeed();
}

function destroyChat(forceClose = false) {
    _resetVibeWidget(true);
    _chatIntentionalClose = true;
    _chatActive = false;
    _closeGlobalFeed();
    if (_chatReconnectTimer) { clearTimeout(_chatReconnectTimer); _chatReconnectTimer = null; }
    // When broadcasting, keep the chat WS alive in the background so TTS
    // messages continue to play while the user browses other pages.
    const isBroadcasting = typeof isStreaming === 'function' && isStreaming();
    if (!forceClose && isBroadcasting && chatWs && chatWs.readyState === WebSocket.OPEN && chatStreamId) {
        // Transfer to background — only process TTS/audio, skip rendering
        _bgBroadcastWs = chatWs;
        _bgBroadcastStreamId = chatStreamId;
        // Replace the message handler with a TTS-only handler
        _bgBroadcastWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                _handleBgBroadcastMessage(msg);
            } catch { /* ignore */ }
        };
        _bgBroadcastWs.onclose = () => {
            _bgBroadcastWs = null;
            _bgBroadcastStreamId = null;
        };
        _bgBroadcastWs.onerror = () => { };
        chatWs = null;
        chatStreamId = null;
    } else {
        if (chatWs) {
            chatWs.close();
            chatWs = null;
        }
        chatStreamId = null;
    }
    chatRenderTargetId = null;
    clearFullscreenChatMessages();
    _fullscreenChatRecent = [];
    // Clean up stale background WS (disconnected while in bg)
    if (_bgBroadcastWs && _bgBroadcastWs.readyState !== WebSocket.OPEN) {
        try { _bgBroadcastWs.close(); } catch { }
        _bgBroadcastWs = null;
        _bgBroadcastStreamId = null;
    }
    // Clear all chat containers (only on intentional navigation, not auto-reconnect)
    if (!_chatIsReconnecting) {
        for (const id of ['chat-messages', 'bc-chat-messages', 'global-chat-messages', 'offline-chat-messages']) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        }
    }
    dismissContextMenu();
}

/**
 * Background broadcast message handler — only processes TTS messages
 * so they continue playing while the broadcaster navigates other pages.
 */
function _handleBgBroadcastMessage(msg) {
    // Own-channel audio while browsing elsewhere. This socket is joined to the
    // streamer's OWN stream, so everything here is their channel's chat — but it must
    // still honor the "TTS On My Channel When Live" toggle (it used to play
    // unconditionally, so turning the setting off "didn't work"), the per-source
    // filters, and the one-speaking-tab-per-device rule.
    switch (msg.type) {
        case 'tts':
            if (!isOwnChannelTtsSpeaker() || !isChatTTSEnabled({ streaming: true }) || !_isTTSEnabledForSource(msg.source_platform)) return;
            if (typeof broadcastState !== 'undefined' && broadcastState.settings?.ttsMode === 'self') {
                if (typeof speakBroadcastTTS === 'function') {
                    speakBroadcastTTS(msg.message || msg.text, msg.username);
                }
            }
            break;
        case 'tts-audio':
            if (!isOwnChannelTtsSpeaker() || !isChatTTSEnabled({ streaming: true }) || !_isTTSEnabledForSource(msg.source_platform)) return;
            if (_ttsRecentlyPlayed(msg)) return; // bg socket + main socket can both deliver
            if (typeof playBroadcastTTSAudio === 'function' && typeof broadcastState !== 'undefined') {
                playBroadcastTTSAudio(msg);
            }
            break;
        case 'soundboard-audio':
            if (!isOwnChannelTtsSpeaker() || !isChatSoundsEnabled()) return;
            if (typeof playBroadcastTTSAudio === 'function' && typeof broadcastState !== 'undefined') {
                playBroadcastTTSAudio(msg);
            }
            break;
    }
}

/**
 * Close the background broadcast chat WS (call when broadcast ends).
 */
function destroyBgBroadcastChat() {
    if (_bgBroadcastWs) {
        try { _bgBroadcastWs.close(); } catch { }
        _bgBroadcastWs = null;
        _bgBroadcastStreamId = null;
    }
}

/* ── Message handling ─────────────────────────────────────────── */
function handleChatMessage(msg) {
    switch (msg.type) {
        case 'vibe-coding':
            _handleVibeSocketMessage(msg);
            break;
        case 'chat':
            addChatMessage(msg);
            // Self-mode TTS: speak every incoming chat message via browser synthesis
            // Only use broadcast TTS when viewing own channel chat
            if (_isViewingOwnBroadcastChat() && broadcastState?.settings?.ttsMode === 'self') {
                if (typeof speakBroadcastTTS === 'function' && _isTTSEnabledForSource(msg.source_platform)) {
                    speakBroadcastTTS(msg.message || msg.text, msg.username);
                }
            }
            break;
        case 'gotti':
            addGottiMessage(msg);
            break;
        case 'system':
            addSystemMessage(msg.message || msg.text);
            break;
        case 'donation':
            addDonationMessage(msg);
            break;
        case 'goal-update':
            if (typeof updateGoalInWidget === 'function' && msg.goal) updateGoalInWidget(msg.goal);
            break;
        case 'goal-reached':
            addDonationGoalMessage(msg);
            if (typeof goalReachedInWidget === 'function' && msg.goal) goalReachedInWidget(msg.goal);
            break;
        case 'user-count':
            updateViewerCount(msg.count);
            updateTabViewerCount(msg.stream_id, msg.count);
            // Also update broadcast page viewer count element
            if (typeof updateViewerCountBroadcast === 'function') updateViewerCountBroadcast(msg.count);
            break;
        case 'users-list':
            renderChatUsersList(msg.users);
            break;
        case 'auth':
            // Remember who WE are in this chat (stable key + display name) so TTS of
            // our own messages can be skipped locally (see _isOwnTtsMessage).
            _myChatIdentity = {
                key: msg.core_username ? `user:${msg.core_username}` : `anon:${msg.username}`,
                name: String(msg.username || ''),
                core: msg.core_username || null,
            };
            // A surface rejoin (live↔offline swap on the same socket) re-issues this
            // confirmation — skip the duplicate "Chatting as" notice, but still run
            // the rest of the sync below (slow mode, gifs, emote scale, …).
            const _quietAuth = _suppressNextAuthNotice;
            _suppressNextAuthNotice = false;
            if (msg.authenticated) {
                if (!_quietAuth) addRichSystemMessage(`<i class="fa-solid fa-user-check" style="margin-right:5px;opacity:0.8"></i> Chatting as ${esc(msg.username)}`);
            } else {
                // Server didn't authenticate us — show as anon
                const hasToken = !!localStorage.getItem('token');
                if (hasToken) {
                    // We think we're logged in but the server rejected the token —
                    // token may be expired/invalid. Reconnect chat after loadUser refreshes auth.
                    if (!_quietAuth) addRichSystemMessage(`<i class="fa-solid fa-user" style="margin-right:5px;opacity:0.8"></i> Chatting as ${esc(msg.username)} (not logged in)`);
                    console.warn('[Chat] Token rejected by server — will attempt re-auth');
                    // Re-validate token; if still valid, reconnect chat with fresh state
                    if (typeof loadUser === 'function') {
                        loadUser().then(() => {
                            if (typeof currentUser !== 'undefined' && currentUser) {
                                // Token was actually valid (race condition) — reconnect chat
                                console.log('[Chat] Re-auth succeeded, reconnecting chat');
                                const sid = chatStreamId;
                                destroyChat();
                                if (sid) initChat(sid);
                            } else {
                                // Token truly expired — clear it and update UI
                                addSystemMessage('Session expired. Please log in again.');
                                if (typeof onAuthChange === 'function') onAuthChange();
                            }
                        }).catch(() => { });
                    }
                } else {
                    if (!_quietAuth) addRichSystemMessage(`<i class="fa-solid fa-user-check" style="margin-right:5px;opacity:0.8"></i> Chatting as ${esc(msg.username)}`);
                }
            }
            // Sync slow mode state from server on join
            if (typeof msg.slowmode_seconds === 'number') {
                chatSlowModeSeconds = msg.slowmode_seconds;
                updateSlowModeIndicator();
            }
            if (typeof setGifsEnabled === 'function') {
                setGifsEnabled(msg.gifs_enabled !== false);
            }
            // Streamer-controlled emote display size for this channel (percent → CSS scale)
            applyChannelEmoteScale(msg.emote_scale);
            chatSelfDeletePolicy = {
                allowAutoDelete: msg.allow_auto_delete !== false,
                allowDeleteAll: msg.allow_self_delete_all !== false,
                minMinutes: Math.max(CHAT_SELF_DELETE_MINUTES, parseInt(msg.min_auto_delete_minutes, 10) || CHAT_SELF_DELETE_MINUTES),
            };
            chatSlurPolicy = {
                enabled: !!msg.slur_filter_enabled,
                useBuiltin: msg.slur_filter_use_builtin !== false,
                disabledCategories: Array.isArray(msg.slur_filter_disabled_categories) ? msg.slur_filter_disabled_categories : [],
                terms: Array.isArray(msg.slur_filter_terms) ? msg.slur_filter_terms.map((t) => String(t || '').trim()).filter(Boolean) : [],
                regexes: Array.isArray(msg.slur_filter_regexes) ? msg.slur_filter_regexes.map((t) => String(t || '').trim()).filter(Boolean) : [],
                message: String(msg.slur_filter_nudge_message || ''),
                announcedForKey: chatSlurPolicy.announcedForKey,
            };
            if (chatSlurPolicy.enabled && chatStreamId) {
                const policyKey = `stream:${chatStreamId}`;
                if (chatSlurPolicy.announcedForKey !== policyKey) {
                    chatSlurPolicy.announcedForKey = policyKey;
                    addSystemMessage('Heads up: this streamer enabled Anti-Slur Nudge for this chat. This is a channel choice, not a global platform block.');
                }
            }
            syncSettingsPanelUI();
            break;
        case 'slowmode':
            chatSlowModeSeconds = msg.seconds || 0;
            updateSlowModeIndicator();
            break;
        case 'user-updated': {
            // Admin renamed us — update local identity
            if (msg.user && typeof currentUser !== 'undefined' && currentUser && currentUser.id === msg.user.id) {
                const oldUsername = currentUser.username;
                const oldDisplay = currentUser.display_name;
                if (msg.user.username) currentUser.username = msg.user.username;
                if (msg.user.display_name) currentUser.display_name = msg.user.display_name;
                if (msg.user.role) currentUser.role = msg.user.role;
                if (msg.user.avatar_url !== undefined) currentUser.avatar_url = msg.user.avatar_url;
                if (msg.user.profile_color) currentUser.profile_color = msg.user.profile_color;
                // Refresh auth-dependent UI
                if (typeof onAuthChange === 'function') onAuthChange();
                // Notify user of what changed
                if (msg.user.username && msg.user.username !== oldUsername) {
                    addSystemMessage(`Your username was changed to @${msg.user.username}`);
                }
                if (msg.user.display_name && msg.user.display_name !== oldDisplay) {
                    addSystemMessage(`Your display name was changed to ${msg.user.display_name}`);
                }
            }
            break;
        }
        case 'clear': {
            const { messages: clearTarget } = getChatEl();
            if (clearTarget) clearTarget.innerHTML = '';
            addSystemMessage('Chat was cleared by a moderator');
            break;
        }
        case 'delete-messages': {
            // Remove specific messages from the DOM by their IDs (for other viewers;
            // the acting moderator already removed them optimistically).
            removeMessagesFromDom(msg.ids);
            break;
        }
        case 'purge': {
            // Time-range purge — remove messages within the range from DOM
            const from = msg.from ? new Date(msg.from).getTime() : 0;
            const to = msg.to ? new Date(msg.to).getTime() : Infinity;
            document.querySelectorAll('.chat-msg[data-timestamp]').forEach(el => {
                const ts = new Date(el.dataset.timestamp).getTime();
                if (ts >= from && ts <= to) {
                    el.classList.add('chat-msg-deleted');
                    setTimeout(() => el.remove(), 300);
                }
            });
            addSystemMessage(`Messages purged by ${msg.by || 'a moderator'}`);
            break;
        }
        case 'self-delete-result': {
            const scopeLabel = msg.scope === 'stream' ? 'this chat' : 'your chat history';
            toast(`Deleted ${msg.count || 0} of your message(s) from ${scopeLabel}`, 'success');
            break;
        }
        case 'tts':
            // Legacy browser-side TTS (Self TTS mode)
            // Only use broadcast TTS path when viewing own channel chat
            if (_isViewingOwnBroadcastChat() && broadcastState?.settings?.ttsMode === 'self') {
                // Own channel while live: one speaking tab per device.
                if (isOwnChannelTtsSpeaker() && isChatTTSEnabled({ streaming: true }) && typeof speakBroadcastTTS === 'function' && _isTTSEnabledForSource(msg.source_platform)) {
                    speakBroadcastTTS(msg.message || msg.text, msg.username);
                }
            } else if (_isOwnChannelChat()) {
                // Own channel on any surface (popout / channel page): the streamer IS
                // the audience — no self-filter, one speaking tab per device, gated by
                // the live/offline own-channel TTS options.
                if (isOwnChannelTtsSpeaker() && _ownChannelTtsWanted() && _isTTSEnabledForSource(msg.source_platform)) {
                    speakTTS(msg.message || msg.text, msg.voiceFX, msg.username);
                }
            } else if (isChatTTSEnabled() && !_isOwnTtsMessage(msg) && _isTTSEnabledForSource(msg.source_platform)) {
                speakTTS(msg.message || msg.text, msg.voiceFX, msg.username);
            }
            break;
        case 'tts-audio':
            // Server-synthesized TTS audio (Site-Wide TTS mode)
            // Only route through broadcast audio when on own channel
            if (_isViewingOwnBroadcastChat() && typeof playBroadcastTTSAudio === 'function') {
                if (isOwnChannelTtsSpeaker() && isChatTTSEnabled({ streaming: true }) && _isTTSEnabledForSource(msg.source_platform)
                    && !_ttsRecentlyPlayed(msg)) playBroadcastTTSAudio(msg);
            } else if (_isOwnChannelChat()) {
                if (isOwnChannelTtsSpeaker() && _ownChannelTtsWanted() && _isTTSEnabledForSource(msg.source_platform)) playTTSAudio(msg);
            } else if (isChatTTSEnabled() && !_isOwnTtsMessage(msg) && _isTTSEnabledForSource(msg.source_platform)) {
                playTTSAudio(msg);
            }
            break;
        case 'soundboard-audio':
            // Chat sound clips (101soundboards + channel !sound commands) — play through the
            // audio queue with pitch/speed modifiers. Gated on the sounds toggle, NOT TTS.
            // Own-channel clips follow the one-speaking-tab rule like TTS, on every surface.
            if (_isViewingOwnBroadcastChat() && typeof playBroadcastTTSAudio === 'function') {
                if (isOwnChannelTtsSpeaker() && isChatSoundsEnabled()) playBroadcastTTSAudio(msg);
            } else if (_isOwnChannelChat()) {
                if (isOwnChannelTtsSpeaker() && isChatSoundsEnabled()) playTTSAudio(msg);
            } else if (isChatSoundsEnabled()) {
                playTTSAudio(msg);
            }
            break;
        case 'ban':
        case 'timeout':
            addSystemMessage(msg.message || `User ${msg.username} was ${msg.type === 'ban' ? 'banned' : 'timed out'}`);
            break;
        case 'error':
            addSystemMessage(msg.message, true);
            break;
        case 'emotes-updated':
            // A channel emote was added/removed — refresh so it works without a reload.
            if (typeof reloadChannelEmotes === 'function') reloadChannelEmotes(chatStreamId);
            break;
        case 'sounds-updated':
            // A channel sound command changed — refresh the picker's Channel Sounds.
            if (typeof reloadChannelSounds === 'function') reloadChannelSounds(chatStreamId);
            break;
        case 'slur-blocked':
            showSlurNudgeModal(msg.message || null);
            addSystemMessage('Message blocked by this streamer\'s Anti-Slur Nudge setting.');
            break;
        case 'server_restart':
            // Server is about to restart — show prominent notice with refresh button
            addRichSystemMessage(
                (msg.message || 'Server restarting — chat will reconnect automatically.') +
                ' <button onclick="location.href=location.pathname+\'?_=\'+Date.now()" style="margin-left:8px;padding:2px 10px;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:var(--radius-sm);cursor:pointer;font-size:0.8rem;font-family:var(--font)">Refresh Page</button>',
                'warning'
            );
            break;
        case 'update': {
            // Platform update notification with commit logs + expandable changelog
            const summary = esc(msg.summary || 'New update deployed!');
            const commits = Array.isArray(msg.commits) ? msg.commits : [];
            const linkUrl = msg.url ? esc(msg.url) : null;

            let html = `🚀 ${summary}`;

            if (commits.length > 0) {
                const changelogId = 'update-changelog-' + Date.now();
                html += ` <a href="#" onclick="event.preventDefault();document.getElementById('${changelogId}').classList.toggle('open')" style="color:var(--accent);text-decoration:underline;cursor:pointer">View changelog ▾</a>`;
                if (linkUrl) {
                    html += ` · <a href="${linkUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">Full patch notes →</a>`;
                }
                html += `<div id="${changelogId}" class="chat-changelog" style="display:none;margin-top:6px;padding:6px 8px;background:rgba(0,0,0,0.25);border-radius:6px;font-size:0.82rem;max-height:200px;overflow-y:auto;">`;
                for (const c of commits) {
                    const short = esc(c.short || '');
                    const subject = esc(c.subject || '');
                    const commitUrl = c.hash ? `https://github.com/OpenVibers/OpenVibe.Live/commit/${esc(c.hash)}` : '#';
                    html += `<div style="padding:2px 0;display:flex;gap:6px;align-items:baseline;"><a href="${commitUrl}" target="_blank" rel="noopener" style="color:var(--accent);font-family:monospace;font-size:0.78rem;text-decoration:none;flex-shrink:0">${short}</a> <span style="opacity:0.85">${subject}</span></div>`;
                }
                html += '</div>';
                // Auto-expand with a microtask so the DOM element exists
                setTimeout(() => {
                    const el = document.getElementById(changelogId);
                    if (el) el.classList.add('open'), el.style.display = '';
                }, 0);
            } else if (linkUrl) {
                html += ` <a href="${linkUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">View full patch notes →</a>`;
            }
            html += ' <button onclick="location.href=location.pathname+\'?_=\'+Date.now()" style="margin-left:8px;padding:2px 10px;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:var(--radius-sm);cursor:pointer;font-size:0.8rem;font-family:var(--font)">Refresh Page</button>';
            addRichSystemMessage(html, 'update');
            break;
        }
        case 'coin_earned':
            if (typeof handleCoinEarned === 'function') handleCoinEarned(msg);
            break;
        case 'redemption': {
            const { messages: rContainer } = getChatEl();
            if (rContainer && typeof renderRedemption === 'function') renderRedemption(msg, rContainer);
            break;
        }
        case 'dm':
        case 'dm-participant-added':
            // Route DM events to the messenger widget
            if (typeof window._messengerHandleDm === 'function') {
                window._messengerHandleDm(msg);
            }
            break;
        case 'vc-call-invite': {
            _showIncomingVcCallOverlay(msg);
            break;
        }
        case 'vc-call-response': {
            _handleVcCallResponse(msg);
            break;
        }
    }
}


function addChatMessage(msg) {
    // Feed username into autocomplete cache
    if (typeof acTrackUser === 'function') acTrackUser(msg);

    const chatEl = getChatEl();
    const container = chatEl.messages;

    // De-dupe double-delivered messages (a message can arrive via both the stream room and
    // a cross-slot/global forward). Scoped to what's actually IN this container: we only skip
    // a message whose id is already rendered here. This can never hide a message that isn't
    // already visible, and it resets on its own when the container is cleared (room switch /
    // history reload) — unlike a session-wide "seen" set, which wrongly suppressed messages
    // across rooms and blanked global chat.
    if (msg && msg.id != null && container &&
        container.querySelector(`[data-msg-id="${CSS.escape(String(msg.id))}"]`)) return;

    // Voice Call mode filter: skip messages not tagged with our voice channel
    const isVoiceMsg = !!msg.voiceChannelId;
    if (chatMode === 'voice' && !isVoiceMsg) {
        // Still mirror to floating widget even if filtered from main view
        _fcwAddMessage(msg);
        return;
    }
    if (chatMode === 'voice' && isVoiceMsg) {
        // Only show messages from the same channel
        if (typeof callState !== 'undefined' && callState.joined && msg.voiceChannelId !== callState.channelId) {
            _fcwAddMessage(msg);
            return;
        }
    }

    if (!container) {
        _fcwAddMessage(msg);
        return;
    }
    const el = document.createElement('div');
    el.className = 'chat-msg';

    // Attach message ID for reply targeting
    if (msg.id) el.dataset.msgId = msg.id;
    // Attach timestamp for time-range purge
    if (msg.timestamp) el.dataset.timestamp = msg.timestamp;
    // Attach source platform for relay user identification
    // Live relay messages carry role 'external'; history-loaded ones don't (null role),
    // and messages forwarded to the GLOBAL feed can arrive without source_platform at all —
    // so also detect relay from the "[RS]/[Twitch]/…" username prefix. Keep dataset.isRelay
    // and dataset.sourcePlatform in sync with the badge/avatar (which already use this
    // fallback) so the right-click menu shows the relay menu, not the generic profile one.
    const _relayPlatformDetected = (isRelayPlatform(msg.source_platform) ? msg.source_platform : '') ||
        (isRelayPlatform(parseRelayUsername(msg.username || '').platform) ? parseRelayUsername(msg.username || '').platform : '');
    if (msg.source_platform) el.dataset.sourcePlatform = msg.source_platform;
    else if (_relayPlatformDetected) el.dataset.sourcePlatform = _relayPlatformDetected;
    if (msg.role === 'external' || _relayPlatformDetected) el.dataset.isRelay = '1';
    if (msg.message_type === 'news') el.classList.add('news');
    if (msg.message_type === 'soundboard') el.classList.add('soundboard');

    const isGlobal = chatEl.isGlobal;

    // Timestamps — normalize to UTC then display in browser local time
    const showTs = isGlobal || chatSettings.showTimestamps;
    let tsSource;
    if (msg.timestamp) {
        tsSource = _parseMsgTime(msg.timestamp);
    } else {
        tsSource = new Date();
    }
    const tsOpts = chatSettings.timestampFormat === '24h'
        ? { hour: '2-digit', minute: '2-digit', hour12: false }
        : { hour: '2-digit', minute: '2-digit' };
    const timestamp = showTs
        ? `<span class="chat-time-inline">${tsSource.toLocaleTimeString([], tsOpts)}</span> `
        : '';

    // Stream source badge for global chat: show the STREAM TITLE (username fallback).
    // Live → click opens the live stream; offline → opens the streamer's channel.
    let streamBadge = '';
    if (isGlobal) {
        const srcUser = msg.stream_channel || msg.stream_username || '';
        if (srcUser) {
            const label = esc(msg.source_stream_title || srcUser);
            const chEsc = esc(srcUser);
            const ref = esc(msg.source_slug || msg.source_managed_id || '');
            if (msg.source_is_live) {
                streamBadge = `<span class="chat-stream-badge chat-stream-badge-live" title="Live: ${label} — click to watch" data-channel="${chEsc}" data-ref="${ref}" onclick="hopToStreamSlot(this)">${label}</span> `;
            } else {
                streamBadge = `<span class="chat-stream-badge" title="From ${chEsc} (offline) — open channel" data-channel="${chEsc}" onclick="navigate(channelPath(this.dataset.channel))">${label}</span> `;
            }
        }
    }

    // Cross-slot origin badge: tag messages that came from a DIFFERENT live slot of
    // this same streamer. Keyed on the SLOT (managed_stream_id), not the session id,
    // so older sessions of the slot you're watching don't get tagged. Applies to both
    // live cross-slot messages and streamer-wide history — consistently.
    const _curManagedId = ((typeof currentStreamData !== 'undefined' && currentStreamData && currentStreamData.managed_stream_id != null)
        ? currentStreamData.managed_stream_id : chatCurrentManagedId);
    const _srcManagedId = (msg.source_managed_id != null) ? Number(msg.source_managed_id) : null;
    const isOtherSlot = !isGlobal && _srcManagedId != null && _curManagedId != null
        && _srcManagedId !== Number(_curManagedId) && (msg.source_stream_title || msg.source_slug);
    if (isOtherSlot) {
        el.classList.add('chat-msg-otherslot');
        const srcTitle = esc(msg.source_stream_title || msg.source_slug || 'other stream');
        const ch = esc(msg.source_channel || chatChannel || '');
        const ref = esc(String(msg.source_slug || msg.source_managed_id || ''));
        if (msg.source_is_live && ch && ref) {
            streamBadge += `<span class="chat-stream-badge chat-origin-badge" title="From this streamer's other live stream — click to watch" data-channel="${ch}" data-ref="${ref}" onclick="hopToStreamSlot(this)">${srcTitle}</span> `;
        } else {
            streamBadge += `<span class="chat-stream-badge chat-origin-badge chat-origin-offline" title="From this streamer's stream: ${srcTitle}">${srcTitle}</span> `;
        }
    }

    // Voice call badge (shown in global mode for voice-tagged messages)
    let voiceBadge = '';
    if (isGlobal && isVoiceMsg && chatMode === 'global') {
        voiceBadge = `<span class="chat-voice-badge" title="Voice Channel"><i class="fa-solid fa-headset"></i> VC</span> `;
    }

    // Game chat badge
    let gameBadge = '';
    if (isGlobal && msg.is_game_chat) {
        gameBadge = `<span class="chat-game-badge" title="Game Chat"><i class="fa-solid fa-gamepad"></i></span> `;
    }

    const badge = chatSettings.showBadges ? getBadgeHTML(msg.role) : '';
    let nameColor = relayColorFor(msg) || msg.color || msg.profile_color || getRoleColor(msg.role);
    // Readable colors — ensure minimum contrast against dark backgrounds
    if (chatSettings.readableColors) nameColor = ensureReadableColor(nameColor);

    const displayName = esc(msg.username || msg.displayName || `anon${msg.anonId || ''}`);
    const coreUsername = esc(msg.core_username || '');
    // Avatar initial: strip any "[Twitch]/[Kick]/[RS]" relay prefix so external
    // users show their real first letter instead of "[".
    const _rawName = (msg.username || msg.displayName || `anon${msg.anonId || ''}`).replace(/^\[[^\]]+\]\s*/, '');
    const avatarInitial = esc((_rawName.charAt(0) || '?').toUpperCase());
    // Relay platform badge (icon) replaces the "[Twitch]/[RS]" text prefix. The
    // visible name is the clean name; data-username keeps the prefix so relay
    // moderation still identifies the platform + external user.
    const _relayPlatform = (msg.source_platform || parseRelayUsername(msg.username || '').platform || '').toLowerCase();
    const _relayBadge = relayBadgeHTML(_relayPlatform);
    const _aiBadge = (msg.is_ai || msg.source_platform === 'ai') ? '<span class="chat-ai-badge" title="AI chat viewer">AI</span>' : '';
    const _visibleName = _relayBadge ? esc(_rawName) : displayName;
    const rawText = msg.message || msg.text || '';
    // Messages prefixed with "." skipped TTS — mark them muted and hide the "." marker.
    const ttsOff = (!msg.message_type || msg.message_type === 'chat') && rawText.trimStart().startsWith('.');
    if (ttsOff) el.classList.add('chat-msg-tts-off');
    const displayRaw = ttsOff ? rawText.replace(/^\s*\.\s?/, '') : rawText;
    let text = (typeof parseEmotes === 'function') ? parseEmotes(displayRaw) : esc(displayRaw);
    // Append clickable source link for news headlines
    if (msg.message_type === 'news' && msg.url) {
        text += ` <a href="${esc(msg.url)}" target="_blank" rel="noopener" class="news-link"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>`;
    }
    // Clip-published announcement — render a clickable clip card (thumbnail + title).
    if (msg.message_type === 'clip') {
        let clip = msg.clip;
        if (!clip && msg.metadata) { try { clip = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata; } catch { clip = null; } }
        if (clip && clip.clip_id) {
            const dur = (clip.duration && typeof formatDuration === 'function') ? formatDuration(clip.duration) : '';
            const isAuto = !!clip.auto;
            const thumb = clip.thumbnail_url
                ? `<div class="clip-chat-thumb"><img src="${esc(clip.thumbnail_url)}" alt="" loading="lazy">${dur ? `<span class="clip-chat-dur">${esc(dur)}</span>` : ''}<span class="clip-chat-play"><i class="fa-solid fa-play"></i></span></div>`
                : `<div class="clip-chat-thumb clip-chat-thumb-ph"><i class="fa-solid fa-scissors"></i></div>`;
            const label = isAuto
                ? `<div class="clip-chat-label"><i class="fa-solid fa-wand-magic-sparkles"></i> AI clip</div>`
                : `<div class="clip-chat-label"><i class="fa-solid fa-scissors"></i> New clip</div>`;
            const creator = esc(clip.creator || msg.username || 'someone');
            const avatar = clip.creator_avatar
                ? `<img class="clip-chat-avatar" src="${esc(clip.creator_avatar)}" alt="" loading="lazy">`
                : `<span class="clip-chat-avatar clip-chat-avatar-ltr" style="background:${esc(clip.creator_color || 'var(--accent)')}">${creator.charAt(0).toUpperCase()}</span>`;
            const metaLine = isAuto
                ? `<div class="clip-chat-meta"><i class="fa-solid fa-robot"></i> Auto-generated highlight</div>`
                : `<div class="clip-chat-meta">${avatar}<span>Clipped by ${creator}</span></div>`;
            text = `<a class="clip-chat-card${isAuto ? ' clip-chat-card-ai' : ''}" href="/clip/${clip.clip_id}" onclick="return handleLinkClick(event, '/clip/${clip.clip_id}')" title="Watch clip">
                ${thumb}
                <div class="clip-chat-info">
                    ${label}
                    <div class="clip-chat-title">${esc(clip.title || 'Untitled Clip')}</div>
                    ${metaLine}
                    <span class="clip-chat-cta">Watch clip <i class="fa-solid fa-arrow-right"></i></span>
                </div>
            </a>`;
        }
    }
    if (msg.message_type === 'soundboard' && msg.soundboard) {
        const title = esc(msg.soundboard.title || `Sound ${msg.soundboard.soundId || ''}`);
        const sourceUrl = esc(msg.soundboard.sourceUrl || '#');
        const soundId = esc(String(msg.soundboard.soundId || ''));
        const pitch = Number(msg.soundboard.pitch || 1);
        const speed = Number(msg.soundboard.speed || 1);
        const mods = [];
        if (Math.abs(pitch - 1) > 0.001) mods.push(`Pitch ${pitch.toFixed(2)}x`);
        if (Math.abs(speed - 1) > 0.001) mods.push(`Speed ${speed.toFixed(2)}x`);
        text = `
            <div class="soundboard-card">
                <div class="soundboard-card-label"><i class="fa-solid fa-volume-high"></i> 101soundboards</div>
                <a class="soundboard-card-title" href="${sourceUrl}" target="_blank" rel="noopener">${title}</a>
                <div class="soundboard-card-meta">ID ${soundId}${mods.length ? ` · ${esc(mods.join(' · '))}` : ''}</div>
            </div>
        `;
    }
    if (msg.message_type === 'channel-sound') {
        const cmd = esc((msg.sound && msg.sound.command) || '');
        const sSpeed = Number((msg.sound && msg.sound.speed) || 1);
        const sPitchShift = Number((msg.sound && msg.sound.pitchShift) || 0);
        const argStr = esc((msg.sound && msg.sound.args) || '');
        let modBadges = '';
        if (Math.abs(sSpeed - 1) > 0.001) {
            modBadges += `<span class="channel-sound-mod" style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:10px;background:rgba(0,0,0,0.25);font-size:0.82em"><i class="fa-solid fa-gauge-high"></i> ${sSpeed.toFixed(2)}x</span>`;
        }
        if (Math.abs(sPitchShift) > 0.5) {
            const sign = sPitchShift > 0 ? '+' : '';
            modBadges += `<span class="channel-sound-mod" style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:10px;background:rgba(0,0,0,0.25);font-size:0.82em"><i class="fa-solid fa-music"></i> ${sign}${Math.round(sPitchShift)}</span>`;
        }
        // If the command has an emote attached, show the emote + "!" (emote+sound combo)
        // instead of the "played !cmd" pill.
        const emoteCode = (msg.sound && msg.sound.emoteCode) || '';
        const emote = emoteCode && typeof emoteMap !== 'undefined' && emoteMap.get ? emoteMap.get(emoteCode) : null;
        if (emote) {
            const cls = emote.animated ? 'chat-emote chat-emote-animated' : 'chat-emote';
            const sz = Number(emote.size);
            const sizeStyle = (sz && sz !== 100) ? ` style="height:calc(1.6em * var(--chat-emote-scale,1) * ${Math.max(0.25, Math.min(4, sz / 100))})"` : '';
            text = `<span class="channel-sound-emote" style="display:inline-flex;align-items:center;gap:2px" title="!${cmd}"><span style="font-weight:700;color:var(--accent,#e0a44a)">!</span><img class="${cls}"${sizeStyle} src="${esc(emote.url)}" alt="!${cmd}" draggable="false">${modBadges}</span>`;
        } else {
            const label = argStr ? `played !${cmd} ${argStr}` : `played !${cmd}`;
            text = `<span class="channel-sound-pill" style="display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:12px;background:color-mix(in srgb,var(--accent,#e0a44a) 18%,transparent);color:var(--accent,#e0a44a);font-weight:600;font-size:0.92em"><i class="fa-solid fa-volume-high"></i> ${label}${modBadges}</span>`;
        }
    }
    const isAnon = displayName.startsWith('anon');

    // Mention highlighting
    const currentUser = getCurrentUsername();
    const isMention = currentUser && rawText.toLowerCase().includes(`@${currentUser.toLowerCase()}`);
    if (isMention && chatSettings.mentionHighlight) {
        el.classList.add('chat-msg-mention');
        // Only alert (tab flash / sound) for LIVE mentions — not when replaying
        // chat history, where old, already-seen mentions would otherwise falsely
        // flash the tab title as if someone just mentioned you.
        if (!_loadingHistory) {
            if (chatSettings.flashOnMention) flashTabTitle(displayName);
            if (chatSettings.soundOnMention) playMentionSound();
        }
    }

    // Avatar (respects showAvatars setting via CSS class on root, but still render for toggle)
    const avatarHtml = msg.avatar_url
        ? `<img class="chat-avatar" src="${esc(msg.avatar_url)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display=''">`
        + `<span class="chat-avatar-letter" style="display:none;background:${esc(nameColor)}">${avatarInitial}</span>`
        : `<span class="chat-avatar-letter" style="background:${esc(nameColor)}">${avatarInitial}</span>`;

    const userId = esc(String(msg.user_id || ''));

    // ── Cosmetic rendering ───────────────────────────────
    // Hat emoji before name
    let hatHtml = '';
    if (msg.hatFX && msg.hatFX.hatChar) {
        const animClass = msg.hatFX.animated ? ` hat-${esc(msg.hatFX.animated)}` : '';
        hatHtml = `<span class="chat-hat${animClass}">${esc(msg.hatFX.hatChar)}</span>`;
    }

    // Name effect CSS class on username
    const nameFXClass = msg.nameFX?.cssClass ? ` ${esc(msg.nameFX.cssClass)}` : '';

    // Particle wrapper
    const hasParticles = msg.particleFX?.chars;
    const particleWrapOpen = hasParticles ? `<span class="chat-particle-wrap ${esc(msg.particleFX.cssClass || '')}">` : '';
    const particleWrapClose = hasParticles ? `</span>` : '';

    // Reply header (if this message is a reply)
    let replyHtml = '';
    if (msg.reply_to) {
        const replyUser = esc(msg.reply_to.username || 'unknown');
        const replySnippet = esc(msg.reply_to.message || '');
        const replyMsgId = msg.reply_to.id ? `data-reply-target="${esc(String(msg.reply_to.id))}"` : '';
        replyHtml = `<div class="chat-reply-header" ${replyMsgId} onclick="scrollToReplyTarget(this)"><i class="fa-solid fa-reply fa-flip-horizontal"></i> <span class="chat-reply-user">@${replyUser}</span> <span class="chat-reply-snippet">${replySnippet}</span></div>`;
    }

    // tts-off messages drop the ":" so it reads "name 🔇 message" after the mute marker.
    const separator = (ttsOff || msg.message_type === 'soundboard' || msg.message_type === 'channel-sound') ? ' ' : ': ';
    el.innerHTML = `${replyHtml}${timestamp}${streamBadge}${voiceBadge}${gameBadge}<span class="chat-avatar-wrap">${avatarHtml}</span>${badge}${_relayBadge}${_aiBadge}${hatHtml}${particleWrapOpen}<span class="chat-user${nameFXClass}" style="color:${esc(nameColor)}" data-username="${displayName}" data-core-username="${coreUsername}" data-user-id="${userId}" data-anon="${isAnon ? '1' : ''}" oncontextmenu="showChatContextMenu(event)" onclick="showChatContextMenu(event)">${_visibleName}</span>${particleWrapClose}${separator}${text}`;

    // Reply action button (hover)
    if (msg.id) {
        const replyBtn = document.createElement('button');
        replyBtn.className = 'chat-reply-btn';
        replyBtn.title = 'Reply';
        replyBtn.innerHTML = '<i class="fa-solid fa-reply"></i>';
        replyBtn.onclick = (e) => {
            e.stopPropagation();
            setChatReply({
                id: msg.id,
                username: msg.username || msg.displayName || 'anon',
                user_id: msg.user_id,
                message: (msg.message || msg.text || '').slice(0, 100),
            });
        };
        el.appendChild(replyBtn);
        el.classList.add('chat-msg-hoverable');
    }

    // Spawn particles if equipped
    if (hasParticles) {
        const wrap = el.querySelector('.chat-particle-wrap');
        if (wrap) spawnChatParticles(wrap, msg.particleFX.chars);
    }

    // Freeze animated emotes if setting is off
    if (!chatSettings.animatedEmotes) {
        el.querySelectorAll('.chat-emote-animated').forEach(img => {
            freezeGifEmote(img);
        });
    }

    container.appendChild(el);
    // Cap the main chat DOM so a long/busy session doesn't accumulate thousands of heavy
    // message nodes (memory + scroll/layout thrash). Mirrors the caps the cross-feed /
    // widget containers already have. Don't trim mid history-hydration.
    if (!_loadingHistory) {
        while (container.children.length > MAIN_CHAT_MAX_MESSAGES) container.removeChild(container.firstChild);
    }
    if (chatSettings.autoScroll) {
        if (_loadingHistory) {
            // During history loading, force-scroll without the nearBottom guard
            // to avoid false "user scrolled up" detection from rapid DOM appends
            scrollChatToBottom();
        } else {
            scrollChat();
            // If user is scrolled up, show the new-messages indicator instead
            if (_chatUserScrolledUp) _onNewChatMessageWhileScrolledUp();
        }
    }

    // Mirror message to floating chat widget (for non-chat pages)
    _fcwAddMessage(msg);
    queueFullscreenChatEntry(buildFullscreenChatEntry(msg));
}

/**
 * Spawn small particle characters around a name element
 */
function spawnChatParticles(wrap, chars) {
    const charArr = [...chars];
    const count = 3 + Math.floor(Math.random() * 3); // 3-5 particles
    for (let i = 0; i < count; i++) {
        const p = document.createElement('span');
        p.className = 'chat-particle';
        p.textContent = charArr[Math.floor(Math.random() * charArr.length)];
        const dx = (Math.random() - 0.5) * 40;
        const dy = -10 - Math.random() * 25;
        p.style.setProperty('--px-dx', `${dx}px`);
        p.style.setProperty('--px-dy', `${dy}px`);
        p.style.left = `${Math.random() * 80}%`;
        p.style.top = `${Math.random() * 60}%`;
        p.style.animationDelay = `${Math.random() * 0.4}s`;
        wrap.appendChild(p);
        // Clean up after animation
        setTimeout(() => p.remove(), 2200);
    }
}

function addSystemMessage(text, isError = false) {
    const { messages: container } = getChatEl();
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'chat-msg system';
    if (isError) el.style.color = 'var(--danger)';
    el.textContent = text;
    container.appendChild(el);
    scrollChat();
    if (_chatUserScrolledUp) _onNewChatMessageWhileScrolledUp();
    if (text) {
        queueFullscreenChatEntry({
            kind: 'system',
            html: `<div class="fullscreen-chat-text">${esc(text)}</div>`,
        });
    }
}

/**
 * Build avatar HTML for a chat message (reusable helper).
 * Returns an <img> with letter fallback, or just a letter span for anon users.
 */
function getChatAvatarHTML(msg) {
    let nameColor = relayColorFor(msg) || msg.color || msg.profile_color || getRoleColor(msg.role);
    if (chatSettings.readableColors) nameColor = ensureReadableColor(nameColor);
    // Strip any "[Twitch]/[Kick]/[RS]" relay prefix so the initial is the real letter.
    const raw = (msg.username || msg.displayName || `anon${msg.anonId || ''}`).replace(/^\[[^\]]+\]\s*/, '');
    const initial = esc((raw.charAt(0) || '?').toUpperCase());
    return msg.avatar_url
        ? `<img class="chat-avatar" src="${esc(msg.avatar_url)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display=''">`
        + `<span class="chat-avatar-letter" style="display:none;background:${esc(nameColor)}">${initial}</span>`
        : `<span class="chat-avatar-letter" style="background:${esc(nameColor)}">${initial}</span>`;
}

function addGottiMessage(msg) {
    const { messages: container } = getChatEl();
    if (!container) return;

    const el = document.createElement('div');
    el.className = 'chat-msg gotti';

    const badge = chatSettings.showBadges ? getBadgeHTML(msg.role) : '';
    const avatarHtml = getChatAvatarHTML(msg);
    const hatHtml = msg.hatFX?.emoji ? `<span class="chat-hat" aria-hidden="true">${esc(msg.hatFX.emoji)}</span>` : '';
    let nameColor = relayColorFor(msg) || msg.color || msg.profile_color || getRoleColor(msg.role);
    if (chatSettings.readableColors) nameColor = ensureReadableColor(nameColor);

    const displayName = esc(msg.username || msg.displayName || `anon${msg.anonId || ''}`);
    const coreUsername = esc(msg.core_username || '');
    const userId = esc(String(msg.user_id || ''));
    const isAnon = !msg.user_id;
    const nameFXClass = msg.nameFX?.cssClass ? ` ${esc(msg.nameFX.cssClass)}` : '';
    const hasParticles = msg.particleFX?.chars;
    const particleWrapOpen = hasParticles ? `<span class="chat-particle-wrap ${esc(msg.particleFX.cssClass || '')}">` : '';
    const particleWrapClose = hasParticles ? '</span>' : '';
    const gifUrl = esc(msg.gif_url || '');
    const sourceUrl = esc(msg.source_url || gifUrl);
    const caption = esc(msg.message || 'GOTTI!');

    el.innerHTML = `${badge}${hatHtml}${particleWrapOpen}<span class="chat-avatar-wrap">${avatarHtml}</span><span class="chat-user${nameFXClass}" style="color:${esc(nameColor)}" data-username="${displayName}" data-core-username="${coreUsername}" data-user-id="${userId}" data-anon="${isAnon ? '1' : ''}" oncontextmenu="showChatContextMenu(event)" onclick="showChatContextMenu(event)">${displayName}</span>${particleWrapClose}<div class="gotti-card"><div class="gotti-card-media"><img class="gotti-card-image" src="${gifUrl}" alt="${caption}" loading="lazy"></div><div class="gotti-card-copy"><div class="gotti-card-title">${caption}</div><a class="gotti-card-link" href="${sourceUrl}" target="_blank" rel="noopener">Open source GIF</a></div></div>`;

    if (hasParticles) {
        const wrap = el.querySelector('.chat-particle-wrap');
        if (wrap) spawnChatParticles(wrap, msg.particleFX.chars);
    }

    container.appendChild(el);
    if (chatSettings.autoScroll) {
        scrollChat();
        if (_chatUserScrolledUp) _onNewChatMessageWhileScrolledUp();
    }

    _fcwAddMessage({
        ...msg,
        message: `${msg.message || 'GOTTI!'} ${msg.source_url || msg.gif_url || ''}`,
    });

    queueFullscreenChatEntry({
        kind: 'gotti',
        html: `<div class="fullscreen-chat-meta"><span class="fullscreen-chat-user" style="color:${esc(nameColor)}">${badge}${displayName}</span></div><div class="fullscreen-chat-text">${caption}</div><img class="fullscreen-chat-gotti" src="${gifUrl}" alt="${caption}" loading="lazy">`,
    });
}

/**
 * Add a rich system message that supports HTML (links, formatting).
 * @param {string} html - Pre-escaped HTML content
 * @param {'warning'|'update'|'info'} style - Visual style variant
 */
function addRichSystemMessage(html, style = 'info') {
    const { messages: container } = getChatEl();
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'chat-msg system';
    if (style === 'warning') el.style.color = 'var(--warning, #f59e0b)';
    else if (style === 'update') el.style.color = 'var(--accent)';
    el.innerHTML = html;
    container.appendChild(el);
    scrollChat();
    if (_chatUserScrolledUp) _onNewChatMessageWhileScrolledUp();
}

function addDonationMessage(msg) {
    const { messages: container } = getChatEl();
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'chat-msg donation';

    const donorName = esc(msg.username || msg.from || 'Anonymous');
    const amount = Math.round(msg.amount || 0);
    const amtStr = amount.toLocaleString();
    const rawDonText = msg.message || '';
    const text = rawDonText ? `: ${(typeof parseEmotes === 'function') ? parseEmotes(rawDonText) : esc(rawDonText)}` : '';

    el.innerHTML = `<i class="fa-solid fa-coins" style="color:var(--accent)"></i> <strong>${donorName}</strong> donated <strong>${amtStr} Vibes</strong>${text}`;

    container.appendChild(el);
    scrollChat();
    if (_chatUserScrolledUp) _onNewChatMessageWhileScrolledUp();
    queueFullscreenChatEntry({
        kind: 'donation',
        html: `<div class="fullscreen-chat-meta"><span class="fullscreen-chat-user" style="color:var(--accent)"><i class="fa-solid fa-coins"></i> ${donorName}</span></div><div class="fullscreen-chat-text">donated <strong>${amtStr} Vibes</strong>${text}</div>`,
    });

    // TTS for donations
    if (document.getElementById('tts-checkbox')?.checked) {
        speakTTS(`${donorName} donated ${amount} Vibes. ${msg.message || ''}`);
    }
}

// Flashy animated "donation goal reached" celebration card (with the streamer's goal
// image/video if set). Persisted to history so late-joiners see it too.
function addDonationGoalMessage(msg) {
    const { messages: container } = getChatEl();
    if (!container) return;
    const g = msg.goal || {};
    const by = esc(msg.by || 'the community');
    const title = esc(g.title || 'Goal');
    const target = (g.target_amount != null && g.target_amount !== '') ? `${Number(g.target_amount).toLocaleString()} Vibes` : '';
    const media = g.image_url
        ? (g.media_type === 'video'
            ? `<video class="cgr-media" src="${esc(g.image_url)}" muted loop autoplay playsinline></video>`
            : `<img class="cgr-media" src="${esc(g.image_url)}" alt="">`)
        : '';
    const el = document.createElement('div');
    el.className = 'chat-msg goal-reached-msg';
    el.innerHTML = `
        <div class="cgr-card">
            <div class="cgr-shine"></div>
            ${media}
            <div class="cgr-inner">
                <div class="cgr-badge"><i class="fa-solid fa-trophy"></i> GOAL REACHED!</div>
                <div class="cgr-title">${title}</div>
                <div class="cgr-sub">${target ? target + ' raised — ' : ''}thanks to ${by}!</div>
            </div>
        </div>`;
    container.appendChild(el);
    try { spawnChatParticles(el.querySelector('.cgr-card') || el, '🎉🎊✨💰⭐'); } catch { /* */ }
    scrollChat();
    if (_chatUserScrolledUp) _onNewChatMessageWhileScrolledUp();
    queueFullscreenChatEntry({
        kind: 'goal-reached',
        html: `<div class="fullscreen-chat-text">🎉 <strong>Goal reached:</strong> ${title}${target ? ' (' + target + ')' : ''} — thanks to ${by}!</div>`,
    });
    if (document.getElementById('tts-checkbox')?.checked) {
        speakTTS(`Donation goal reached! ${g.title || ''}`);
    }
}

/* ── Slow Mode Indicator ───────────────────────────────────── */
function getOrCreateSlowModeBanner(inputArea) {
    let banner = inputArea.querySelector('.chat-slowmode-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.className = 'chat-slowmode-banner';
        banner.innerHTML = `
            <div class="chat-slowmode-info">
                <i class="fa-solid fa-clock"></i>
                <span class="chat-slowmode-label">Slow mode</span>
                <span class="chat-slowmode-duration"></span>
            </div>
            <div class="chat-slowmode-bar"><div class="chat-slowmode-fill"></div></div>
        `;
        // Insert before the input row
        const row = inputArea.querySelector('.chat-input-row');
        if (row) inputArea.insertBefore(banner, row);
        else inputArea.prepend(banner);
    }
    return banner;
}

function updateSlowModeIndicator() {
    document.querySelectorAll('.chat-input-area').forEach(area => {
        const banner = getOrCreateSlowModeBanner(area);
        if (chatSlowModeSeconds > 0) {
            banner.style.display = '';
            banner.querySelector('.chat-slowmode-duration').textContent = `${chatSlowModeSeconds}s`;
        } else {
            banner.style.display = 'none';
            // Clear any active cooldown
            clearSlowModeCooldown();
        }
    });
}

function startSlowModeCooldown() {
    if (chatSlowModeSeconds <= 0) return;
    chatSlowModeCooldownEnd = Date.now() + chatSlowModeSeconds * 1000;

    // Disable send buttons and update all banners
    document.querySelectorAll('.chat-input-area').forEach(area => {
        const banner = getOrCreateSlowModeBanner(area);
        banner.classList.add('cooldown');
        const fill = banner.querySelector('.chat-slowmode-fill');
        if (fill) {
            fill.style.transition = 'none';
            fill.style.width = '100%';
            // Force reflow then animate
            fill.offsetHeight; // eslint-disable-line no-unused-expressions
            fill.style.transition = `width ${chatSlowModeSeconds}s linear`;
            fill.style.width = '0%';
        }
        const sendBtn = area.querySelector('.chat-send-btn');
        if (sendBtn) sendBtn.classList.add('disabled');
    });

    // Countdown tick
    if (chatSlowModeCooldownTimer) clearInterval(chatSlowModeCooldownTimer);
    chatSlowModeCooldownTimer = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((chatSlowModeCooldownEnd - Date.now()) / 1000));
        document.querySelectorAll('.chat-slowmode-banner.cooldown .chat-slowmode-duration').forEach(el => {
            el.textContent = remaining > 0 ? `${remaining}s` : `${chatSlowModeSeconds}s`;
        });
        if (remaining <= 0) {
            clearSlowModeCooldown();
        }
    }, 250);
}

function clearSlowModeCooldown() {
    if (chatSlowModeCooldownTimer) { clearInterval(chatSlowModeCooldownTimer); chatSlowModeCooldownTimer = null; }
    chatSlowModeCooldownEnd = 0;
    document.querySelectorAll('.chat-input-area').forEach(area => {
        const banner = area.querySelector('.chat-slowmode-banner');
        if (banner) {
            banner.classList.remove('cooldown');
            const dur = banner.querySelector('.chat-slowmode-duration');
            if (dur && chatSlowModeSeconds > 0) dur.textContent = `${chatSlowModeSeconds}s`;
            const fill = banner.querySelector('.chat-slowmode-fill');
            if (fill) { fill.style.transition = 'none'; fill.style.width = '0%'; }
        }
        const sendBtn = area.querySelector('.chat-send-btn');
        if (sendBtn) sendBtn.classList.remove('disabled');
    });
}

/* ── Send ──────────────────────────────────────────────────────── */

// ── Message history (up/down arrow recall) ───────────────────
const _chatMsgHistory = [];
let _chatHistoryIndex = -1;
let _chatHistoryDraft = '';
const CHAT_HISTORY_MAX = 50;
const CHAT_TEXTAREA_MAX_LINES = 4;

function normalizeSlurText(input) {
    const map = {
        '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a',
        '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
        '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't',
    };
    const lower = String(input || '').toLowerCase();
    const mapped = lower.split('').map((ch) => map[ch] || ch).join('');
    const ascii = mapped.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    const lettersOnly = ascii.replace(/[^a-z]/g, '');
    return lettersOnly.replace(/(.)\1{1,}/g, '$1');
}

function normalizeSlurPatternText(input) {
    const map = {
        '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a',
        '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
        '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't',
    };
    const lower = String(input || '').toLowerCase();
    const mapped = lower.split('').map((ch) => map[ch] || ch).join('');
    const ascii = mapped.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return ascii.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function compileRegexRules(rules, { forceInsensitive = true } = {}) {
    const compiled = [];
    for (const raw of rules || []) {
        if (!raw || raw.length > 200) continue;
        let source = raw;
        let flags = forceInsensitive ? 'i' : '';

        const wrapped = raw.match(/^\/(.+)\/([a-z]*)$/i);
        if (wrapped) {
            source = wrapped[1];
            flags = wrapped[2] || '';
            if (forceInsensitive && !flags.includes('i')) flags += 'i';
        }
        try {
            compiled.push(new RegExp(source, flags));
        } catch {
            // Ignore invalid user-provided regex entries.
        }
    }
    return compiled;
}

function getSlurPatternCandidates(text) {
    const normalized = normalizeSlurPatternText(text);
    if (!normalized) return [];
    return [normalized, normalized.replace(/\s+/g, '')];
}

function messageHitsCoreSlurPolicy(text, disabledCategories = []) {
    const candidates = getSlurPatternCandidates(text);
    if (!candidates.length) return false;
    const disabled = new Set(disabledCategories);
    return CHAT_CORE_SLUR_CATEGORIES.some((cat) => {
        if (disabled.has(cat.key)) return false;
        return candidates.some((candidate) => cat.compiled.some((pat) => pat.test(candidate)));
    });
}

function messageHitsCustomRegexPolicy(text) {
    if (!chatSlurPolicy.regexes?.length) return false;
    const candidates = getSlurPatternCandidates(text);
    if (!candidates.length) return false;
    const patterns = compileRegexRules(chatSlurPolicy.regexes, { forceInsensitive: true });
    return patterns.some((pattern) => candidates.some((candidate) => pattern.test(candidate)));
}

function messageHitsSlurPolicy(text) {
    if (!chatSlurPolicy.enabled) return false;
    const normalizedText = normalizeSlurText(text);
    const hitsConfigured = !!normalizedText && chatSlurPolicy.terms.some((term) => {
        const normalizedTerm = normalizeSlurText(term);
        return normalizedTerm.length >= 2 && normalizedText.includes(normalizedTerm);
    });
    const hitsCore = chatSlurPolicy.useBuiltin && messageHitsCoreSlurPolicy(text, chatSlurPolicy.disabledCategories);
    const hitsRegex = messageHitsCustomRegexPolicy(text);
    return hitsConfigured || hitsCore || hitsRegex;
}

function showSlurNudgeModal(customMessage = null) {
    const existing = document.getElementById('chat-slur-nudge-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'chat-slur-nudge-modal';
    modal.className = 'chat-slur-nudge-modal';

    const message = String(customMessage || chatSlurPolicy.message || '').trim()
        || 'This streamer enabled Anti-Slur Nudge for this chat. Roast smarter, not lazier. Pick a different word and keep the banter fun.';

    modal.innerHTML = `
        <div class="chat-slur-nudge-card" role="dialog" aria-modal="true" aria-label="Chat message blocked">
            <h3><i class="fa-solid fa-comments"></i> Message Not Sent</h3>
            <p>${esc(message)}</p>
            <p class="chat-slur-nudge-sub">Streamer setting: Anti-Slur Nudge is enabled in this channel.</p>
            <button class="btn btn-primary" id="chat-slur-nudge-ok">Got it</button>
        </div>`;

    modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.remove();
    });
    document.body.appendChild(modal);
    const okBtn = modal.querySelector('#chat-slur-nudge-ok');
    if (okBtn) okBtn.addEventListener('click', () => modal.remove());
}

function sendChat(overrideInput = null) {
    const input = overrideInput || getChatEl().input;
    if (!input) return;
    let text = input.value.trim();
    if (!text) return;

    // TTS-off toggle: when the TTS button for this chat surface is OFF, prepend a
    // "." so the message is skipped by the TTS pipeline (server + all clients).
    // Users can also type "." manually for the same effect.
    // (Skip commands/sounds like "!clip" or "/tts" — only plain chat text is TTS'd.)
    const _ttsBtn = input.closest('.chat-input-area, .pc-input-area')?.querySelector('.chat-tts-toggle');
    if (_ttsBtn && !_ttsBtn.classList.contains('tts-active') && !/^[.!/]/.test(text)) {
        text = '.' + text;
    }

    if (messageHitsSlurPolicy(text)) {
        showSlurNudgeModal();
        return;
    }

    // If WS is down (server restarting, etc.), send to global chat via REST API
    if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
        _sendChatViaRest(text, input);
        return;
    }

    // Client-side cooldown enforcement
    if (chatSlowModeCooldownEnd > Date.now()) {
        const remaining = Math.ceil((chatSlowModeCooldownEnd - Date.now()) / 1000);
        addSystemMessage(`Slow mode: wait ${remaining}s`);
        return;
    }

    // Save to message history
    if (_chatMsgHistory[0] !== text) {
        _chatMsgHistory.unshift(text);
        if (_chatMsgHistory.length > CHAT_HISTORY_MAX) _chatMsgHistory.pop();
    }
    _chatHistoryIndex = -1;
    _chatHistoryDraft = '';

    const msg = {
        type: 'chat',
        message: text,
        streamId: chatStreamId,
    };

    const autoDeleteMinutes = normalizeChatAutoDeleteMinutes(chatSettings.autoDeleteMinutes);
    if (autoDeleteMinutes >= (chatSelfDeletePolicy.minMinutes || CHAT_SELF_DELETE_MINUTES) && canUseViewerAutoDeleteHere()) {
        msg.auto_delete_minutes = autoDeleteMinutes;
    }

    // Attach reply-to if replying
    if (_chatReplyTo) {
        msg.reply_to_id = _chatReplyTo.id;
    }

    // Tag message with voice channel ID if in voice call chat mode
    if (chatMode === 'voice' && typeof callState !== 'undefined' && callState.joined && callState.channelId) {
        msg.voiceChannelId = callState.channelId;
    }

    chatWs.send(JSON.stringify(msg));

    input.value = '';
    _autoResizeTextarea(input);
    input.focus();
    clearChatReply();
    if (input.id === 'fullscreen-chat-input') markFullscreenChatActivity();
    startSlowModeCooldown();
}

/**
 * Fallback: send a chat message via REST API when the WebSocket is down.
 * The message goes to global chat so the user isn't silenced during reconnects.
 */
async function _sendChatViaRest(text, input) {
    const token = localStorage.getItem('token');
    if (!token) {
        addSystemMessage('Chat disconnected — log in to send messages while reconnecting');
        return;
    }
    try {
        const autoDeleteMinutes = normalizeChatAutoDeleteMinutes(chatSettings.autoDeleteMinutes);
        const payload = { message: text, reply_to_id: _chatReplyTo?.id || undefined };
        if (autoDeleteMinutes >= (chatSelfDeletePolicy.minMinutes || CHAT_SELF_DELETE_MINUTES) && canUseViewerAutoDeleteHere()) {
            payload.auto_delete_minutes = autoDeleteMinutes;
        }

        const res = await fetch('/api/chat/send', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            addSystemMessage(err.error || 'Failed to send message');
            return;
        }
        // Clear input on success
        input.value = '';
        _autoResizeTextarea(input);
        input.focus();
        clearChatReply();
        if (chatStreamId) {
            addSystemMessage('Sent to global chat (stream chat reconnecting)');
        }
    } catch {
        addSystemMessage('Server unreachable — message not sent');
    }
}

/* ── Reply-to helpers ─────────────────────────────────────────── */

/**
 * Set the reply target — shows the reply bar above the chat input.
 */
function setChatReply(replyData) {
    _chatReplyTo = replyData;
    // Show/update reply bar on all chat input areas
    document.querySelectorAll('.chat-input-area').forEach(area => {
        let bar = area.querySelector('.chat-reply-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'chat-reply-bar';
            // Insert before the chat-input-row
            const inputRow = area.querySelector('.chat-input-row');
            if (inputRow) {
                area.insertBefore(bar, inputRow);
            } else {
                area.prepend(bar);
            }
        }
        bar.innerHTML = `<div class="chat-reply-bar-content"><i class="fa-solid fa-reply fa-flip-horizontal"></i> Replying to <strong>${esc(replyData.username)}</strong><span class="chat-reply-bar-snippet">${esc(replyData.message)}</span></div><button class="chat-reply-bar-close" onclick="clearChatReply()" title="Cancel reply"><i class="fa-solid fa-xmark"></i></button>`;
        bar.style.display = '';
    });
    // Focus the relevant input
    const chatEl = getChatEl();
    if (chatEl.input) chatEl.input.focus();
}

/**
 * Clear the reply target — hides the reply bar.
 */
function clearChatReply() {
    _chatReplyTo = null;
    document.querySelectorAll('.chat-reply-bar').forEach(bar => {
        bar.style.display = 'none';
    });
}

/**
 * Scroll to and highlight the message being replied to.
 */
function scrollToReplyTarget(headerEl) {
    const targetId = headerEl?.dataset?.replyTarget;
    if (!targetId) return;
    // Search all chat containers for the target message
    const targetMsg = document.querySelector(`.chat-msg[data-msg-id="${targetId}"]`);
    if (targetMsg) {
        targetMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetMsg.classList.add('chat-msg-reply-flash');
        setTimeout(() => targetMsg.classList.remove('chat-msg-reply-flash'), 1500);
    }
}

/**
 * Auto-resize a chat textarea to fit content, up to max lines.
 */
function _autoResizeTextarea(el) {
    if (!el || el.tagName !== 'TEXTAREA') return;
    el.style.height = 'auto';
    // Clamp to max-height set in CSS (~120px = 5 lines)
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    // Toggle overflow once content exceeds max
    el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden';
}

/**
 * Handle keydown for chat textareas:
 *  - Enter (no shift) = send
 *  - Shift+Enter = newline (up to max lines)
 *  - ArrowUp/Down = message history
 */
function _chatTextareaKeydown(e) {
    const el = e.target;
    const isFcw = el.id === 'fcw-chat-input';
    const isFullscreen = el.id === 'fullscreen-chat-input';

    if (e.key === 'Enter' && !e.shiftKey) {
        // Let autocomplete handle Enter when its menu is open
        if (typeof acIsActive === 'function' && acIsActive()) return;
        e.preventDefault();
        if (isFcw) fcwSendChat();
        else if (isFullscreen) sendChat(el);
        else sendChat();
        return;
    }

    // Escape: clear reply
    if (e.key === 'Escape' && _chatReplyTo) {
        clearChatReply();
        e.preventDefault();
        return;
    }

    // Shift+Enter: allow newline but enforce line limit
    if (e.key === 'Enter' && e.shiftKey) {
        const lines = (el.value.substring(0, el.selectionStart).match(/\n/g) || []).length + 1;
        if (lines >= CHAT_TEXTAREA_MAX_LINES) {
            e.preventDefault();
            return;
        }
        // Let the newline insert, then resize
        requestAnimationFrame(() => _autoResizeTextarea(el));
        return;
    }

    // Arrow Up — recall older messages
    if (e.key === 'ArrowUp' && el.selectionStart === 0 && !e.shiftKey) {
        if (_chatMsgHistory.length === 0) return;
        if (_chatHistoryIndex === -1) _chatHistoryDraft = el.value;
        if (_chatHistoryIndex < _chatMsgHistory.length - 1) {
            _chatHistoryIndex++;
            el.value = _chatMsgHistory[_chatHistoryIndex];
            _autoResizeTextarea(el);
            requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = el.value.length; });
            e.preventDefault();
        }
        return;
    }

    // Arrow Down — recall newer messages
    if (e.key === 'ArrowDown' && el.selectionEnd === el.value.length && !e.shiftKey) {
        if (_chatHistoryIndex > 0) {
            _chatHistoryIndex--;
            el.value = _chatMsgHistory[_chatHistoryIndex];
            _autoResizeTextarea(el);
            requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = el.value.length; });
            e.preventDefault();
        } else if (_chatHistoryIndex === 0) {
            _chatHistoryIndex = -1;
            el.value = _chatHistoryDraft;
            _autoResizeTextarea(el);
            requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = el.value.length; });
            e.preventDefault();
        }
        return;
    }
}

// Attach handlers to all chat textareas (delegated for dynamic elements too)
document.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('chat-textarea')) _chatTextareaKeydown(e);
}, true);
let _autoResizeTimer = null;
document.addEventListener('input', (e) => {
    if (!e.target.classList.contains('chat-textarea')) return;
    const el = e.target;
    clearTimeout(_autoResizeTimer);
    _autoResizeTimer = setTimeout(() => _autoResizeTextarea(el), 40);
}, true);

/* ── History ──────────────────────────────────────────────────── */
// Cross-stream context populated from the history response.
let chatLiveSlots = [];   // [{managed_stream_id, slug, title, live_session_id}]
let chatChannel = null;   // broadcaster username (for building hop links)
let chatCurrentManagedId = null; // watched slot's managed_stream_id (fallback for badge keying)

// Fetch global/cross-feed history to merge into a stream/channel timeline — only when
// the viewer has "Show Global Chat" (or "Show All Streams") enabled.
async function _fetchGlobalHistoryForMerge() {
    if (!(chatSettings.showGlobalInStream || chatSettings.showAllStreamsInStream)) return [];
    try { const g = await api('/chat/global/history?limit=500'); return g.messages || []; }
    catch { return []; }
}

async function loadChatHistory(streamId) {
    if (!streamId) return; // Use loadGlobalChatHistory() for global
    try {
        const [data, globalMsgs] = await Promise.all([
            api(`/chat/${streamId}/history?limit=500`),
            _fetchGlobalHistoryForMerge(),
        ]);
        _renderChatHistoryData(data, globalMsgs);
    } catch { /* silent */ }
}

// Persistent per-streamer history by broadcaster user id — works offline + across
// slots (backed by channel_user_id). Used on channel pages.
async function loadChannelChatHistory(userId) {
    if (!userId) return;
    try {
        const [data, globalMsgs] = await Promise.all([
            api(`/chat/channel/${userId}/history?limit=500`),
            _fetchGlobalHistoryForMerge(),
        ]);
        _renderChatHistoryData(data, globalMsgs);
    } catch { /* silent */ }
}

function _renderChatHistoryData(data, globalMsgs = []) {
    const msgs = data.messages || [];
    chatLiveSlots = data.liveSlots || [];
    chatCurrentManagedId = data.activeManagedId != null ? data.activeManagedId : chatCurrentManagedId;
    chatChannel = data.channel || null;
    renderChatStreamHops();
    // Clear any loading skeleton / stale messages before inserting history
    const { messages: container } = getChatEl();
    if (container) container.innerHTML = '';

    // Merge in global / cross-feed history when the viewer has it enabled — mirrors the
    // live global-feed filter so reloading/going-offline keeps global messages visible.
    const mainIds = new Set(msgs.map(m => m.id).filter(v => v != null));
    const curChan = (data.channel || '').toString().trim().toLowerCase();
    const cross = [];
    for (const g of (globalMsgs || [])) {
        if (!g) continue;
        if (g.id != null && mainIds.has(g.id)) continue;                                   // already in main history
        const hasStreamChannel = !!g.stream_channel;
        if (!chatSettings.showAllStreamsInStream && hasStreamChannel) continue;            // pure-global only when "all streams" off
        if (hasStreamChannel && curChan && String(g.stream_channel).trim().toLowerCase() === curChan) continue; // our own channel (already in main)
        cross.push(g);
    }

    // Interleave by timestamp so the reloaded timeline reads chronologically.
    const combined = msgs.map(m => ({ m, cf: false })).concat(cross.map(m => ({ m, cf: true })));
    const tOf = (x) => { const d = Date.parse(String(x.m.timestamp || '').replace(' ', 'T')); return isNaN(d) ? 0 : d; };
    combined.sort((a, b) => tOf(a) - tOf(b));

    for (const it of combined) {
        if (it.cf) { if (container) container.appendChild(_buildCrossfeedEl(it.m)); }
        else _renderHistoryMainMsg(it.m);
    }
}

// Render a single stream/channel history row (donation/goal events render richly).
function _renderHistoryMainMsg(m) {
    // Sound rows persist their rich payload in metadata — rebuild the fields
    // the live renderer expects (audio is never replayed from history).
    if ((m.message_type === 'channel-sound' || m.message_type === 'soundboard') && m.metadata) {
        let meta = null;
        try { meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata; } catch { meta = null; }
        if (meta && meta.sound && !m.sound) m.sound = meta.sound;
        if (meta && meta.soundboard && !m.soundboard) m.soundboard = meta.soundboard;
    }
    if (m.message_type === 'donation' && m.metadata) {
        let meta = null;
        try { meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata; } catch { meta = null; }
        if (meta && meta.kind === 'goal-reached') {
            addDonationGoalMessage({ goal: { title: meta.title, target_amount: meta.target, image_url: meta.image, media_type: meta.media_type }, by: meta.by });
            return;
        }
        if (meta && meta.kind === 'donation') {
            addDonationMessage({ username: meta.username, amount: meta.amount, message: meta.message, avatar_url: meta.avatar_url, user_id: meta.user_id });
            return;
        }
    }
    addChatMessage({
        id: m.id,
        username: m.username || m.display_name || `anon${m.user_id || ''}`,
        core_username: m.core_username || null,
        message: m.message,
        message_type: m.message_type,
        sound: m.sound,
        soundboard: m.soundboard,
        metadata: m.metadata,
        role: m.role || 'user',
        color: m.color,
        avatar_url: m.avatar_url,
        profile_color: m.profile_color,
        user_id: m.user_id,
        timestamp: m.timestamp,
        reply_to: m.reply_to || null,
        source_platform: m.source_platform || undefined,
        // Cosmetics (name/particle/hat effects + tag) so history matches live
        nameFX: m.nameFX || undefined,
        particleFX: m.particleFX || undefined,
        hatFX: m.hatFX || undefined,
        tag: m.tag || undefined,
        // Source-stream context (for the per-message origin/channel badge)
        stream_id: m.stream_id,
        source_stream_title: m.source_stream_title,
        source_managed_id: m.source_managed_id,
        source_is_live: m.source_is_live,
        source_slug: m.source_slug,
        source_channel: m.source_channel,
        stream_channel: m.stream_channel || m.source_channel || undefined,
    });
}

// Navigate to another of the streamer's live slots (from an origin badge or hop bar).
// True when the user is actively broadcasting via the browser here — navigating
// away (a stream hop) would tear down their live broadcast, so we disable hops.
function _chatHopWouldEndBroadcast() {
    try {
        if (typeof currentPage !== 'undefined' && currentPage === 'broadcast') return true;
        if (typeof broadcastState !== 'undefined' && broadcastState && broadcastState.streams) {
            for (const [, ss] of broadcastState.streams) { if (ss && ss.localStream) return true; }
        }
    } catch { /* */ }
    return false;
}

function hopToStreamSlot(el) {
    if (_chatHopWouldEndBroadcast()) {
        if (typeof toast === 'function') toast("You're live in this tab — stop your broadcast before switching streams", 'info');
        return;
    }
    const ch = el && el.dataset ? el.dataset.channel : '';
    const ref = el && el.dataset ? el.dataset.ref : '';
    if (!ch || typeof navigate !== 'function' || typeof channelPath !== 'function') return;
    navigate(channelPath(ch, ref || null));
}

// Render a "Also live:" hop bar above the chat when the streamer has other live slots.
function renderChatStreamHops() {
    const { messages } = getChatEl();
    if (!messages || !messages.parentNode) return;
    let bar = document.getElementById('chat-stream-hops');
    const others = (chatLiveSlots || []).filter(s => Number(s.live_session_id) !== Number(chatStreamId));
    // Hide the hop bar entirely while broadcasting here (hopping would end the stream).
    if (!chatChannel || others.length === 0 || _chatHopWouldEndBroadcast()) {
        if (bar) bar.remove();
        return;
    }
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'chat-stream-hops';
        bar.className = 'chat-stream-hops';
        messages.parentNode.insertBefore(bar, messages);
    }
    bar.innerHTML = `<span class="chat-stream-hops-label"><i class="fa-solid fa-tower-broadcast"></i> Also live:</span> ` +
        others.map(s => {
            const ref = s.slug || s.managed_stream_id;
            return `<button class="chat-stream-hop" data-channel="${esc(chatChannel)}" data-ref="${esc(String(ref))}" onclick="hopToStreamSlot(this)">${esc(s.title || 'Stream')}</button>`;
        }).join('');
}

async function loadGlobalChatHistory() {
    // No single-streamer context in global mode — clear any hop bar.
    chatLiveSlots = [];
    chatChannel = null;
    renderChatStreamHops();
    try {
        const data = await api('/chat/global/history?limit=500');
        const msgs = data.messages || [];
        // Clear any loading skeleton / stale messages before inserting history
        const { messages } = getChatEl();
        if (messages) messages.innerHTML = '';
        msgs.forEach(m => {
            if (m.message_type === 'system') {
                // Render system messages (update announcements, etc.) with system styling
                addRichSystemMessage(esc(m.message), 'update');
            } else if (m.message_type === 'donation') {
                // Donations carry their payload in metadata — render the rich card here
                // too, not a plain text line. Global history renders through addChatMessage
                // directly rather than _renderHistoryMainMsg, so it needs its own hook.
                let meta = null;
                try { meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata; } catch { meta = null; }
                if (meta && meta.kind === 'goal-reached') {
                    addDonationGoalMessage({ goal: { title: meta.title, target_amount: meta.target, image_url: meta.image, media_type: meta.media_type }, by: meta.by });
                } else if (meta && meta.kind === 'donation') {
                    addDonationMessage({ username: meta.username, amount: meta.amount, message: meta.message, avatar_url: meta.avatar_url, user_id: meta.user_id });
                } else {
                    addRichSystemMessage(esc(m.message), 'update');
                }
            } else {
                addChatMessage({
                    id: m.id,
                    username: m.username || m.display_name || `anon${m.user_id || ''}`,
                    core_username: m.core_username || null,
                    message: m.message,
                    role: m.role || 'user',
                    color: m.color,
                    avatar_url: m.avatar_url,
                    profile_color: m.profile_color,
                    user_id: m.user_id,
                    timestamp: m.timestamp,
                    stream_id: m.stream_id || null,
                    stream_channel: m.stream_channel || null,
                    source_stream_id: m.stream_id || null,
                    source_stream_title: m.source_stream_title || null,
                    source_slug: m.source_slug || null,
                    source_managed_id: m.source_managed_id || null,
                    source_is_live: m.source_is_live ? 1 : 0,
                    hatFX: m.hatFX || null,
                    nameFX: m.nameFX || null,
                    particleFX: m.particleFX || null,
                    reply_to: m.reply_to || null,
                });
            }
        });
    } catch { /* silent */ }
}

/* ═══════════════════════════════════════════════════════════════
   CONTEXT MENU
   ═══════════════════════════════════════════════════════════════ */

// Middle-click a chat username → open their channel (real users), or open the right-click
// context menu for relay / anon / system names that have no channel to visit.
(function _wireChatUsernameMiddleClick() {
    if (window._chatUsernameMiddleClickWired) return;
    window._chatUsernameMiddleClickWired = true;
    // Suppress the browser's middle-click autoscroll when starting on a username.
    document.addEventListener('mousedown', (e) => {
        if (e.button === 1 && e.target.closest && e.target.closest('.chat-user[data-username]')) e.preventDefault();
    });
    document.addEventListener('auxclick', (e) => {
        if (e.button !== 1) return; // middle button only
        const target = e.target.closest && e.target.closest('.chat-user[data-username]');
        if (!target) return;
        e.preventDefault();
        const username = target.dataset.username;
        if (!username) return;
        const msgEl = target.closest('.chat-msg');
        const sourcePlatform = msgEl?.dataset?.sourcePlatform || '';
        const isRelay = msgEl?.dataset?.isRelay === '1' || isRelayPlatform(sourcePlatform)
            || isRelayPlatform(parseRelayUsername(username || '').platform);
        const isAnon = target.dataset.anon === '1';
        // Relay / anon / system users have no channel page — show their context menu instead.
        if (isRelay || isAnon || isSystemUsername(username)) {
            // showChatContextMenu reads event.currentTarget; in this delegated listener that
            // would be `document`, so hand it a synthetic event anchored to the username span.
            showChatContextMenu({
                currentTarget: target, target: e.target,
                clientX: e.clientX, clientY: e.clientY,
                preventDefault() {}, stopPropagation() {},
            });
        } else {
            ctxViewChannel(target.dataset.coreUsername || username);
        }
    });
})();

function showChatContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    dismissContextMenu();

    const target = event.currentTarget || event.target.closest('[data-username]');
    if (!target) return;
    const username = target.dataset.username;
    const coreUsername = target.dataset.coreUsername || username;
    const userId = target.dataset.userId;
    const isAnon = target.dataset.anon === '1';
    if (!username) return;

    // Extract message data from parent .chat-msg for reply support
    const msgEl = target.closest('.chat-msg');
    const msgId = msgEl?.dataset?.msgId || null;
    const sourcePlatform = msgEl?.dataset?.sourcePlatform || '';
    // Fall back to source_platform AND the "[RS]/[Twitch]/…" username prefix so relay
    // users are recognised even when a message was forwarded to the global feed without
    // role/source_platform — otherwise they'd get the generic profile menu (Message/Channel)
    // instead of the relay menu with AI Insight.
    const isRelay = msgEl?.dataset?.isRelay === '1' || isRelayPlatform(sourcePlatform)
        || isRelayPlatform(parseRelayUsername(username || '').platform);

    const menu = document.createElement('div');
    menu.className = 'chat-context-menu';
    if (msgId) {
        menu.dataset.replyMsgId = msgId;
        menu.dataset.replyUsername = username;
        menu.dataset.replyUserId = userId || '';
        // Extract plain text of the message (everything after the username colon)
        const msgText = msgEl?.textContent?.split(username + ':')?.slice(1)?.join(':')?.trim() || '';
        menu.dataset.replyMessage = msgText.slice(0, 100);
    }
    // Store message and relay data for moderation actions
    menu.dataset.msgId = msgId || '';
    menu.dataset.isRelay = isRelay ? '1' : '';
    menu.dataset.sourcePlatform = sourcePlatform;
    menu.innerHTML = `
        <div class="ctx-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>
    `;

    // Position near the click
    document.body.appendChild(menu);
    positionContextMenu(menu, event.clientX, event.clientY);
    activeContextMenu = menu;

    // The official system account (changelog / server messages) is not a real user —
    // show a locked-down info menu: no AI/logs/moderation/ban, no profile fetch.
    if (isSystemUsername(username)) {
        renderSystemContextMenu(menu, username);
    } else if (isRelay) {
        renderRelayContextMenu(menu, username, sourcePlatform);
    } else {
        loadContextMenuProfile(menu, coreUsername, userId, isAnon);
    }
    // Arena yap level (accounts, anons and relayed chatters all have one once they've hit a subject).
    try {
        let yapKey = null;
        if (isRelay) { const m = String(username || '').match(/^\[([A-Za-z]+)\]\s+(.+)$/); const plat = String(sourcePlatform || (m && m[1]) || '').toLowerCase().replace(/^yt$/, 'youtube').replace(/^robotstreamer$/, 'rs'); if (m && plat) yapKey = `relay:${plat}:${m[2].trim().toLowerCase()}`; }
        else if (isAnon) { const m = String(coreUsername || username || '').match(/^anon(\d+)$/i); if (m) yapKey = `anon:${m[1]}`; }
        else if (userId) yapKey = `user:${userId}`;
        if (yapKey) _injectYapBlock(menu, yapKey);
    } catch { /* optional */ }

    // Clicks inside the menu shouldn't dismiss it (needed for rename submenu toggle etc.)
    menu.addEventListener('click', (e) => e.stopPropagation());

    // Click outside to dismiss
    setTimeout(() => {
        document.addEventListener('click', dismissContextMenu, { once: true });
    }, 10);
}

function positionContextMenu(menu, x, y) {
    // Initial position — invisible until we measure
    menu.style.visibility = 'hidden';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // ── Robust viewport-aware positioning ────────────────────
    // Runs after DOM paint so getBoundingClientRect has real dimensions.
    // Also handles profile card load (which changes menu height) via
    // a MutationObserver.
    const reposition = () => {
        const rect = menu.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pad = 8;

        let finalX = x;
        let finalY = y;

        // Horizontal: prefer right of cursor, flip left if needed
        if (finalX + rect.width > vw - pad) {
            finalX = Math.max(pad, x - rect.width);
        }
        if (finalX < pad) finalX = pad;

        // Vertical: prefer below cursor, flip above if needed
        if (finalY + rect.height > vh - pad) {
            finalY = Math.max(pad, y - rect.height);
        }
        if (finalY < pad) finalY = pad;

        // Last resort: if it still overflows, pin to edges and allow internal scroll
        if (rect.height > vh - pad * 2) {
            finalY = pad;
            menu.style.maxHeight = (vh - pad * 2) + 'px';
            menu.style.overflowY = 'auto';
        }

        menu.style.left = finalX + 'px';
        menu.style.top = finalY + 'px';
        menu.style.visibility = '';
    };

    requestAnimationFrame(reposition);

    // Re-position when content changes (profile card load, rename submenu toggle)
    const observer = new MutationObserver(() => requestAnimationFrame(reposition));
    observer.observe(menu, { childList: true, subtree: true, characterData: true });
    menu._repositionObserver = observer;

    // Re-position on window resize
    const onResize = () => {
        if (!menu.isConnected) {
            window.removeEventListener('resize', onResize);
            return;
        }
        reposition();
    };
    window.addEventListener('resize', onResize);
    menu._resizeHandler = onResize;
}

async function _injectYapBlock(menu, key) {
    try {
        const y = await api(`/arena/chatter/${encodeURIComponent(key)}`);
        if (!y || !menu.isConnected) return;
        const pct = y.xp_for_next ? Math.round((y.xp_into_level / y.xp_for_next) * 100) : 100;
        const card = y.card || {};
        const el = document.createElement('div');
        el.className = 'ctx-yap';
        el.innerHTML = `<a href="/arena/chatter/${encodeURIComponent(key)}" onclick="return handleLinkClick(event, '/arena/chatter/${encodeURIComponent(key)}')" class="ctx-yap-link"><span class="ctx-yap-lvl">YAP ${y.level}</span><span class="ctx-yap-title">${esc(card.title || y.title)}</span>${y.streak >= 2 ? `<span class="ctx-yap-streak">🔥 ${y.streak}</span>` : ''}</a><span class="ctx-yap-bar"><span style="width:${pct}%"></span></span><small>${y.xp} XP · ${y.moments} moments on ${y.subjects} subject${y.subjects === 1 ? '' : 's'}${card.catchphrase ? ` · “${esc(String(card.catchphrase).slice(0, 60))}”` : ''}</small>`;
        const actions = menu.querySelector('.ctx-actions');
        if (actions) actions.parentNode.insertBefore(el, actions); else menu.appendChild(el);
    } catch { /* no profile yet */ }
}

function dismissContextMenu() {
    if (activeContextMenu) {
        // Clean up observers
        if (activeContextMenu._repositionObserver) activeContextMenu._repositionObserver.disconnect();
        if (activeContextMenu._resizeHandler) window.removeEventListener('resize', activeContextMenu._resizeHandler);
        activeContextMenu.remove();
        activeContextMenu = null;
    }
}

async function loadContextMenuProfile(menu, username, userId, isAnon) {
    if (isAnon) {
        renderAnonContextMenu(menu, username, userId);
        return;
    }
    try {
        const profile = await api(`/chat/user/${encodeURIComponent(username)}/profile`);
        renderContextMenu(menu, profile, username);
    } catch {
        menu.innerHTML = `
            <div class="ctx-header">
                <span class="ctx-avatar-letter">${esc(username)[0].toUpperCase()}</span>
                <div class="ctx-info">
                    <span class="ctx-name">${esc(username)}</span>
                </div>
            </div>
            <div class="ctx-actions">
                <button class="ctx-btn" data-username="${esc(username)}" onclick="ctxWhisper(this.dataset.username)"><i class="fa-solid fa-comment"></i> Message</button>
                <button class="ctx-btn" data-username="${esc(username)}" onclick="ctxViewChannel(this.dataset.username)"><i class="fa-solid fa-user"></i> Channel</button>
            </div>
        `;
    }
}

// Reserved usernames that represent the site itself (system/changelog messages), not a
// real user. They get a locked-down context menu and can't be registered by anyone.
const SYSTEM_USERNAMES = new Set(['live']);
function isSystemUsername(name) { return SYSTEM_USERNAMES.has(String(name || '').trim().toLowerCase()); }

function renderSystemContextMenu(menu, username) {
    // Markup lives in chat-shared.js (OpenVibeChat.buildUserMenu) — shared with the /kiosk page.
    menu.innerHTML = OpenVibeChat.buildUserMenu({ kind: 'system', username });
}

function renderAnonContextMenu(menu, username, userId) {
    // Markup lives in chat-shared.js (OpenVibeChat.buildUserMenu) — shared with the /kiosk page.
    menu.innerHTML = OpenVibeChat.buildUserMenu({
        kind: 'anon', username, userId,
        msgId: menu.dataset.msgId, replyMsgId: menu.dataset.replyMsgId,
        ctx: { currentUser, chatStreamId, currentStreamData, canMod: canModerateCurrentStream() },
    });

    // Async: first-seen (when their anon number was assigned) + first-chat time + count.
    (async () => {
        try {
            const d = await api(`/chat/anon/${encodeURIComponent(username)}`);
            const el = menu.querySelector('.ctx-anon-meta');
            if (!el) return;
            const a = d && d.anon;
            if (a && (a.first_seen || a.first_chat)) {
                const mc = a.message_count || 0;
                const seen = a.first_seen ? `First seen ${timeAgoShort(a.first_seen)}` : '';
                const chat = a.first_chat ? `First chat ${timeAgoShort(a.first_chat)}` : '';
                const parts = [seen, chat].filter(Boolean).join(' &middot; ');
                el.innerHTML = `<i class="fa-solid fa-clock"></i> ${parts} &middot; ${formatNumber(mc)} msg${mc === 1 ? '' : 's'}`;
            } else {
                el.remove();
            }
        } catch { menu.querySelector('.ctx-anon-meta')?.remove(); }
    })();
}

function renderContextMenu(menu, profile, username) {
    // Markup lives in chat-shared.js (OpenVibeChat.buildUserMenu) — shared with the /kiosk page.
    menu.innerHTML = OpenVibeChat.buildUserMenu({
        kind: 'user', profile, username,
        msgId: menu.dataset.msgId, replyMsgId: menu.dataset.replyMsgId,
        ctx: { currentUser, chatStreamId, currentStreamData, canMod: canModerateCurrentStream() },
        deps: { timeAgoShort, formatNumber },
    });
}

/* ── Context menu actions ─────────────────────────────────────── */
function ctxReply() {
    const menu = activeContextMenu;
    if (!menu?.dataset?.replyMsgId) return;
    setChatReply({
        id: parseInt(menu.dataset.replyMsgId),
        username: menu.dataset.replyUsername,
        user_id: menu.dataset.replyUserId ? parseInt(menu.dataset.replyUserId) : null,
        message: menu.dataset.replyMessage || '',
    });
    dismissContextMenu();
}

function ctxWhisper(username) {
    dismissContextMenu();
    // Route to the DM messenger widget instead of the old whisper command
    if (typeof window.openMessengerDm === 'function') {
        window.openMessengerDm(username);
    } else {
        toast('Messenger not available', 'error');
    }
}

async function ctxCallUser(username, userId) {
    dismissContextMenu();
    if (!currentUser) {
        toast('Log in to call users', 'error');
        return;
    }
    try {
        const data = await api('/streams/voice-channels/call-user', {
            method: 'POST',
            body: { user_id: Number(userId) || null, username },
        });
        if (!data?.channel?.id) throw new Error('Call channel not available');
        await _joinVoiceChannelFromInvite(data.channel.id, data.channel.name || 'Voice Channel', false);
        _showOutgoingVcCallOverlay(username, userId, data.channel.id, data.channel.name || 'Voice Channel');
        toast(`Calling ${username}...`, 'success');
    } catch (err) {
        _dismissOutgoingVcCallOverlay();
        toast(err.message || 'Failed to place call', 'error');
    }
}

async function _joinVoiceChannelFromInvite(channelId, channelName, switchToChat = false) {
    if (!channelId) return;

    if (switchToChat && typeof showPage === 'function') {
        showPage('chat');
    }

    if (typeof vcFetchChannels !== 'function' || typeof vcJoinChannel !== 'function' || typeof vcState === 'undefined') {
        window._pendingVcInvite = { channelId, channelName, at: Date.now() };
        toast(`Invite received for ${channelName || 'Voice Channel'}. Open Chat to join.`, 'info');
        return;
    }

    await vcFetchChannels();
    const ch = (vcState.channels || []).find(c => c.id === channelId);
    if (!ch) {
        toast('That call channel is no longer available', 'error');
        return;
    }
    if (typeof callState !== 'undefined' && callState.joined && callState.channelId === ch.id) {
        return;
    }
    await vcJoinChannel(ch);
}

async function acceptVcInvite(channelId, channelName) {
    try {
        _dismissIncomingVcCallOverlay();
        await _joinVoiceChannelFromInvite(channelId, channelName || 'Voice Channel', true);
    } catch (err) {
        toast(err.message || 'Failed to join call invite', 'error');
    }
}

function ctxViewChannel(username) {
    dismissContextMenu();
    // Channel pages live at /@username (the router requires the @ prefix).
    navigate(typeof channelPath === 'function' ? channelPath(username) : `/@${username}`);
}

function ctxViewLogs(username, userId) {
    dismissContextMenu();
    openChatLogsModal(username, userId);
}

// Chat logs for a bridged external (relay) chatter — keyed by platform + username.
function ctxViewRelayLogs(platform, username) {
    dismissContextMenu();
    openChatLogsModal(username, null, { platform, username });
}

// Chat logs for an anonymous chatter — keyed by their anon_id.
function ctxViewAnonLogs(anonId) {
    dismissContextMenu();
    openChatLogsModal(anonId, null, { anon: anonId });
}

async function ctxRenameUsername(username, userId) {
    dismissContextMenu();
    const newUsername = prompt(`Rename username for @${username}:`, username);
    if (newUsername == null || !newUsername.trim()) return;
    try {
        await api(`/admin/users/${userId}`, { method: 'PUT', body: { username: newUsername.trim() } });
        toast(`Username changed: @${username} → @${newUsername.trim()}`, 'success');
    } catch (err) {
        toast('Failed to rename username: ' + (err.message || 'unknown error'), 'error');
    }
}

async function ctxRenameDisplayName(username, userId, currentDisplay) {
    dismissContextMenu();
    const newName = prompt(`Rename display name for @${username}:`, currentDisplay || username);
    if (newName == null || !newName.trim()) return;
    try {
        await api(`/admin/users/${userId}`, { method: 'PUT', body: { display_name: newName.trim() } });
        toast(`Display name changed: @${username} → ${newName.trim()}`, 'success');
    } catch (err) {
        toast('Failed to rename display name: ' + (err.message || 'unknown error'), 'error');
    }
}

/**
 * Can the current user moderate the chat stream they're viewing?
 * Checks global mod capability OR stream ownership.
 */
function canModerateCurrentStream() {
    if (!currentUser) return false;
    if (currentUser.capabilities?.moderate_global) return true;
    // Stream owner can moderate their own stream
    if (currentStreamData && currentStreamData.user_id === currentUser.id) return true;
    // Channel owner viewing their own channel while OFFLINE (no live stream data) —
    // so the streamer can still manage emotes/sounds/settings from the [+] modal.
    try { if (typeof _activeChannelUserId !== 'undefined' && _activeChannelUserId && _activeChannelUserId === currentUser.id) return true; } catch { /* */ }
    // Channel mods — if the server told us we can moderate, the chatStreamId will match
    // For now, channel mods use /ban command in chat. Context menu covers global mods + owners.
    return false;
}

function ctxStreamBan(username, userId, anonId) {
    dismissContextMenu();
    if (!chatStreamId) return toast('Not in a stream chat', 'error');
    if (!confirm(`Ban ${username} from this stream?`)) return;
    const body = { stream_id: chatStreamId, reason: 'Banned via chat' };
    if (userId) body.user_id = userId;
    if (anonId) body.anon_id = anonId;
    api('/mod/stream-ban', { method: 'POST', body })
        .then(() => toast(`${username} banned from stream`, 'success'))
        .catch(e => toast(e.message || 'Ban failed', 'error'));
}

function ctxGlobalBan(username, userId) {
    dismissContextMenu();
    // Prefer staff console ban UI if available (has reason/duration prompt + audit logging)
    if (typeof staffBanUser === 'function') {
        staffBanUser(userId, username, 'Banned via chat', 0);
        return;
    }
    if (!confirm(`⚠️ GLOBAL BAN: Ban ${username} from the entire site? This also IP-bans them.`)) return;
    api('/mod/global-ban', { method: 'POST', body: { user_id: userId, reason: 'Banned via chat' } })
        .then(() => toast(`${username} globally banned`, 'success'))
        .catch(e => toast(e.message || 'Ban failed', 'error'));
}

function ctxGlobalBanAnon(anonName) {
    dismissContextMenu();
    if (!confirm(`⚠️ GLOBAL BAN: Ban ${anonName} from the entire site? This will IP-ban them and all associated accounts.`)) return;
    // Look up anon IP first, then ban-all on that IP
    api(`/mod/ip/anon/${encodeURIComponent(anonName)}`)
        .then(data => {
            if (!data.current_ip) {
                toast('Could not determine IP for this anonymous user.', 'error');
                return;
            }
            return api('/mod/ip/ban-all', { method: 'POST', body: { ip: data.current_ip, reason: `Banned via chat (${anonName})` } });
        })
        .then(result => {
            if (result) toast(`${anonName} IP-banned (${result.banned_user_ids?.length || 0} associated accounts also banned)`, 'success');
        })
        .catch(e => toast(e.message || 'Ban failed', 'error'));
}

/* ── Message deletion actions ─────────────────────────────────── */

// ── Optimistic DOM removal ───────────────────────────────────
// Delete/ban actions relied solely on the server's WS broadcast to remove
// messages from the DOM, which doesn't reliably round-trip to the acting
// moderator's own chat connection — so their view didn't update until refresh.
// These helpers remove matching messages locally the moment the API confirms.
function _fadeRemoveMsg(el) {
    el.classList.add('chat-msg-deleted');
    setTimeout(() => el.remove(), 300);
}
function removeMessagesFromDom(ids) {
    if (!ids || !ids.length) return;
    const idSet = new Set(ids.map(String));
    document.querySelectorAll('.chat-msg[data-msg-id]').forEach(el => {
        if (idSet.has(el.dataset.msgId)) _fadeRemoveMsg(el);
    });
}
function removeUserMessagesFromDom({ username = null, userId = null } = {}) {
    if (!username && !userId) return;
    document.querySelectorAll('.chat-msg').forEach(el => {
        const nameEl = el.querySelector('[data-username]');
        if (!nameEl) return;
        if ((username && nameEl.dataset.username === username) ||
            (userId && nameEl.dataset.userId === String(userId))) {
            _fadeRemoveMsg(el);
        }
    });
}

function ctxDeleteMessage(msgId) {
    dismissContextMenu();
    if (!msgId) return;
    api('/mod/delete-message', { method: 'POST', body: { message_id: msgId, stream_id: chatStreamId || null } })
        .then(() => { removeMessagesFromDom([msgId]); toast('Message deleted', 'success'); })
        .catch(e => toast(e.message || 'Delete failed', 'error'));
}

function ctxDeleteAllUserMessages(userId) {
    dismissContextMenu();
    if (!userId) return;
    const scope = currentUser?.capabilities?.moderate_global ? 'globally' : 'from this stream';
    if (!confirm(`Delete ALL messages from this user ${scope}?`)) return;
    const body = { user_id: userId };
    if (chatStreamId) body.stream_id = chatStreamId;
    api('/mod/delete-user-messages', { method: 'POST', body })
        .then(r => { removeUserMessagesFromDom({ userId }); toast(`Deleted ${r.count || 0} message(s)`, 'success'); })
        .catch(e => toast(e.message || 'Delete failed', 'error'));
}

function ctxDeleteAllAnonMessages(anonId) {
    dismissContextMenu();
    if (!anonId) return;
    const scope = currentUser?.capabilities?.moderate_global ? 'globally' : 'from this stream';
    if (!confirm(`Delete ALL messages from ${anonId} ${scope}?`)) return;
    const body = { anon_id: anonId };
    if (chatStreamId) body.stream_id = chatStreamId;
    api('/mod/delete-user-messages', { method: 'POST', body })
        .then(r => { removeUserMessagesFromDom({ username: anonId }); toast(`Deleted ${r.count || 0} message(s)`, 'success'); })
        .catch(e => toast(e.message || 'Delete failed', 'error'));
}

function ctxDeleteRelayMessages(relayUsername) {
    dismissContextMenu();
    if (!relayUsername) return;
    const scope = currentUser?.capabilities?.moderate_global ? 'globally' : 'from this stream';
    if (!confirm(`Delete ALL messages from ${relayUsername} ${scope}?`)) return;
    const body = { relay_username: relayUsername };
    if (chatStreamId) body.stream_id = chatStreamId;
    api('/mod/delete-user-messages', { method: 'POST', body })
        .then(r => { removeUserMessagesFromDom({ username: relayUsername }); toast(`Deleted ${r.count || 0} message(s)`, 'success'); })
        .catch(e => toast(e.message || 'Delete failed', 'error'));
}

/* ── Relay user moderation ────────────────────────────────────── */

/**
 * Parse a relay username like "[Twitch] foobar" into { platform, externalUsername }.
 */
// A message is a relay (external-platform mirror) if it came from one of these
// source platforms. Live relay messages also carry role 'external', but
// history-loaded ones have a null user role, so source_platform is the reliable
// signal for BOTH cases.
function isRelayPlatform(p) {
    p = (p || '').toLowerCase();
    return p === 'rs' || p === 'twitch' || p === 'kick' || p === 'youtube';
}

function parseRelayUsername(prefixedUsername) {
    const match = prefixedUsername.match(/^\[(\w+)\]\s*(.+)$/);
    if (match) return { platform: match[1].toLowerCase(), externalUsername: match[2] };
    return { platform: '', externalUsername: prefixedUsername };
}

function ctxHideRelayUser(prefixedUsername) {
    dismissContextMenu();
    const { platform, externalUsername } = parseRelayUsername(prefixedUsername);
    if (!platform) return toast('Could not identify platform', 'error');
    if (!confirm(`Hide [${platform}] ${externalUsername} from this stream? Their messages will no longer appear.`)) return;
    api('/mod/relay-user/hide', {
        method: 'POST',
        body: {
            channel_id: currentStreamData?.channel_id || null,
            platform,
            external_username: externalUsername,
            action: 'hide',
            reason: 'Hidden via chat context menu',
        },
    })
        .then(() => toast(`[${platform}] ${externalUsername} hidden`, 'success'))
        .catch(e => toast(e.message || 'Hide failed', 'error'));
}

function ctxBanRelayUser(prefixedUsername) {
    dismissContextMenu();
    const { platform, externalUsername } = parseRelayUsername(prefixedUsername);
    if (!platform) return toast('Could not identify platform', 'error');
    if (!confirm(`⚠️ Ban [${platform}] ${externalUsername}? Their messages will be hidden and future messages blocked.`)) return;
    // Ban the relay user AND delete their messages
    const body = {
        channel_id: currentStreamData?.channel_id || null,
        platform,
        external_username: externalUsername,
        action: 'ban',
        reason: 'Banned via chat context menu',
    };
    api('/mod/relay-user/hide', { method: 'POST', body })
        .then(() => {
            // Also delete their existing messages
            const deleteBody = { relay_username: prefixedUsername };
            if (chatStreamId) deleteBody.stream_id = chatStreamId;
            return api('/mod/delete-user-messages', { method: 'POST', body: deleteBody });
        })
        .then(r => { removeUserMessagesFromDom({ username: prefixedUsername }); toast(`[${platform}] ${externalUsername} banned — ${r?.count || 0} message(s) deleted`, 'success'); })
        .catch(e => toast(e.message || 'Ban failed', 'error'));
}

function ctxUnbanRelayUser(prefixedUsername) {
    dismissContextMenu();
    const { platform, externalUsername } = parseRelayUsername(prefixedUsername);
    if (!platform) return toast('Could not identify platform', 'error');
    // Lifts a ban/hide for this exact relay identity only (never a registered account).
    const body = {
        channel_id: currentStreamData?.channel_id || null,
        platform,
        external_username: externalUsername,
        action: 'unban',
    };
    api('/mod/relay-user/hide', { method: 'POST', body })
        .then(() => toast(`[${platform}] ${externalUsername} unbanned — they can chat again`, 'success'))
        .catch(e => toast(e.message || 'Unban failed', 'error'));
}

/**
 * Render context menu for relayed external users (Twitch, Kick, YouTube, RS).
 */
function renderRelayContextMenu(menu, username, sourcePlatform) {
    const { platform, externalUsername } = parseRelayUsername(username);
    const displayPlatform = platform.charAt(0).toUpperCase() + platform.slice(1);
    // Markup lives in chat-shared.js (OpenVibeChat.buildUserMenu) — shared with the /kiosk page.
    menu.innerHTML = OpenVibeChat.buildUserMenu({
        kind: 'relay', username, platform, externalUsername, displayPlatform,
        msgId: menu.dataset.msgId, replyMsgId: menu.dataset.replyMsgId,
        ctx: { currentUser, chatStreamId, currentStreamData, canMod: canModerateCurrentStream() },
    });

    // Async: their first message time = "join date" (+ message count).
    (async () => {
        try {
            const d = await api(`/chat/relay-user/${encodeURIComponent(platform)}/${encodeURIComponent(externalUsername)}`);
            const el = menu.querySelector('.ctx-relay-joined');
            if (!el) return;
            if (d && d.relayUser && d.relayUser.first_seen) {
                const mc = d.relayUser.message_count || 0;
                el.innerHTML = `<i class="fa-solid fa-clock"></i> First seen ${timeAgoShort(d.relayUser.first_seen)} &middot; ${formatNumber(mc)} msg${mc === 1 ? '' : 's'}`;
            } else {
                el.remove();
            }
        } catch { menu.querySelector('.ctx-relay-joined')?.remove(); }
    })();
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN TOOLS PANEL
   ═══════════════════════════════════════════════════════════════ */

/**
 * Open the Admin Tools modal for a user or anon.
 * Shows: IP info, GeoIP, IP history, linked accounts (alts), ban controls.
 */
async function ctxAdminTools(username, userId, anonId) {
    dismissContextMenu();
    closeModal();

    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    if (!overlay || !content) return;

    const isAnon = !userId || userId === '';
    const displayName = username;

    content.innerHTML = `
        <div class="admin-tools-modal">
            <div class="admin-tools-header">
                <h3><i class="fa-solid fa-shield-halved"></i> Admin Tools — ${esc(displayName)}</h3>
                <button class="modal-close-btn" onclick="closeModal()"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="admin-tools-body">
                <div class="admin-tools-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading IP intelligence...</div>
            </div>
        </div>
    `;
    overlay.classList.add('show');

    try {
        let data;
        if (isAnon) {
            data = await api(`/mod/ip/anon/${encodeURIComponent(anonId || username)}`);
            renderAdminToolsAnon(content.querySelector('.admin-tools-body'), data, username);
        } else {
            data = await api(`/mod/ip/user/${encodeURIComponent(userId)}`);
            renderAdminToolsUser(content.querySelector('.admin-tools-body'), data, username);
        }
    } catch (err) {
        content.querySelector('.admin-tools-body').innerHTML = `
            <div class="admin-tools-error"><i class="fa-solid fa-triangle-exclamation"></i> Failed to load: ${esc(err.message)}</div>
        `;
    }
}

function renderAdminToolsUser(container, data, username) {
    const { user, ips, linked_accounts, live_ip } = data;

    // Current IP section
    const currentIp = live_ip || (ips.length ? ips[0].ip_address : 'Unknown');
    const currentGeo = ips.length ? ips[0] : {};

    let html = `
        <div class="at-section">
            <h4><i class="fa-solid fa-user"></i> User Info</h4>
            <div class="at-info-grid">
                <span class="at-label">Username</span><span class="at-value">@${esc(user.username)}</span>
                <span class="at-label">Display Name</span><span class="at-value">${esc(user.display_name || user.username)}</span>
                <span class="at-label">Role</span><span class="at-value at-role-${esc(user.role)}">${esc(user.role)}</span>
                <span class="at-label">Joined</span><span class="at-value">${user.created_at ? new Date(user.created_at).toLocaleDateString() : '?'}</span>
                <span class="at-label">Status</span><span class="at-value ${user.is_banned ? 'at-banned' : 'at-active'}">${user.is_banned ? '⛔ BANNED' : '✅ Active'}${user.ban_reason ? ' — ' + esc(user.ban_reason) : ''}</span>
            </div>
        </div>

        <div class="at-section">
            <h4><i class="fa-solid fa-globe"></i> Current IP</h4>
            <div class="at-ip-card at-ip-current">
                <span class="at-ip-address" title="Click to copy" onclick="navigator.clipboard.writeText('${esc(currentIp)}');toast('IP copied','success')">${esc(currentIp)}</span>
                ${live_ip ? '<span class="at-live-badge">● LIVE</span>' : ''}
                ${formatGeoLine(currentGeo)}
            </div>
        </div>
    `;

    // IP History
    if (ips.length) {
        html += `
            <div class="at-section">
                <h4><i class="fa-solid fa-clock-rotate-left"></i> IP History (${ips.length})</h4>
                <div class="at-ip-list">
                    ${ips.map(ip => `
                        <div class="at-ip-card">
                            <div class="at-ip-row">
                                <span class="at-ip-address" title="Click to copy" onclick="navigator.clipboard.writeText('${esc(ip.ip_address)}');toast('IP copied','success')">${esc(ip.ip_address)}</span>
                                <span class="at-ip-hits">${ip.hit_count} hits</span>
                            </div>
                            ${formatGeoLine(ip)}
                            <div class="at-ip-times">
                                <span>First: ${timeAgoShort(ip.first_seen)}</span>
                                <span>Last: ${timeAgoShort(ip.last_seen)}</span>
                                <span>Actions: ${esc(ip.actions || '')}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // Linked accounts (alts)
    if (linked_accounts && linked_accounts.length) {
        html += `
            <div class="at-section">
                <h4><i class="fa-solid fa-users"></i> Linked Accounts — Alt Detection (${linked_accounts.length})</h4>
                <div class="at-alts-list">
                    ${linked_accounts.map(alt => `
                        <div class="at-alt-card ${alt.is_banned ? 'at-alt-banned' : ''}">
                            <div class="at-alt-row">
                                <span class="at-alt-name" onclick="ctxAdminTools('${esc(alt.username)}', '${alt.id}')" title="Open admin tools for this user">@${esc(alt.username)}</span>
                                <span class="at-alt-role at-role-${esc(alt.role)}">${esc(alt.role)}</span>
                                ${alt.is_banned ? '<span class="at-banned-badge">BANNED</span>' : ''}
                            </div>
                            <div class="at-alt-detail">
                                <span>${alt.shared_ip_count} shared IP${alt.shared_ip_count > 1 ? 's' : ''}</span>
                                <span>Last shared: ${timeAgoShort(alt.last_shared_activity)}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    } else {
        html += `
            <div class="at-section">
                <h4><i class="fa-solid fa-users"></i> Linked Accounts</h4>
                <div class="at-empty">No linked accounts found (no shared IPs)</div>
            </div>
        `;
    }

    // Quick actions
    html += `
        <div class="at-section at-actions">
            <h4><i class="fa-solid fa-bolt"></i> Quick Actions</h4>
            <div class="at-action-grid">
                ${currentIp !== 'Unknown' ? `<button class="btn btn-sm at-action-btn" onclick="adminToolsIpBanAll('${esc(currentIp)}', '${esc(username)}')"><i class="fa-solid fa-ban"></i> Ban IP + All Accounts</button>` : ''}
                <button class="btn btn-sm at-action-btn" onclick="ctxViewLogs('${esc(username)}', '${data.user.id}');closeModal()"><i class="fa-solid fa-clock-rotate-left"></i> View Chat Logs</button>
            </div>
        </div>

        <div class="at-section" id="at-tts-voice" data-kind="user" data-id="${esc(user.username)}">
            <h4><i class="fa-solid fa-microphone-lines"></i> TTS Voice</h4>
            <div class="at-tts-body"><div class="admin-tools-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading voice…</div></div>
        </div>
    `;

    container.innerHTML = html;
    loadAdminTtsVoice('user', user.username, container.querySelector('#at-tts-voice .at-tts-body'));
}

function renderAdminToolsAnon(container, data, username) {
    const { anon_id, current_ip, geo, linked_accounts } = data;

    let html = `
        <div class="at-section">
            <h4><i class="fa-solid fa-ghost"></i> Anonymous User</h4>
            <div class="at-info-grid">
                <span class="at-label">Anon ID</span><span class="at-value">${esc(anon_id)}</span>
            </div>
        </div>

        <div class="at-section">
            <h4><i class="fa-solid fa-globe"></i> IP Address</h4>
            <div class="at-ip-card at-ip-current">
                <span class="at-ip-address" title="Click to copy" onclick="navigator.clipboard.writeText('${esc(current_ip || 'unknown')}');toast('IP copied','success')">${esc(current_ip || 'Unknown')}</span>
                ${geo ? formatGeoFromObj(geo) : '<span class="at-geo">No geo data</span>'}
            </div>
        </div>
    `;

    // Linked accounts
    if (linked_accounts && linked_accounts.length) {
        html += `
            <div class="at-section">
                <h4><i class="fa-solid fa-users"></i> Linked Accounts — Alt Detection (${linked_accounts.length})</h4>
                <div class="at-alts-list">
                    ${linked_accounts.map(alt => `
                        <div class="at-alt-card ${alt.is_banned ? 'at-alt-banned' : ''}">
                            <div class="at-alt-row">
                                <span class="at-alt-name" onclick="ctxAdminTools('${esc(alt.username || 'anon')}', '${alt.id || ''}')" title="Open admin tools">${alt.username ? '@' + esc(alt.username) : 'Anonymous'}</span>
                                ${alt.role ? `<span class="at-alt-role at-role-${esc(alt.role)}">${esc(alt.role)}</span>` : ''}
                                ${alt.is_banned ? '<span class="at-banned-badge">BANNED</span>' : ''}
                            </div>
                            <div class="at-alt-detail">
                                <span>${alt.shared_ip_count} shared IP${alt.shared_ip_count > 1 ? 's' : ''}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // Quick actions
    if (current_ip) {
        html += `
            <div class="at-section at-actions">
                <h4><i class="fa-solid fa-bolt"></i> Quick Actions</h4>
                <div class="at-action-grid">
                    <button class="btn btn-sm at-action-btn" onclick="adminToolsIpBanAll('${esc(current_ip)}', '${esc(username)}')"><i class="fa-solid fa-ban"></i> Ban IP + All Accounts</button>
                </div>
            </div>
        `;
    }

    html += `
        <div class="at-section" id="at-tts-voice" data-kind="anon" data-id="${esc(anon_id || username)}">
            <h4><i class="fa-solid fa-microphone-lines"></i> TTS Voice</h4>
            <div class="at-tts-body"><div class="admin-tools-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading voice…</div></div>
        </div>`;

    container.innerHTML = html;
    loadAdminTtsVoice('anon', anon_id || username, container.querySelector('#at-tts-voice .at-tts-body'));
}

/* ── Admin: per-user TTS voice editor ─────────────────────────── */
async function loadAdminTtsVoice(kind, id, bodyEl) {
    if (!bodyEl) return;
    try {
        const d = await api(`/mod/tts-voice/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
        renderAdminTtsVoice(bodyEl, kind, id, d);
    } catch (err) {
        bodyEl.innerHTML = `<div class="admin-tools-error"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(err.message || 'Failed to load voice')}</div>`;
    }
}

function renderAdminTtsVoice(bodyEl, kind, id, d) {
    const p = d.params || {};
    const [pLo, pHi] = (d.bounds?.pitch) || [0, 99];
    const [sLo, sHi] = (d.bounds?.speed) || [80, 450];
    const voiceOpts = (d.voices || ['en']).map(v => `<option value="${esc(v)}"${v === p.voice ? ' selected' : ''}>${esc(v)}</option>`).join('');
    // If the current voice isn't in the base list (e.g. a preset like en+f3), add it so it shows.
    const extraVoice = (d.voices || []).includes(p.voice) ? '' : `<option value="${esc(p.voice)}" selected>${esc(p.voice)} (preset)</option>`;
    const presets = (d.presets || []).map(pr =>
        `<button type="button" class="btn btn-sm at-voice-preset" data-params='${esc(JSON.stringify(pr.params))}'>${esc(pr.label)}</button>`).join('');
    bodyEl.innerHTML = `
        <p class="at-tts-status">${d.isOverride ? '<i class="fa-solid fa-user-pen"></i> Custom (admin-set) voice' : '<i class="fa-solid fa-dice"></i> Auto-assigned voice'}</p>
        <div class="at-voice-presets">${presets}</div>
        <div class="at-voice-grid">
            <label>Voice <select class="at-voice-field" id="atv-voice">${extraVoice}${voiceOpts}</select></label>
            <label>Pitch <span class="at-voice-num" id="atv-pitch-n">${p.pitch}</span>
                <input type="range" class="at-voice-field" id="atv-pitch" min="${pLo}" max="${pHi}" value="${p.pitch}"></label>
            <label>Speed <span class="at-voice-num" id="atv-speed-n">${p.speed}</span> wpm
                <input type="range" class="at-voice-field" id="atv-speed" min="${sLo}" max="${sHi}" value="${p.speed}"></label>
        </div>
        <div class="at-voice-actions">
            <button type="button" class="btn btn-sm" id="atv-preview"><i class="fa-solid fa-play"></i> Preview</button>
            <button type="button" class="btn btn-sm" id="atv-reroll"><i class="fa-solid fa-dice"></i> Re-roll</button>
            <button type="button" class="btn btn-sm" id="atv-reset"><i class="fa-solid fa-rotate-left"></i> Reset to auto</button>
            <button type="button" class="btn btn-sm btn-primary" id="atv-save"><i class="fa-solid fa-floppy-disk"></i> Save</button>
        </div>`;

    const $ = (s) => bodyEl.querySelector(s);
    const getParams = () => ({ voice: $('#atv-voice').value, pitch: +$('#atv-pitch').value, speed: +$('#atv-speed').value });
    $('#atv-pitch').addEventListener('input', () => { $('#atv-pitch-n').textContent = $('#atv-pitch').value; });
    $('#atv-speed').addEventListener('input', () => { $('#atv-speed-n').textContent = $('#atv-speed').value; });
    bodyEl.querySelectorAll('.at-voice-preset').forEach(b => b.addEventListener('click', () => {
        const pr = JSON.parse(b.dataset.params);
        // Ensure the preset voice exists as an option, then select it.
        const sel = $('#atv-voice');
        if (![...sel.options].some(o => o.value === pr.voice)) sel.add(new Option(pr.voice + ' (preset)', pr.voice));
        sel.value = pr.voice;
        if (pr.pitch != null) { $('#atv-pitch').value = pr.pitch; $('#atv-pitch-n').textContent = pr.pitch; }
        if (pr.speed != null) { $('#atv-speed').value = pr.speed; $('#atv-speed-n').textContent = pr.speed; }
    }));
    $('#atv-preview').addEventListener('click', async () => {
        const btn = $('#atv-preview'); btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Playing…';
        try {
            const r = await api('/mod/tts-voice/preview', { method: 'POST', body: getParams() });
            if (r.url || r.audio) { const a = new Audio(r.url || `data:${r.mimeType};base64,${r.audio}`); await a.play().catch(() => {}); }
        } catch (e) { toast(e.message || 'Preview failed', 'error'); }
        btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play"></i> Preview';
    });
    $('#atv-reroll').addEventListener('click', async () => {
        try { const r = await api(`/mod/tts-voice/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: 'PUT', body: { reroll: true } });
            renderAdminTtsVoice(bodyEl, kind, id, { ...d, isOverride: true, params: r.params }); toast('Re-rolled voice', 'success'); }
        catch (e) { toast(e.message || 'Failed', 'error'); }
    });
    $('#atv-reset').addEventListener('click', async () => {
        try { const r = await api(`/mod/tts-voice/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: 'PUT', body: { reset: true } });
            renderAdminTtsVoice(bodyEl, kind, id, { ...d, isOverride: false, params: r.params }); toast('Reset to auto-assigned voice', 'success'); }
        catch (e) { toast(e.message || 'Failed', 'error'); }
    });
    $('#atv-save').addEventListener('click', async () => {
        try { const r = await api(`/mod/tts-voice/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: 'PUT', body: getParams() });
            renderAdminTtsVoice(bodyEl, kind, id, { ...d, isOverride: true, params: r.params }); toast('Voice saved', 'success'); }
        catch (e) { toast(e.message || 'Failed to save', 'error'); }
    });
}

function formatGeoLine(ip) {
    const parts = [];
    if (ip.geo_city) parts.push(ip.geo_city);
    if (ip.geo_region) parts.push(ip.geo_region);
    if (ip.geo_country) parts.push(ip.geo_country);
    if (!parts.length) return '';
    return `<span class="at-geo"><i class="fa-solid fa-location-dot"></i> ${esc(parts.join(', '))}${ip.geo_isp ? ' — ' + esc(ip.geo_isp) : ''}</span>`;
}

function formatGeoFromObj(geo) {
    const parts = [];
    if (geo.city) parts.push(geo.city);
    if (geo.region) parts.push(geo.region);
    if (geo.country) parts.push(geo.country);
    if (!parts.length) return '<span class="at-geo">No geo data</span>';
    return `<span class="at-geo"><i class="fa-solid fa-location-dot"></i> ${esc(parts.join(', '))}${geo.isp ? ' — ' + esc(geo.isp) : ''}</span>`;
}

async function adminToolsIpBanAll(ip, username) {
    if (!confirm(`⚠️ IP BAN: Ban ${ip} and ALL associated accounts?\n\nThis will:\n- IP-ban this address\n- Global-ban every account that has ever used this IP\n- Return 404 for all pages from this IP\n\nThis action cannot be easily undone.`)) return;
    try {
        const result = await api('/mod/ip/ban-all', { method: 'POST', body: { ip, reason: `IP ban via Admin Tools (user: ${username})` } });
        toast(`IP banned: ${ip} — ${result.banned_user_ids?.length || 0} account(s) banned`, 'success');
        // Refresh the admin tools panel if still open
        const body = document.querySelector('.admin-tools-body');
        if (body) {
            body.innerHTML = '<div class="admin-tools-loading"><i class="fa-solid fa-check" style="color:var(--success)"></i> Ban applied. Close and reopen to refresh.</div>';
        }
    } catch (e) {
        toast(e.message || 'Ban failed', 'error');
    }
}

/* ═══════════════════════════════════════════════════════════════
   CHAT LOGS MODAL
   ═══════════════════════════════════════════════════════════════ */

function openChatLogsModal(username, userId, relay) {
    // Close existing modal overlay if open
    closeModal();

    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    if (!overlay || !content) return;

    content.innerHTML = `
        <div class="chat-logs-modal">
            <div class="chat-logs-header">
                <h3><i class="fa-solid fa-clock-rotate-left"></i> Chat Logs${username ? ` — ${esc(username)}` : ''}</h3>
                <div class="chat-logs-search-row">
                    <input type="text" id="chat-logs-search" class="chat-logs-search" placeholder="Search messages..." onkeydown="if(event.key==='Enter')searchChatLogs()">
                    <button class="btn btn-sm" onclick="searchChatLogs()"><i class="fa-solid fa-search"></i></button>
                </div>
            </div>
            <div class="chat-logs-body" id="chat-logs-body">
                <div class="chat-logs-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>
            </div>
            <div class="chat-logs-footer" id="chat-logs-footer"></div>
        </div>
    `;

    overlay.classList.add('show');

    // Store context on the modal for pagination. The 3rd arg is an options object:
    // { platform, username } for relay logs, or { anon } for an anonymous chatter.
    content._logsCtx = {
        username, userId,
        relay: (relay && relay.platform) ? relay : null,
        anon: (relay && relay.anon) ? relay.anon : null,
        offset: 0, query: '',
    };

    loadChatLogs();
}

async function loadChatLogs() {
    const content = document.getElementById('modal-content');
    if (!content?._logsCtx) return;
    const ctx = content._logsCtx;
    const body = document.getElementById('chat-logs-body');
    const footer = document.getElementById('chat-logs-footer');
    if (!body) return;

    body.innerHTML = '<div class="chat-logs-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>';

    try {
        let url, result;
        if (ctx.anon) {
            // Anonymous chatter history — matched by anon_id.
            const params = new URLSearchParams({ limit: '50', offset: String(ctx.offset) });
            if (ctx.query) params.set('q', ctx.query);
            url = `/chat/anon/${encodeURIComponent(ctx.anon)}/logs?${params}`;
            result = await api(url);
        } else if (ctx.relay) {
            // Relay (external-platform) user history — matched by platform + username.
            const params = new URLSearchParams({ limit: '50', offset: String(ctx.offset) });
            if (ctx.query) params.set('q', ctx.query);
            url = `/chat/relay-user/${encodeURIComponent(ctx.relay.platform)}/${encodeURIComponent(ctx.relay.username)}/logs?${params}`;
            result = await api(url);
        } else if (ctx.userId && !ctx.query) {
            // User history mode
            url = `/chat/user/${ctx.userId}/history?limit=50&offset=${ctx.offset}`;
            result = await api(url);
        } else {
            // Search mode
            const params = new URLSearchParams({ limit: '50', offset: String(ctx.offset) });
            if (ctx.query) params.set('q', ctx.query);
            if (ctx.userId) params.set('user_id', String(ctx.userId));
            url = `/chat/search?${params}`;
            result = await api(url);
        }

        const msgs = result.messages || [];
        const total = result.total || 0;

        if (msgs.length === 0) {
            body.innerHTML = '<p class="muted" style="text-align:center;padding:20px">No messages found</p>';
        } else {
            body.innerHTML = msgs.map(m => {
                const ts = m.timestamp ? new Date(m.timestamp.replace(' ', 'T') + (m.timestamp.includes('Z') ? '' : 'Z')).toLocaleString() : '';
                const name = esc(m.display_name || m.username || 'anon');
                const stream = m.stream_title ? ` <span class="log-stream">${esc(m.stream_title)}</span>` : '';
                return `<div class="log-entry">
                    <span class="log-time">${ts}</span>${stream}
                    <span class="log-user" style="color:${esc(m.profile_color || '#999')}">${name}</span>:
                    <span class="log-text">${esc(m.message)}</span>
                </div>`;
            }).join('');
        }

        // Pagination
        const pages = Math.ceil(total / 50);
        const curPage = Math.floor(ctx.offset / 50) + 1;
        if (pages > 1 && footer) {
            footer.innerHTML = `
                <button class="btn btn-sm" ${ctx.offset <= 0 ? 'disabled' : ''} onclick="chatLogsPrev()"><i class="fa-solid fa-chevron-left"></i></button>
                <span class="log-page-info">Page ${curPage} of ${pages} (${total} msgs)</span>
                <button class="btn btn-sm" ${curPage >= pages ? 'disabled' : ''} onclick="chatLogsNext()"><i class="fa-solid fa-chevron-right"></i></button>
            `;
        } else if (footer) {
            footer.innerHTML = total > 0 ? `<span class="log-page-info">${total} messages</span>` : '';
        }
    } catch (err) {
        body.innerHTML = '<p class="muted" style="text-align:center;padding:20px">Failed to load logs</p>';
    }
}

function searchChatLogs() {
    const content = document.getElementById('modal-content');
    if (!content?._logsCtx) return;
    const input = document.getElementById('chat-logs-search');
    content._logsCtx.query = input?.value?.trim() || '';
    content._logsCtx.offset = 0;
    loadChatLogs();
}

function chatLogsPrev() {
    const content = document.getElementById('modal-content');
    if (!content?._logsCtx) return;
    content._logsCtx.offset = Math.max(0, content._logsCtx.offset - 50);
    loadChatLogs();
}

function chatLogsNext() {
    const content = document.getElementById('modal-content');
    if (!content?._logsCtx) return;
    content._logsCtx.offset += 50;
    loadChatLogs();
}

/* ── Helpers ──────────────────────────────────────────────────── */
// Role badges — icon-only chips with an animated hover tooltip (see .chat-badge CSS).
function getBadgeHTML(role) {
    switch (role) {
        // Network staff. Admin + Owner both read "Staff - Admin".
        case 'owner':
        case 'admin': return '<span class="chat-badge chat-badge-admin" data-tip="Staff - Admin"><i class="fa-solid fa-shield-halved"></i></span>';
        case 'global_mod': return '<span class="chat-badge chat-badge-mod" data-tip="Staff - Mod"><i class="fa-solid fa-shield"></i></span>';
        case 'streamer': return '<span class="chat-badge chat-badge-streamer" data-tip="Streamer"><i class="fa-solid fa-tower-broadcast"></i></span>';
        // Channel moderator (per-channel, not network staff).
        case 'mod':
        case 'moderator': return '<span class="chat-badge chat-badge-cmod" data-tip="Moderator"><i class="fa-solid fa-gavel"></i></span>';
        case 'subscriber': return '<span class="chat-badge chat-badge-sub" data-tip="Subscriber"><i class="fa-solid fa-star"></i></span>';
        default: return '';
    }
}

function getRoleColor(role) {
    switch (role) {
        case 'admin': return '#f39c12';
        case 'streamer': return '#e74c3c';
        case 'global_mod':
        case 'mod':
        case 'moderator': return '#2ecc71';
        case 'subscriber': return '#3498db';
        default: return '#9a9a9a';
    }
}

let _chatUserScrolledUp = false;
let _chatUnreadCount = 0;
let _loadingHistory = false;

function scrollChat() {
    const { messages: container } = getChatEl();
    if (!container) return;
    // Only auto-scroll if user is near the bottom
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    if (nearBottom) {
        container.scrollTop = container.scrollHeight;
        _chatUserScrolledUp = false;
        _chatUnreadCount = 0;
        _hideChatNewMessagesIndicator();
    } else {
        _chatUserScrolledUp = true;
    }
}

/** Force-scroll chat to the very bottom (ignoring nearBottom guard). Used after loading history. */
function scrollChatToBottom() {
    const { messages: container } = getChatEl();
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    _chatUserScrolledUp = false;
    _chatUnreadCount = 0;
    _hideChatNewMessagesIndicator();
}

function _showChatNewMessagesIndicator() {
    const { messages: container } = getChatEl();
    if (!container) return;
    const parent = container.parentElement;
    if (!parent) return;
    let indicator = parent.querySelector('.chat-new-msgs-indicator');
    if (!indicator) {
        indicator = document.createElement('button');
        indicator.className = 'chat-new-msgs-indicator';
        indicator.onclick = () => scrollChatToBottom();
        // Insert directly above the chat-input-area so it doesn't overlap the input
        const inputArea = parent.querySelector('.chat-input-area');
        if (inputArea) {
            parent.insertBefore(indicator, inputArea);
        } else {
            parent.appendChild(indicator);
        }
    }
    indicator.innerHTML = `<i class="fa-solid fa-arrow-down"></i> ${_chatUnreadCount} new message${_chatUnreadCount !== 1 ? 's' : ''}`;
    indicator.style.display = 'flex';
}

function _hideChatNewMessagesIndicator() {
    const { messages: container } = getChatEl();
    if (!container) return;
    const indicator = container.parentElement?.querySelector('.chat-new-msgs-indicator');
    if (indicator) indicator.style.display = 'none';
}

function _onNewChatMessageWhileScrolledUp() {
    _chatUnreadCount++;
    _showChatNewMessagesIndicator();
}

/* ═══════════════════════════════════════════════════════════════
   Cross-Feed: Secondary Global WS (show global/all-stream msgs in stream chat)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Sync the global feed WS connection based on current chat settings.
 * Opens a secondary WS to global chat when the user is in a stream chat
 * and has enabled showGlobalInStream or showAllStreamsInStream.
 */
function _syncGlobalFeed() {
    // Run on any channel context — a live stream OR an offline channel page (channelUserId)
    // — so global messages keep arriving live even while the streamer is offline.
    const wantFeed = (chatStreamId || chatChannelUserId) && (chatSettings.showGlobalInStream || chatSettings.showAllStreamsInStream);
    if (wantFeed && !_globalFeedWs) {
        _openGlobalFeed();
    } else if (!wantFeed && _globalFeedWs) {
        _closeGlobalFeed();
    }
}

function _openGlobalFeed() {
    _closeGlobalFeed();
    const host = window.location.hostname;
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const token = localStorage.getItem('token');

    const params = new URLSearchParams();
    if (token) params.set('token', token);
    // No stream param = global chat
    const wsUrl = `${protocol}://${host}:${port}/ws/chat?${params.toString()}`;
    const ws = new WebSocket(wsUrl);
    _globalFeedWs = ws;
    _globalFeedReconnectDelay = 3000;

    ws.onopen = () => {
        if (_globalFeedWs !== ws) return;
        ws.send(JSON.stringify({ type: 'join', token: token || undefined }));
        console.log('[CrossFeed] Global feed connected');
    };

    ws.onmessage = (e) => {
        if (_globalFeedWs !== ws) return;
        try {
            const msg = JSON.parse(e.data);
            _handleGlobalFeedMessage(msg);
        } catch { /* ignore */ }
    };

    ws.onclose = () => {
        if (_globalFeedWs !== ws) return;
        _globalFeedWs = null;
        // Auto-reconnect if still desired
        const wantFeed = chatStreamId && (chatSettings.showGlobalInStream || chatSettings.showAllStreamsInStream);
        if (wantFeed) {
            _globalFeedReconnectTimer = setTimeout(() => {
                _globalFeedReconnectTimer = null;
                if (chatStreamId && (chatSettings.showGlobalInStream || chatSettings.showAllStreamsInStream)) {
                    _openGlobalFeed();
                }
            }, _globalFeedReconnectDelay);
            _globalFeedReconnectDelay = Math.min(_globalFeedReconnectDelay * 1.5, _GLOBAL_FEED_RECONNECT_MAX);
        }
    };

    ws.onerror = () => {
        if (_globalFeedWs !== ws) return;
        console.warn('[CrossFeed] Global feed WS error');
    };
}

function _closeGlobalFeed() {
    if (_globalFeedReconnectTimer) {
        clearTimeout(_globalFeedReconnectTimer);
        _globalFeedReconnectTimer = null;
    }
    if (_globalFeedWs) {
        const ws = _globalFeedWs;
        _globalFeedWs = null;
        try { ws.close(); } catch { }
    }
}

function _handleGlobalFeedMessage(msg) {
    // Only process chat messages — ignore system, auth, user-count, etc.
    if (msg.type !== 'chat') return;

    const hasStreamChannel = !!msg.stream_channel;

    // Filter based on settings:
    // - showAllStreamsInStream: show everything (global + all streams)
    // - showGlobalInStream only: show global messages (those WITHOUT stream_channel)
    if (!chatSettings.showAllStreamsInStream && hasStreamChannel) {
        return; // only global messages when showAllStreams is off
    }

    // Don't duplicate messages from the channel we're currently viewing (its own
    // messages already render in the main timeline). Works live AND offline. The
    // local copy always takes precedence over the cross-feed one.
    // Fallback chain matters: in a popout pinned to an expired stream id,
    // currentStreamData is empty — chatChannel (set by the history load) and the
    // joined channel user id still identify the channel, so compare those too or
    // every own message renders twice (local + cross-feed copy).
    if (hasStreamChannel || msg.channel_user_id) {
        const currentStreamChannel = (currentStreamData && currentStreamData.username)
            || (typeof currentChannelUsername !== 'undefined' && currentChannelUsername)
            || (typeof chatChannel !== 'undefined' && chatChannel)
            || null;
        if (hasStreamChannel && currentStreamChannel) {
            const currentChannelNorm = String(currentStreamChannel).trim().toLowerCase();
            const sourceChannelNorm = String(msg.stream_channel).trim().toLowerCase();
            if (currentChannelNorm && currentChannelNorm === sourceChannelNorm) {
                return;
            }
        }
        if (msg.channel_user_id && typeof chatChannelUserId !== 'undefined' && chatChannelUserId
            && Number(msg.channel_user_id) === Number(chatChannelUserId)) {
            return;
        }
    }

    // Render into the ACTIVE chat container (live sidebar, offline chat, or broadcast).
    const { messages: container } = getChatEl();
    if (!container) return;

    const el = _buildCrossfeedEl(msg);

    // Auto-scroll management
    if (!_chatUserScrolledUp) {
        container.appendChild(el);
        container.scrollTop = container.scrollHeight;
    } else {
        container.appendChild(el);
        _onNewChatMessageWhileScrolledUp();
    }
    // Trim old messages
    while (container.children.length > 500) container.removeChild(container.firstChild);
}

// Build a cross-feed (.chat-msg-crossfeed) element — shared by the live global feed
// AND history rehydration so global messages look identical whether live or reloaded.
// Parse a chat message timestamp as UTC. Live messages arrive as ISO (with 'Z'); history from
// SQLite arrives as a bare "YYYY-MM-DD HH:MM:SS" (UTC, no zone) which `new Date()` would wrongly
// read as LOCAL time. Normalise both so every render path shows the same, correct time.
function _parseMsgTime(raw) {
    if (raw == null || raw === '') return new Date();
    if (raw instanceof Date) return raw;
    if (typeof raw === 'number') return new Date(raw);
    const s = String(raw);
    const isUTC = s.includes('Z') || s.includes('+') || s.includes('T');
    return new Date(isUTC ? s : s.replace(' ', 'T') + 'Z');
}

function _buildCrossfeedEl(msg) {
    const hasStreamChannel = !!msg.stream_channel;
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-crossfeed';
    let sourceBadge = '';
    if (hasStreamChannel) {
        // Real anchor so middle-click / ctrl-click opens the stream in a new tab; left-click stays SPA.
        const chUrl = '/@' + esc(msg.stream_channel);
        sourceBadge = `<a class="chat-crossfeed-badge chat-crossfeed-stream" style="text-decoration:none" title="From ${esc(msg.stream_channel)}'s stream" href="${chUrl}" onclick="return handleLinkClick(event, '${chUrl}')"><i class="fa-solid fa-tower-broadcast"></i> ${esc(msg.stream_channel)}</a> `;
    } else {
        sourceBadge = `<a class="chat-crossfeed-badge chat-crossfeed-global" style="text-decoration:none" title="Open Global Chat" href="/chat" onclick="return handleLinkClick(event, '/chat')"><i class="fa-solid fa-globe"></i> Global</a> `;
    }
    const badge = chatSettings.showBadges ? getBadgeHTML(msg.role) : '';
    let nameColor = relayColorFor(msg) || msg.color || msg.profile_color || getRoleColor(msg.role);
    if (chatSettings.readableColors) nameColor = ensureReadableColor(nameColor);
    const displayName = esc(msg.username || msg.displayName || `anon${msg.anonId || ''}`);
    const _relayPlatform = (msg.source_platform || parseRelayUsername(msg.username || msg.displayName || '').platform || '').toLowerCase();
    const _relayBadge = relayBadgeHTML(_relayPlatform);
    const _aiBadge = (msg.is_ai || msg.source_platform === 'ai') ? '<span class="chat-ai-badge">AI</span>' : '';
    const _visibleName = _relayBadge ? esc((msg.username || msg.displayName || '').replace(/^\[[^\]]+\]\s*/, '')) : displayName;
    const rawText = msg.message || msg.text || '';
    const text = (typeof parseEmotes === 'function') ? parseEmotes(rawText) : esc(rawText);
    let tsHtml = '';
    if (chatSettings.showTimestamps) {
        const tsSource = _parseMsgTime(msg.timestamp);
        const tsOpts = chatSettings.timestampFormat === '24h'
            ? { hour: '2-digit', minute: '2-digit', hour12: false }
            : { hour: '2-digit', minute: '2-digit' };
        tsHtml = `<span class="chat-time-inline">${tsSource.toLocaleTimeString([], tsOpts)}</span> `;
    }
    // Make crossfeed names clickable like normal chat: flag relay messages so they
    // get the relay context menu (AI insight / chat logs / mod), and carry the ids
    // real + anon users need for their menus.
    const isRelayMsg = msg.role === 'external' || isRelayPlatform(msg.source_platform) || !!_relayBadge;
    if (isRelayMsg) { el.dataset.isRelay = '1'; el.dataset.sourcePlatform = _relayPlatform || msg.source_platform || ''; }
    if (msg.id) el.dataset.msgId = String(msg.id);
    const cfUserId = msg.user_id || '';
    const cfIsAnon = !cfUserId && !isRelayMsg;
    const cfCore = msg.core_username || (isRelayMsg ? '' : (msg.username || ''));
    el.innerHTML = `${tsHtml}${sourceBadge}${badge}${_relayBadge}${_aiBadge}<span class="chat-name" style="color:${nameColor}" data-username="${displayName}" data-core-username="${esc(cfCore)}" data-user-id="${esc(String(cfUserId))}" data-anon="${cfIsAnon ? '1' : ''}" oncontextmenu="showChatContextMenu(event)" onclick="showChatContextMenu(event)">${_visibleName}</span>: <span class="chat-text">${text}</span>`;
    return el;
}

/**
 * Freeze a GIF emote by drawing its first frame onto a canvas and replacing the src.
 */
function freezeGifEmote(img) {
    if (img._frozen) return;
    img._frozen = true;
    img._origSrc = img.src;
    const freeze = () => {
        try {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth || 28;
            c.height = img.naturalHeight || 28;
            c.getContext('2d').drawImage(img, 0, 0);
            img.src = c.toDataURL('image/png');
        } catch { /* CORS — leave as-is, CSS will hide animation */ }
    };
    if (img.complete) freeze();
    else img.addEventListener('load', freeze, { once: true });
}

function updateViewerCount(count) {
    const el = document.getElementById('vc-viewers');
    // Include cached external viewer count (Kick/Twitch/RS) if available
    const external = (typeof _cachedExternalViewerCount === 'number') ? _cachedExternalViewerCount : 0;
    if (el) el.textContent = count + external;
}

/**
 * Update the viewer count badge in the live stream tab for a given stream.
 */
function updateTabViewerCount(streamId, count) {
    if (!streamId) return;
    const tab = document.querySelector(`.live-tab[data-stream-id="${streamId}"]`);
    if (!tab) return;
    const badge = tab.querySelector('.live-tab-viewers');
    if (badge) {
        // Update just the number, keep the icon
        badge.innerHTML = `<i class="fa-solid fa-eye"></i> ${count}`;
    }
}

function viewProfile(username) {
    if (username.startsWith('anon')) return;
    navigate(typeof channelPath === 'function' ? channelPath(username) : `/@${username}`);
}

function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
}

function timeAgoShort(dateStr) {
    const d = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z');
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
    if (diff < 31536000) return Math.floor(diff / 2592000) + 'mo ago';
    return Math.floor(diff / 31536000) + 'y ago';
}

/* ── Per-channel chat limits (max message length + max TTS length) ── */
let _channelChatLimits = { max_message_length: 500, tts_max_length: 200 };
function applyChatLimits(limits) {
    if (limits && typeof limits === 'object') {
        _channelChatLimits = {
            max_message_length: Math.max(1, Number(limits.max_message_length) || 500),
            tts_max_length: Math.max(10, Number(limits.tts_max_length) || 200),
        };
    }
    window._channelChatLimits = _channelChatLimits;
    // Cap the chat input(s) to the streamer's max message length.
    ['chat-input', 'fullscreen-chat-input', 'offline-chat-input'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.setAttribute('maxlength', String(_channelChatLimits.max_message_length));
    });
    // Refresh the streamer settings popover if it's open.
    if (typeof _syncChatLimitsPopover === 'function') _syncChatLimitsPopover();
}
function _ttsMaxLen() { return (window._channelChatLimits && window._channelChatLimits.tts_max_length) || 200; }

// Streamer/mod control: show the "Chat limits" button + remember which channel to save to.
let _chatLimitsChannelId = null;
function setChatLimitsContext(channelId, canManage) {
    _chatLimitsChannelId = channelId || null;
    document.querySelectorAll('.chat-limits-btn').forEach(b => { b.style.display = (canManage && channelId) ? '' : 'none'; });
    if (!canManage) { const p = document.getElementById('chat-limits-popover'); if (p) p.remove(); }
}
function _syncChatLimitsPopover() {
    const L = window._channelChatLimits || {};
    const a = document.getElementById('clp-maxmsg'), b = document.getElementById('clp-maxtts');
    if (a && L.max_message_length) a.value = L.max_message_length;
    if (b && L.tts_max_length) b.value = L.tts_max_length;
}
function toggleChatLimitsPopover(btn) {
    const existing = document.getElementById('chat-limits-popover');
    if (existing) { existing.remove(); return; }
    const L = window._channelChatLimits || { max_message_length: 500, tts_max_length: 200 };
    const _msgCap = (currentUser?.role === 'admin') ? 6000 : 4000;
    const pop = document.createElement('div');
    pop.id = 'chat-limits-popover';
    pop.className = 'chat-limits-popover';
    pop.innerHTML = `
        <div class="clp-title"><i class="fa-solid fa-sliders"></i> Chat limits</div>
        <label class="clp-row"><span>Max message length</span><input type="number" id="clp-maxmsg" min="1" max="${_msgCap}" value="${Number(L.max_message_length) || 500}"></label>
        <label class="clp-row"><span>Max TTS length</span><input type="number" id="clp-maxtts" min="10" max="1200" value="${Number(L.tts_max_length) || 200}"></label>
        <div class="clp-actions"><button class="btn btn-small btn-primary" onclick="saveChatLimits()"><i class="fa-solid fa-check"></i> Save</button></div>
        <div class="clp-hint">Applies to everyone in your chat.</div>`;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.left = Math.min(Math.max(8, r.left), window.innerWidth - pop.offsetWidth - 8) + 'px';
    pop.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    setTimeout(() => {
        const closer = (e) => { if (!pop.contains(e.target) && !e.target.closest('.chat-limits-btn')) { pop.remove(); document.removeEventListener('click', closer); } };
        document.addEventListener('click', closer);
    }, 0);
}
async function saveChatLimits() {
    if (!_chatLimitsChannelId) { toast('No channel selected', 'error'); return; }
    const _msgCap = (currentUser?.role === 'admin') ? 6000 : 4000;
    const maxmsg = Math.min(_msgCap, Math.max(1, parseInt(document.getElementById('clp-maxmsg')?.value, 10) || 500));
    const maxtts = Math.min(1200, Math.max(10, parseInt(document.getElementById('clp-maxtts')?.value, 10) || 200));
    try {
        await api(`/channels/${_chatLimitsChannelId}/moderation`, { method: 'PUT', body: { max_message_length: maxmsg, tts_max_length: maxtts } });
        applyChatLimits({ max_message_length: maxmsg, tts_max_length: maxtts });
        toast('Chat limits saved', 'success');
        document.getElementById('chat-limits-popover')?.remove();
    } catch (e) { toast(e.message || 'Failed to save chat limits', 'error'); }
}

/* ── TTS ──────────────────────────────────────────────────────── */

/** Browser-side TTS using SpeechSynthesis API (Self TTS / legacy fallback) */
function speakTTS(text, voiceFX, username) {
    if (!('speechSynthesis' in window)) return;
    // "." prefix = TTS explicitly skipped (regardless of any per-viewer setting).
    if (String(text || '').trimStart().startsWith('.')) return;
    // Replace real links with TTS-friendly descriptions (shared with broadcast.js + server).
    let cleanText = OpenVibeChat.ttsReplaceLinks(text, username);
    // Cap TTS to the streamer's max TTS length.
    const _ttsMax = _ttsMaxLen();
    if (cleanText.length > _ttsMax) cleanText = cleanText.slice(0, _ttsMax);
    const utter = new SpeechSynthesisUtterance(cleanText);
    utter.rate = voiceFX?.rate || 1;
    utter.pitch = voiceFX?.pitch || 1;
    utter.volume = (chatSettings.ttsVolume || 80) / 100;
    speechSynthesis.speak(utter);
}

/** Server-synthesized TTS audio playback queue */
let _ttsAudioQueue = [];
let _ttsAudioPlaying = false;

/**
 * Set playback SPEED as a pure tempo change (pitch preserved) so it stays
 * independent of the pitch shifter below. "!sound 2" → 2× tempo, same pitch.
 */
function _setSoundSpeed(audio, speedMod) {
    const s = Math.max(0.25, Math.min(4.0, Number(speedMod) || 1.0));
    audio.playbackRate = s;
    audio.preservesPitch = true;
    audio.mozPreservesPitch = true;
    audio.webkitPreservesPitch = true;
}

// ── Real-time PITCH shifter (independent of speed) ───────────────────────
// Compact version of the classic Web Audio "Jungle" pitch shifter: two
// crossfaded, sawtooth-modulated delay lines. setPitchOffset(o) shifts by
// o octaves (o≈[-1,1]); pitchShift units map o = units/100 (100 = +1 octave).
function _jungleFadeBuffer(context, activeTime, fadeTime) {
    const length1 = activeTime * context.sampleRate;
    const length = length1 + fadeTime * context.sampleRate;
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const p = buffer.getChannelData(0);
    const fadeLength = fadeTime * context.sampleRate;
    const fadeIndex1 = fadeLength;
    const fadeIndex2 = length1 - fadeLength;
    for (let i = 0; i < length1; ++i) {
        let v;
        if (i < fadeIndex1) v = Math.sqrt(i / fadeLength);
        else if (i >= fadeIndex2) v = Math.sqrt(1 - (i - fadeIndex2) / fadeLength);
        else v = 1;
        p[i] = v;
    }
    for (let i = length1; i < length; ++i) p[i] = 0;
    return buffer;
}
function _jungleDelayBuffer(context, activeTime, fadeTime, shiftUp) {
    const length1 = activeTime * context.sampleRate;
    const length = length1 + fadeTime * context.sampleRate;
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const p = buffer.getChannelData(0);
    for (let i = 0; i < length1; ++i) p[i] = shiftUp ? (length1 - i) / length : i / length;
    for (let i = length1; i < length; ++i) p[i] = 0;
    return buffer;
}
function _createJunglePitchShifter(context) {
    const delayTime = 0.100, fadeTime = 0.050, bufferTime = 0.100;
    const input = context.createGain();
    const output = context.createGain();

    const mod1 = context.createBufferSource(), mod2 = context.createBufferSource();
    const mod3 = context.createBufferSource(), mod4 = context.createBufferSource();
    const shiftDown = _jungleDelayBuffer(context, bufferTime, fadeTime, false);
    const shiftUp = _jungleDelayBuffer(context, bufferTime, fadeTime, true);
    mod1.buffer = shiftDown; mod2.buffer = shiftDown; mod3.buffer = shiftUp; mod4.buffer = shiftUp;
    mod1.loop = mod2.loop = mod3.loop = mod4.loop = true;

    const mod1Gain = context.createGain(), mod2Gain = context.createGain();
    const mod3Gain = context.createGain(), mod4Gain = context.createGain();
    mod3Gain.gain.value = 0; mod4Gain.gain.value = 0;
    mod1.connect(mod1Gain); mod2.connect(mod2Gain); mod3.connect(mod3Gain); mod4.connect(mod4Gain);

    const modGain1 = context.createGain(), modGain2 = context.createGain();
    mod1Gain.connect(modGain1); mod3Gain.connect(modGain1);
    mod2Gain.connect(modGain2); mod4Gain.connect(modGain2);

    const delay1 = context.createDelay(), delay2 = context.createDelay();
    modGain1.connect(delay1.delayTime); modGain2.connect(delay2.delayTime);

    const fade1 = context.createBufferSource(), fade2 = context.createBufferSource();
    const fadeBuffer = _jungleFadeBuffer(context, bufferTime, fadeTime);
    fade1.buffer = fadeBuffer; fade2.buffer = fadeBuffer;
    fade1.loop = true; fade2.loop = true;
    const mix1 = context.createGain(), mix2 = context.createGain();
    mix1.gain.value = 0; mix2.gain.value = 0;
    fade1.connect(mix1.gain); fade2.connect(mix2.gain);

    input.connect(delay1); input.connect(delay2);
    delay1.connect(mix1); delay2.connect(mix2);
    mix1.connect(output); mix2.connect(output);

    const t = context.currentTime + 0.050;
    const t2 = t + bufferTime - fadeTime;
    mod1.start(t); mod2.start(t2); mod3.start(t); mod4.start(t2);
    fade1.start(t); fade2.start(t2);

    return {
        input, output,
        setPitchOffset(mult) {
            const up = mult > 0;
            mod1Gain.gain.value = up ? 0 : 1;
            mod2Gain.gain.value = up ? 0 : 1;
            mod3Gain.gain.value = up ? 1 : 0;
            mod4Gain.gain.value = up ? 1 : 0;
            const g = 0.5 * delayTime * Math.abs(mult);
            modGain1.gain.value = g;
            modGain2.gain.value = g;
        },
    };
}

// Last line of defense against double TTS: the SAME utterance delivered twice (two
// sockets in one tab, a re-broadcast) plays once. Keyed by the server's per-message
// ttsKey — so a user legitimately typing the same text again IS read again. The
// content fallback for keyless payloads uses a 2s window: wide enough for a racing
// double delivery, far too narrow to eat a real repeat.
const _recentTtsPlays = new Map();
function _ttsRecentlyPlayed(msg) {
    const keyed = !!msg.ttsKey;
    const key = keyed ? `k:${msg.ttsKey}` : `${msg.username || ''}|${String(msg.message || msg.text || '').slice(0, 200)}`;
    const windowMs = keyed ? 30000 : 2000;
    const now = Date.now();
    const last = _recentTtsPlays.get(key);
    if (last && now - last < windowMs) return true;
    _recentTtsPlays.set(key, now);
    if (_recentTtsPlays.size > 200) {
        for (const [k, t] of _recentTtsPlays) if (now - t > 60000) _recentTtsPlays.delete(k);
    }
    return false;
}

function playTTSAudio(msg) {
    if (!msg.audio || !msg.mimeType) return;
    // "." prefix = TTS explicitly skipped.
    if (String(msg.message || msg.text || '').trimStart().startsWith('.')) return;
    if (msg.type === 'tts-audio' && _ttsRecentlyPlayed(msg)) return;
    _ttsAudioQueue.push(msg);
    _processTTSAudioQueue();
}

// Autoplay-policy recovery: a tab promoted to TTS speaker that never saw a user
// gesture gets its audio.play() rejected (NotAllowedError) — without this the queue
// would silently drop messages. Requeue and drain on the first interaction.
let _ttsUnlockArmed = false;
function _handleTtsPlayBlocked(msg, cleanupUrl) {
    try { if (cleanupUrl) URL.revokeObjectURL(cleanupUrl); } catch { /* */ }
    _ttsAudioQueue.unshift(msg);
    _ttsAudioPlaying = false;
    if (_ttsUnlockArmed) return;
    _ttsUnlockArmed = true;
    const resume = () => {
        _ttsUnlockArmed = false;
        document.removeEventListener('pointerdown', resume, true);
        document.removeEventListener('keydown', resume, true);
        _processTTSAudioQueue();
    };
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
    // Cap the backlog so a long-unattended tab doesn't burst-read 50 messages later.
    if (_ttsAudioQueue.length > 5) _ttsAudioQueue = _ttsAudioQueue.slice(-5);
}

function _processTTSAudioQueue() {
    if (_ttsAudioPlaying || _ttsAudioQueue.length === 0) return;
    _ttsAudioPlaying = true;
    const msg = _ttsAudioQueue.shift();
    try {
        const binaryStr = atob(msg.audio);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const blob = new Blob([bytes], { type: msg.mimeType });
        // A retry after the element rejected the blob URL plays from a data: URL instead
        // (some browsers/shields block blob audio; CSP allows both).
        const url = msg._forceDataUrl ? `data:${msg.mimeType};base64,${msg.audio}` : URL.createObjectURL(blob);
        const _revoke = () => { if (!msg._forceDataUrl) URL.revokeObjectURL(url); };
        const audio = new Audio(url);
        audio.onerror = () => {
            _revoke();
            _ttsAudioPlaying = false;
            if (!msg._forceDataUrl) { msg._forceDataUrl = true; _ttsAudioQueue.unshift(msg); }
            _processTTSAudioQueue();
        };
        // Sound clips (!sound / soundboard) use the independent sound volume; TTS uses TTS volume.
        const _isSoundClip = msg.type === 'soundboard-audio' || msg.message_type === 'channel-sound' || msg.message_type === 'soundboard';
        const _volPref = _isSoundClip ? chatSettings.soundVolume : chatSettings.ttsVolume;
        const volume = (Number.isFinite(_volPref) ? _volPref : 80) / 100;
        // Speed = tempo (pitch preserved); pitch = independent shift (units, 100=+1oct)
        const speedMod = msg.speed || 1.0;
        const pitchShift = Number(msg.pitchShift || 0);
        _setSoundSpeed(audio, speedMod);
        // Use Web Audio API GainNode for volume — Audio.volume is unreliable on PipeWire/Steam Deck
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const source = ctx.createMediaElementSource(audio);
            const gain = ctx.createGain();
            gain.gain.value = volume;
            if (pitchShift) {
                try {
                    const shifter = _createJunglePitchShifter(ctx);
                    shifter.setPitchOffset(pitchShift / 100);
                    source.connect(shifter.input);
                    shifter.output.connect(gain).connect(ctx.destination);
                } catch { source.connect(gain).connect(ctx.destination); }
            } else {
                source.connect(gain).connect(ctx.destination);
            }
            const cleanup = () => { _revoke(); try { ctx.close(); } catch { } _ttsAudioPlaying = false; _processTTSAudioQueue(); };
            audio.onended = cleanup;
            audio.play().catch((err) => {
                if (err && err.name === 'NotAllowedError') { try { ctx.close(); } catch { } _handleTtsPlayBlocked(msg, url); return; }
                cleanup();
            });
        } catch {
            // Fallback to Audio.volume if Web Audio API unavailable
            audio.volume = volume;
            audio.onended = () => { _revoke(); _ttsAudioPlaying = false; _processTTSAudioQueue(); };
            audio.play().catch((err) => {
                if (err && err.name === 'NotAllowedError') { _handleTtsPlayBlocked(msg, url); return; }
                _revoke(); _ttsAudioPlaying = false; _processTTSAudioQueue();
            });
        }
    } catch {
        _ttsAudioPlaying = false;
        _processTTSAudioQueue();
    }
}

/** Cancel all TTS (both browser and server audio) */
function cancelAllTTS() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    _ttsAudioQueue = [];
    _ttsAudioPlaying = false;
}

/** Toggle TTS on/off from the chat input button */
function toggleChatTTS(btn) {
    const key = getChatTTSSettingKey({ button: btn });
    chatSettings[key] = !chatSettings[key];
    saveChatSettings();
    if (btn) {
        const enabled = !!chatSettings[key];
        btn.classList.toggle('tts-active', enabled);
        btn.title = enabled ? 'TTS On (click to mute)' : 'TTS Off (click to enable)';
    }
    if (!chatSettings[key]) cancelAllTTS();
}

/** Update TTS toggle button state (called after settings load) */
function syncTTSToggleButtons() {
    document.querySelectorAll('.chat-tts-toggle').forEach(btn => {
        const enabled = isChatTTSEnabled({ button: btn });
        btn.classList.toggle('tts-active', enabled);
        btn.title = enabled ? 'TTS On (click to mute)' : 'TTS Off (click to enable)';
    });
}

/* ── Chat settings panel ──────────────────────────────────────── */
function toggleChatSettings(btn) {
    // Find the closest chat container (sidebar, global, offline, broadcast)
    let container = btn ? btn.closest('.chat-sidebar, .offline-global-chat, .global-chat-main') : null;
    // Popout window: the gear sits in the page header OUTSIDE the chat column — use
    // the column, so the popout gets the exact same settings panel as everywhere else.
    if (!container && document.getElementById('pc-msgs')) container = document.querySelector('.pc-chat-col');
    if (!container) return;
    let panel = container.querySelector('.chat-settings-panel');
    if (panel) {
        panel.remove();
        chatSettingsPanelOpen = false;
        return;
    }
    chatSettingsPanelOpen = true;
    panel = document.createElement('div');
    panel.className = 'chat-settings-panel';
    panel.innerHTML = buildSettingsPanelHTML();
    // Insert after chat-header
    const header = container.querySelector('.chat-header, .global-chat-header');
    if (header) {
        header.after(panel);
    } else {
        container.prepend(panel);
    }
    syncSettingsPanelUI();
    // Close when clicking outside
    setTimeout(() => {
        const closer = (e) => {
            if (!panel.contains(e.target) && !e.target.closest('.chat-settings-btn')) {
                panel.remove();
                chatSettingsPanelOpen = false;
                document.removeEventListener('click', closer);
            }
        };
        document.addEventListener('click', closer);
    }, 0);
}

function deleteMyChatMessagesNow() {
    if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
        toast('Chat must be connected before deleting your history', 'error');
        return;
    }
    if (!canUseViewerDeleteAllHere()) {
        toast('This streamer has disabled viewer self-delete for this chat', 'error');
        return;
    }

    const scopeLabel = chatStreamId
        ? 'from this stream chat'
        : 'from your OpenVibe.Live chat history';
    if (!confirm(`Delete all of your messages ${scopeLabel}? This cannot be undone.`)) return;

    chatWs.send(JSON.stringify({
        type: 'self-delete-history',
        streamId: chatStreamId || null,
    }));
}

function buildSettingsPanelHTML() {
    return `
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-paintbrush"></i> Appearance</div>
            <label class="csp-row">
                <span>Show Timestamps</span>
                <input type="checkbox" data-setting="showTimestamps" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Time Format</span>
                <select data-setting="timestampFormat" onchange="onChatSettingChange(this)">
                    <option value="12h">12 hour</option>
                    <option value="24h">24 hour</option>
                </select>
            </label>
            <label class="csp-row">
                <span>Font Size</span>
                <select data-setting="fontSize" onchange="onChatSettingChange(this)">
                    <option value="small">Small</option>
                    <option value="default">Default</option>
                    <option value="large">Large</option>
                </select>
            </label>
            <label class="csp-row">
                <span>Show Avatars</span>
                <input type="checkbox" data-setting="showAvatars" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Show Badges</span>
                <input type="checkbox" data-setting="showBadges" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Readable Colors</span>
                <input type="checkbox" data-setting="readableColors" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Alternating Backgrounds</span>
                <input type="checkbox" data-setting="alternateBackground" onchange="onChatSettingChange(this)">
            </label>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-face-grin-squint-tears"></i> Emotes</div>
            <label class="csp-row">
                <span>Animated Emotes</span>
                <input type="checkbox" data-setting="animatedEmotes" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Emote Size</span>
                <select data-setting="emoteScale" onchange="onChatSettingChange(this)">
                    <option value="small">Small</option>
                    <option value="default">Default</option>
                    <option value="large">Large</option>
                </select>
            </label>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-sliders"></i> Behavior</div>
            <label class="csp-row">
                <span>Show Deleted Messages</span>
                <input type="checkbox" data-setting="showDeletedMessages" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Show System Messages</span>
                <input type="checkbox" data-setting="showSystemMessages" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Highlight @Mentions</span>
                <input type="checkbox" data-setting="mentionHighlight" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Auto-Scroll</span>
                <input type="checkbox" data-setting="autoScroll" onchange="onChatSettingChange(this)">
            </label>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-user-shield"></i> Privacy</div>
            <p class="csp-hint csp-self-delete-hint">Control how long your own messages stay in chat history.</p>
            <label class="csp-row">
                <span>Auto-Delete My Messages</span>
                <select data-setting="autoDeleteMinutes" onchange="onChatSettingChange(this)">
                    <option value="0">Off</option>
                    <option value="3">3 minutes</option>
                    <option value="5">5 minutes</option>
                    <option value="10">10 minutes</option>
                    <option value="30">30 minutes</option>
                    <option value="60">1 hour</option>
                    <option value="360">6 hours</option>
                    <option value="1440">24 hours</option>
                </select>
            </label>
            <div style="margin-top:10px">
                <button class="btn btn-small btn-danger csp-delete-own-btn" onclick="deleteMyChatMessagesNow()">
                    <i class="fa-solid fa-trash-can"></i> Delete All My Messages
                </button>
            </div>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-bell"></i> Notifications</div>
            <label class="csp-row">
                <span>Flash Tab on @Mention</span>
                <input type="checkbox" data-setting="flashOnMention" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Sound on @Mention</span>
                <input type="checkbox" data-setting="soundOnMention" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Auto-Decline Incoming Calls</span>
                <input type="checkbox" data-setting="autoDeclineCalls" onchange="onChatSettingChange(this)">
            </label>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-window-restore"></i> Widget</div>
            <label class="csp-row">
                <span>Floating Chat Button</span>
                <input type="checkbox" data-setting="showFloatingChat" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Fullscreen Overlay Chat</span>
                <input type="checkbox" data-setting="fullscreenOverlayChat" onchange="onChatSettingChange(this)">
            </label>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-tower-broadcast"></i> Cross-Feed</div>
            <p class="csp-hint">Show messages from other sources while watching a stream.</p>
            <label class="csp-row">
                <span>Show Global Chat</span>
                <input type="checkbox" data-setting="showGlobalInStream" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Show All Streams</span>
                <input type="checkbox" data-setting="showAllStreamsInStream" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Show All Chats Under This Streamer</span>
                <input type="checkbox" data-setting="showOtherSlotsInStream" onchange="onChatSettingChange(this)">
            </label>
            <p class="csp-hint" style="margin-top:2px">When this streamer runs several live slots, show chat from all of them. Click a stream title to hop to that slot. Off = only the slot you're watching.</p>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-volume-high"></i> Text-to-Speech</div>
            <!-- No "Enable TTS" row here — the speaker button under the chat input IS
                 that toggle; a second switch for the same thing just confused people. -->
            <label class="csp-row" title="Controls TTS in your own channel chat while you are live (plays in one tab only, synced across your tabs). TTS on other channels uses the speaker button under the chat input.">
                <span>TTS On My Channel When Live</span>
                <input type="checkbox" data-setting="streamingTtsEnabled" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row" title="Also read your channel's chat aloud while you are OFFLINE (same one-tab-per-device + cross-tab sync as the live option).">
                <span>TTS On My Channel When Offline</span>
                <input type="checkbox" data-setting="channelTtsAlways" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>TTS Volume</span>
                <input type="range" min="0" max="100" step="5" data-setting="ttsVolume" onchange="onChatSettingChange(this)" oninput="onChatSettingChange(this)">
            </label>
            <label class="csp-row" title="Play soundboard clips and channel !sound commands (separate from TTS).">
                <span>Chat Sounds</span>
                <input type="checkbox" data-setting="soundsEnabled" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row" title="Volume for chat !sound / soundboard clips — independent of TTS volume.">
                <span>Sound Volume</span>
                <input type="range" min="0" max="100" step="5" data-setting="soundVolume" onchange="onChatSettingChange(this)" oninput="onChatSettingChange(this)">
            </label>
            <div class="csp-sub-title" style="margin-top:8px;font-size:0.8rem;color:var(--text-muted)">TTS Sources</div>
            <label class="csp-row">
                <span>Native chat</span>
                <input type="checkbox" data-setting="ttsSrcNative" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>RobotStreamer relay</span>
                <input type="checkbox" data-setting="ttsSrcRS" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Kick relay</span>
                <input type="checkbox" data-setting="ttsSrcKick" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>YouTube relay</span>
                <input type="checkbox" data-setting="ttsSrcYoutube" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Twitch relay</span>
                <input type="checkbox" data-setting="ttsSrcTwitch" onchange="onChatSettingChange(this)">
            </label>
        </div>
        <div class="csp-footer">
            <button class="btn btn-small" onclick="resetChatSettings()">Reset to Defaults</button>
        </div>
    `;
}

function onChatSettingChange(el) {
    const key = el.dataset.setting;
    if (!key) return;
    if (key === 'autoDeleteMinutes') {
        chatSettings[key] = normalizeChatAutoDeleteMinutes(el.value);
        el.value = String(chatSettings[key]);
    } else if (el.type === 'checkbox') chatSettings[key] = el.checked;
    else if (el.type === 'range') chatSettings[key] = parseInt(el.value, 10);
    else chatSettings[key] = el.value;
    saveChatSettings();
    if (key === 'ttsEnabled' || key === 'streamingTtsEnabled') syncTTSToggleButtons();
    if (key === 'showFloatingChat') _fcwUpdateVisibility();
    if (key === 'showGlobalInStream' || key === 'showAllStreamsInStream') _syncGlobalFeed();
}

function resetChatSettings() {
    chatSettings = { ...CHAT_SETTINGS_DEFAULTS };
    saveChatSettings();
    _syncGlobalFeed();
    syncSettingsPanelUI();
    toast('Chat settings reset to defaults', 'info');
}

/* ── Helpers for mention features ─────────────────────────────── */
function getCurrentUsername() {
    try {
        const token = localStorage.getItem('token');
        if (!token) return null;
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.username || payload.name || null;
    } catch { return null; }
}

let _tabFlashInterval = null;
let _originalTitle = document.title;
function flashTabTitle(fromUser) {
    if (document.hasFocus()) return;
    if (_tabFlashInterval) return; // already flashing
    let flash = true;
    _tabFlashInterval = setInterval(() => {
        document.title = flash ? `💬 ${fromUser} mentioned you!` : _originalTitle;
        flash = !flash;
    }, 1000);
    const stopFlash = () => {
        clearInterval(_tabFlashInterval);
        _tabFlashInterval = null;
        document.title = _originalTitle;
        window.removeEventListener('focus', stopFlash);
    };
    window.addEventListener('focus', stopFlash);
}

function playMentionSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 800;
        gain.gain.value = 0.15;
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.stop(ctx.currentTime + 0.3);
    } catch { }
}

function ensureReadableColor(hex) {
    // Ensure minimum luminance for dark backgrounds (target: 0.4 relative luminance)
    try {
        let r, g, b;
        if (hex.startsWith('#')) {
            const c = hex.slice(1);
            r = parseInt(c.substring(0, 2), 16);
            g = parseInt(c.substring(2, 4), 16);
            b = parseInt(c.substring(4, 6), 16);
        } else {
            return hex;
        }
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        if (lum < 0.4) {
            // Brighten the color while keeping the hue
            const boost = 0.4 / Math.max(lum, 0.01);
            r = Math.min(255, Math.round(r * boost));
            g = Math.min(255, Math.round(g * boost));
            b = Math.min(255, Math.round(b * boost));
            return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        }
        return hex;
    } catch { return hex; }
}

/* ── Close context menu on Escape ─────────────────────────────── */
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismissContextMenu();
});

/* ── Apply settings on initial page load ──────────────────────── */
applyChatSettings();
setupFullscreenChatOverlay();

/* ═══════════════════════════════════════════════════════════════
   MOBILE CHAT — Bottom Sheet Toggle
   ═══════════════════════════════════════════════════════════════ */
let _mobileChatOpen = false;
let _mobileChatUnread = 0;

function isMobileChatLayout() {
    return window.matchMedia('(max-width: 1180px)').matches;
}

function toggleMobileChat() {
    // Determine which chat surface is currently active.
    // IMPORTANT: do NOT use offsetParent === null to detect "offline" mode —
    // .chat-sidebar is position:fixed on mobile, so offsetParent is always null
    // even when the live stream is running.
    const liveArea = document.getElementById('ch-live-area');
    const isLive = liveArea && liveArea.style.display !== 'none';

    let sidebar;
    if (isLive) {
        sidebar = document.getElementById('chat-sidebar');
    } else {
        sidebar = document.getElementById('offline-global-chat') || document.getElementById('chat-sidebar');
    }
    if (!sidebar) return;

    // The FAB can always reopen the on-page chat, even if a popout hid it.
    sidebar.classList.remove('chat-popped-out');

    const fab = document.getElementById('mobile-chat-toggle');

    _mobileChatOpen = !_mobileChatOpen;
    sidebar.classList.toggle('mobile-chat-open', _mobileChatOpen);
    document.body.classList.toggle('mobile-chat-visible', _mobileChatOpen);

    if (fab) {
        const icon = fab.querySelector('i');
        if (icon) icon.className = _mobileChatOpen ? 'fa-solid fa-xmark' : 'fa-solid fa-comment';
    }

    if (_mobileChatOpen) {
        _mobileChatUnread = 0;
        const badge = document.getElementById('mobile-chat-badge');
        if (badge) { badge.style.display = 'none'; badge.textContent = '0'; }
        scrollChat();
    }
}

function incrementMobileChatUnread() {
    if (!isMobileChatLayout() || _mobileChatOpen) return;
    _mobileChatUnread++;
    const badge = document.getElementById('mobile-chat-badge');
    if (badge) {
        badge.textContent = _mobileChatUnread > 99 ? '99+' : _mobileChatUnread;
        badge.style.display = '';
    }
}

// Hook into addChatMessage to count unread on mobile
const _origAddChatMessage = typeof addChatMessage === 'function' ? addChatMessage : null;
// We can't easily wrap addChatMessage since it's already defined, so we use MutationObserver
(function () {
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.addedNodes.length > 0) {
                incrementMobileChatUnread();
            }
        }
    });
    // Start observing when chat panel exists
    function _tryObserve() {
        const container = document.getElementById('chat-messages');
        if (container) {
            observer.observe(container, { childList: true });
        } else {
            setTimeout(_tryObserve, 1000);
        }
    }
    _tryObserve();

    // Close mobile chat on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _mobileChatOpen) toggleMobileChat();
    });

    // Close mobile chat when navigating away from channel page
    window.addEventListener('popstate', () => {
        if (_mobileChatOpen) toggleMobileChat();
    });

    // Close mobile chat when tapping the backdrop scrim
    document.addEventListener('click', (e) => {
        if (!_mobileChatOpen || !isMobileChatLayout()) return;
        // Check if click is on the scrim (the ::after pseudo-element area above chat)
        const sidebar = document.getElementById('chat-sidebar');
        const fab = document.getElementById('mobile-chat-toggle');
        if (sidebar && !sidebar.contains(e.target) && fab && !fab.contains(e.target)) {
            toggleMobileChat();
        }
    });

    // Reset state on resize crossing the breakpoint
    let _wasMobile = isMobileChatLayout();
    window.addEventListener('resize', () => {
        const nowMobile = isMobileChatLayout();
        if (_wasMobile && !nowMobile && _mobileChatOpen) {
            // Went from mobile → desktop while chat was open: reset
            _mobileChatOpen = false;
            const sidebar = document.getElementById('chat-sidebar');
            if (sidebar) sidebar.classList.remove('mobile-chat-open');
            document.body.classList.remove('mobile-chat-visible');
            const fab = document.getElementById('mobile-chat-toggle');
            if (fab) {
                const icon = fab.querySelector('i');
                if (icon) icon.className = 'fa-solid fa-comment';
            }
        }
        _wasMobile = nowMobile;
    });

    // Touch swipe-down on chat header to close bottom sheet
    let _touchStartY = 0;
    document.addEventListener('touchstart', (e) => {
        if (!_mobileChatOpen) return;
        const header = e.target.closest('.chat-header');
        if (header) _touchStartY = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
        if (!_mobileChatOpen || !_touchStartY) return;
        const dy = e.changedTouches[0].clientY - _touchStartY;
        _touchStartY = 0;
        if (dy > 60) toggleMobileChat(); // swipe down > 60px = close
    }, { passive: true });
})();

/* ═══════════════════════════════════════════════════════════════
   CHAT MODE (Global / Voice Call)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Called when the chat mode dropdown changes.
 * 'global' — show all messages (default)
 * 'voice'  — show only messages tagged with the user's current voice channel
 */
function onChatModeChange(mode) {
    if (!['global', 'voice'].includes(mode)) return;
    chatMode = mode;
    const titleEl = document.getElementById('chat-mode-title');
    const subtitleEl = document.getElementById('chat-mode-subtitle');
    if (mode === 'voice') {
        if (titleEl) titleEl.textContent = 'Voice Call Chat';
        if (subtitleEl) subtitleEl.textContent = 'Messages only shared with your voice channel';
    } else {
        if (titleEl) titleEl.textContent = 'Global Chat';
        if (subtitleEl) subtitleEl.textContent = 'Live messages from all streams and the lobby';
    }
}

/**
 * Enable/disable the Voice Call option in the dropdown based on VC connection state.
 * Called from voice-channels.js when joining/leaving.
 */
function updateChatModeVoiceOption(enabled) {
    const opt = document.getElementById('chat-mode-voice-opt');
    if (opt) opt.disabled = !enabled;
    // Auto-switch back to global if voice channel disconnected
    if (!enabled && chatMode === 'voice') {
        chatMode = 'global';
        const sel = document.getElementById('chat-mode-select');
        if (sel) sel.value = 'global';
        onChatModeChange('global');
    }
}

/* ═══════════════════════════════════════════════════════════════
   FLOATING CHAT WIDGET
   ═══════════════════════════════════════════════════════════════ */

/** Show/hide the floating chat FAB on non-chat pages */
function _fcwUpdateVisibility() {
    const fab = document.getElementById('floating-chat-fab');
    const widget = document.getElementById('floating-chat-widget');
    const disabled = chatSettings && chatSettings.showFloatingChat === false;

    // Hide on the global chat page (already has full chat)
    const chatPage = document.getElementById('page-chat');
    const isOnChatPage = chatPage && chatPage.classList.contains('active');

    // Hide on live stream / channel pages (already have chat sidebar)
    const streamPage = document.getElementById('page-stream');
    const channelPage = document.getElementById('page-channel');
    const isOnStreamPage = (streamPage && streamPage.classList.contains('active'))
        || (channelPage && channelPage.classList.contains('active'));

    // Hide on broadcast page (has its own chat panel)
    const broadcastPage = document.getElementById('page-broadcast');
    const isOnBroadcastPage = broadcastPage && broadcastPage.classList.contains('active');

    if (isOnChatPage || isOnStreamPage || isOnBroadcastPage || disabled) {
        if (fab) fab.style.display = 'none';
        if (widget) widget.style.display = 'none';
        _fcwOpen = false;
    } else {
        // Not on chat/stream page — show FAB
        if (fab) fab.style.display = '';
        if (!_fcwOpen && widget) widget.style.display = 'none';
    }
}

function fcwToggle() {
    _fcwOpen = !_fcwOpen;
    const widget = document.getElementById('floating-chat-widget');
    if (widget) widget.style.display = _fcwOpen ? '' : 'none';

    if (_fcwOpen) {
        // Clear unread
        _fcwUnread = 0;
        const badge = document.getElementById('fcw-unread-badge');
        if (badge) badge.style.display = 'none';

        // Ensure chat is connected (global)
        if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
            initChat(null);
        }

        // Scroll to bottom
        const msgs = document.getElementById('fcw-messages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }
}

function fcwMinimize() {
    _fcwOpen = false;
    const widget = document.getElementById('floating-chat-widget');
    if (widget) widget.style.display = 'none';
}

function fcwClose() {
    fcwMinimize();
}

function fcwSendChat() {
    const input = document.getElementById('fcw-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text || !chatWs || chatWs.readyState !== WebSocket.OPEN) return;

    // Save to shared message history
    if (_chatMsgHistory[0] !== text) {
        _chatMsgHistory.unshift(text);
        if (_chatMsgHistory.length > CHAT_HISTORY_MAX) _chatMsgHistory.pop();
    }
    _chatHistoryIndex = -1;
    _chatHistoryDraft = '';

    chatWs.send(JSON.stringify({ type: 'chat', message: text, streamId: null }));
    input.value = '';
    _autoResizeTextarea(input);
    input.focus();
}

/** Scroll the floating chat widget to bottom */
function _fcwScrollToBottom() {
    const container = document.getElementById('fcw-messages');
    if (container) container.scrollTop = container.scrollHeight;
}

/** Mirror a chat message to the floating widget */
/** Resolve a short "where did this come from" label for a widget message. */
function _fcwSourceLabel(msg) {
    // Prefer explicit stream attribution (title → username) — a message forwarded from
    // a stream carries these even though its own is_global flag may be set on the wire.
    const title = msg.source_stream_title || msg.stream_title;
    const chan = msg.stream_channel || msg.source_channel || msg.stream_username;
    const sid = msg.source_stream_id || msg.stream_id || msg.streamId || null;
    if (title || chan) return { text: title || chan, cls: '' };
    if (sid && !(msg.scope === 'global' || msg.is_global)) {
        return { text: (window._fcwStreamLabels && window._fcwStreamLabels[sid]) || `Stream #${sid}`, cls: '' };
    }
    return { text: 'Global', cls: 'fcw-src-global' };
}

function _fcwAddMessage(msg) {
    const container = document.getElementById('fcw-messages');
    if (!container) return;

    const username = msg.username || msg.displayName || 'anon';
    const text = msg.message || msg.text || '';

    // Full parity with the main chat: role badge, relay platform badge (icon
    // instead of the "[RS]" text prefix), relay/role name color, name effects,
    // hat, and particles.
    const badge = chatSettings.showBadges ? getBadgeHTML(msg.role) : '';
    const _relayPlatform = (msg.source_platform || parseRelayUsername(username).platform || '').toLowerCase();
    const _relayBadge = relayBadgeHTML(_relayPlatform);
    const _visibleName = _relayBadge ? username.replace(/^\[[^\]]+\]\s*/, '') : username;
    const nameColor = relayColorFor(msg) || msg.color || msg.profile_color || getRoleColor(msg.role);
    const nameFXClass = msg.nameFX?.cssClass ? ` ${esc(msg.nameFX.cssClass)}` : '';
    let hatHtml = '';
    if (msg.hatFX && msg.hatFX.hatChar) {
        const animClass = msg.hatFX.animated ? ` hat-${esc(msg.hatFX.animated)}` : '';
        hatHtml = `<span class="chat-hat${animClass}">${esc(msg.hatFX.hatChar)}</span>`;
    }
    const hasParticles = msg.particleFX?.chars;
    const particleOpen = hasParticles ? `<span class="chat-particle-wrap ${esc(msg.particleFX.cssClass || '')}">` : '';
    const particleClose = hasParticles ? '</span>' : '';

    // Stream source badge — clickable stream TITLE (live → watch, offline → channel).
    const src = _fcwSourceLabel(msg);
    const srcUser = msg.stream_channel || msg.source_channel || msg.stream_username;
    let srcBadge;
    if (srcUser && src.cls !== 'fcw-src-global') {
        const chEsc = esc(srcUser);
        const ref = esc(msg.source_slug || msg.source_managed_id || '');
        if (msg.source_is_live) {
            srcBadge = `<span class="fcw-msg-source" style="cursor:pointer" title="Live: ${esc(src.text)} — click to watch" data-channel="${chEsc}" data-ref="${ref}" onclick="hopToStreamSlot(this)">${esc(src.text)}</span>`;
        } else {
            srcBadge = `<span class="fcw-msg-source" style="cursor:pointer" title="From ${chEsc} (offline)" data-channel="${chEsc}" onclick="navigate(channelPath(this.dataset.channel))">${esc(src.text)}</span>`;
        }
    } else {
        srcBadge = `<span class="fcw-msg-source ${src.cls}" title="Sent from ${esc(src.text)}">${esc(src.text)}</span>`;
    }

    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = `${srcBadge}${badge}${_relayBadge}${hatHtml}${particleOpen}<span class="chat-user${nameFXClass}" style="color:${esc(nameColor)}">${esc(_visibleName)}</span>${particleClose}: ${(typeof parseEmotes === 'function') ? parseEmotes(text) : esc(text)}`;
    container.appendChild(el);

    // Trim old messages
    while (container.children.length > 200) container.removeChild(container.firstChild);

    // Auto-scroll: force during history load, otherwise only when near bottom
    if (_loadingHistory) {
        container.scrollTop = container.scrollHeight;
    } else {
        const isScrolledDown = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
        if (isScrolledDown) container.scrollTop = container.scrollHeight;
    }

    // Increment unread if widget is closed and not on chat page
    if (!_fcwOpen) {
        const chatPage = document.getElementById('page-chat');
        const isOnChatPage = chatPage && chatPage.classList.contains('active');
        if (!isOnChatPage) {
            _fcwUnread++;
            const badge = document.getElementById('fcw-unread-badge');
            if (badge) {
                badge.textContent = _fcwUnread > 99 ? '99+' : String(_fcwUnread);
                badge.style.display = '';
            }
        }
    }
}

/** Dragging support for the floating widget header */
function fcwStartDrag(e) {
    if (e.button !== 0) return;
    _fcwDragging = true;
    const widget = document.getElementById('floating-chat-widget');
    if (!widget) return;
    const rect = widget.getBoundingClientRect();
    _fcwDragOffset.x = e.clientX - rect.left;
    _fcwDragOffset.y = e.clientY - rect.top;
    document.addEventListener('mousemove', _fcwDrag);
    document.addEventListener('mouseup', _fcwStopDrag);
    e.preventDefault();
}

function _fcwDrag(e) {
    if (!_fcwDragging) return;
    const widget = document.getElementById('floating-chat-widget');
    if (!widget) return;
    const x = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - _fcwDragOffset.x));
    const y = Math.max(0, Math.min(window.innerHeight - 80, e.clientY - _fcwDragOffset.y));
    widget.style.left = x + 'px';
    widget.style.top = y + 'px';
    widget.style.right = 'auto';
    widget.style.bottom = 'auto';
}

function _fcwStopDrag() {
    _fcwDragging = false;
    document.removeEventListener('mousemove', _fcwDrag);
    document.removeEventListener('mouseup', _fcwStopDrag);
}

/** Resize support for the floating widget */
let _fcwResizing = false;
let _fcwResizeStart = { x: 0, y: 0, w: 0, h: 0 };

function fcwStartResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    _fcwResizing = true;
    const widget = document.getElementById('floating-chat-widget');
    if (!widget) return;
    const rect = widget.getBoundingClientRect();
    _fcwResizeStart = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    document.addEventListener('mousemove', _fcwResize);
    document.addEventListener('mouseup', _fcwStopResize);
}

function _fcwResize(e) {
    if (!_fcwResizing) return;
    const widget = document.getElementById('floating-chat-widget');
    if (!widget) return;
    const dw = e.clientX - _fcwResizeStart.x;
    const dh = e.clientY - _fcwResizeStart.y;
    const newW = Math.max(260, Math.min(window.innerWidth - 40, _fcwResizeStart.w + dw));
    const newH = Math.max(200, Math.min(window.innerHeight - 40, _fcwResizeStart.h + dh));
    widget.style.width = newW + 'px';
    widget.style.height = newH + 'px';
}

function _fcwStopResize() {
    _fcwResizing = false;
    document.removeEventListener('mousemove', _fcwResize);
    document.removeEventListener('mouseup', _fcwStopResize);
}

// Hook into page navigation to show/hide FAB
document.addEventListener('DOMContentLoaded', () => {
    if (typeof initGifPickers === 'function') initGifPickers();
    // Watch all page sections for class changes
    document.querySelectorAll('.page').forEach(page => {
        const obs = new MutationObserver(_fcwUpdateVisibility);
        obs.observe(page, { attributes: true, attributeFilter: ['class'] });
    });
    // Initial check
    setTimeout(_fcwUpdateVisibility, 100);

    // Deep-link support from notifications: /?vcInvite=<channelId>
    try {
        const inviteChannel = new URLSearchParams(window.location.search).get('vcInvite');
        if (inviteChannel) {
            setTimeout(() => {
                acceptVcInvite(inviteChannel, 'Voice Channel');
            }, 450);
        }
        if (window._pendingVcInvite?.channelId && typeof vcFetchChannels === 'function' && typeof vcJoinChannel === 'function') {
            const pending = window._pendingVcInvite;
            window._pendingVcInvite = null;
            setTimeout(() => {
                acceptVcInvite(pending.channelId, pending.channelName || 'Voice Channel');
            }, 450);
        }
    } catch { }
});

// ── Re-authenticate chat WebSocket on login/logout ───────────
// When the user logs in or registers, the navbar updates but the existing
// WebSocket still carries the old anonymous identity. Re-send a `join`
// message with the new token so the server upgrades the connection.
// On logout, reconnect so the server assigns a fresh anon identity.
window.addEventListener('openvibe-auth-changed', (e) => {
    const token = e.detail?.token;
    const wasAuthed = chatWs?._openvibeAuthed;

    if (token && chatWs && chatWs.readyState === WebSocket.OPEN) {
        // Logged in — if the token changed from the existing authenticated session,
        // rebuild the chat WebSocket so we don't keep an old user identity alive.
        if (chatWs._authToken && chatWs._authToken !== token && chatWs._openvibeAuthed) {
            const sid = chatStreamId;
            destroyChat(true);
            initChat(sid);
        } else {
            chatWs.send(JSON.stringify({
                type: 'join',
                streamId: chatStreamId,
                token,
            }));
            chatWs._openvibeAuthed = true;
            chatWs._authToken = token;
        }
    } else if (!token && wasAuthed) {
        // Logged out — reconnect to get a fresh anon identity
        chatWs._openvibeAuthed = false;
        const sid = chatStreamId;
        destroyChat(true);
        if (sid) initChat(sid); else initChat(null);
    }

    // Also re-auth background broadcast WS if active
    if (token && _bgBroadcastWs && _bgBroadcastWs.readyState === WebSocket.OPEN) {
        _bgBroadcastWs.send(JSON.stringify({
            type: 'join',
            streamId: _bgBroadcastStreamId,
            token,
        }));
    }
});

/* ═══════════════════════════════════════════════════════════════
   POPOUT CHAT WINDOWS
   Open global chat or stream chat in a standalone popup window.
   ═══════════════════════════════════════════════════════════════ */
let _popoutChatWindows = new Map(); // key → Window reference

/**
 * Return the on-page chat container(s) that should be hidden while a popout
 * of the given mode is open (and re-shown when it closes).
 */
function _getChatPopoutContainers(mode) {
    if (mode === 'global') {
        return [document.querySelector('.global-chat-main')].filter(Boolean);
    }
    // Stream mode — hide whichever on-page stream chat sidebar is present
    // (live sidebar, broadcast sidebar, or the offline channel chat).
    return [
        document.getElementById('chat-sidebar'),
        document.getElementById('bc-chat-sidebar'),
        document.getElementById('offline-global-chat'),
    ].filter(Boolean);
}

function popoutChat(mode = 'global', streamId = null, username = null) {
    // Key by channel, not stream id: the popout follows the channel's live state, so
    // re-clicking the button after a stream swap should focus the same window.
    const key = mode === 'stream' ? `chan-${(username || streamId)}` : 'global';

    // If already open and alive, focus it
    const existing = _popoutChatWindows.get(key);
    if (existing && !existing.closed) {
        existing.focus();
        return;
    }

    const w = 400, h = 600;
    const left = window.screenX + window.outerWidth - w - 20;
    const top = window.screenY + 80;

    // Pretty URL: /popout/<username>[/<streamId>] (the popout auto-follows the
    // channel's live state from there). NOT /chat/… — that's the SPA's global chat
    // page. Legacy query form only when no username is known.
    let url;
    if (mode === 'stream' && username) {
        url = `/popout/${encodeURIComponent(username)}${streamId ? '/' + streamId : ''}`;
    } else if (mode === 'stream' && streamId) {
        url = `/popout-chat.html?popout=1&mode=stream&stream=${encodeURIComponent(streamId)}`; // popout resolves + upgrades
    } else {
        url = '/popout/global';
    }

    const popup = window.open(url, `openvibe_chat_${key}`,
        `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=no`);
    if (!popup) {
        toast('Popup blocked — please allow popups for this site', 'error');
        return;
    }

    _popoutChatWindows.set(key, popup);

    // Hide the on-page chat surface while it's popped out.
    _getChatPopoutContainers(mode).forEach(el => el.classList.add('chat-popped-out'));

    // Clean up on popup close — and re-show the on-page chat.
    const checkClosed = setInterval(() => {
        if (popup.closed) {
            clearInterval(checkClosed);
            _popoutChatWindows.delete(key);
            _getChatPopoutContainers(mode).forEach(el => el.classList.remove('chat-popped-out'));
        }
    }, 1000);
}

/** Convenience: popout global chat */
function popoutGlobalChat() { popoutChat('global'); }

/** Convenience: popout the current channel's chat (live stream OR offline channel). */
function popoutStreamChat() {
    // Channel identity — enough on its own for an offline channel popout, and it also
    // gives the popout its pretty /popout/<user>[/<id>] live-following URL.
    const username = (typeof currentStreamData !== 'undefined' && currentStreamData && currentStreamData.username)
        || (typeof currentChannelUsername !== 'undefined' && currentChannelUsername)
        || (typeof chatChannel !== 'undefined' && chatChannel) || null;
    if (!chatStreamId && !username) {
        toast('Not in a channel chat', 'error');
        return;
    }
    popoutChat('stream', chatStreamId || null, username);
}

/* ── Chat Users List ──────────────────────────────────────────── */

/** Current users data cache */
let _chatUsersData = null;

/**
 * Toggle the chat users panel open/closed.
 * On open, request the users list from the server.
 */
function toggleChatUsers(btn) {
    // Find the nearest chat container and its users panel
    const chatContainer = btn ? btn.closest('.chat-sidebar, .global-chat-container, .offline-global-chat') : null;
    const panels = chatContainer
        ? [chatContainer.querySelector('.chat-users-panel')]
        : document.querySelectorAll('.chat-users-panel');

    for (const panel of panels) {
        if (!panel) continue;
        const isOpen = panel.classList.toggle('open');
        if (isOpen && chatWs && chatWs.readyState === WebSocket.OPEN) {
            chatWs.send(JSON.stringify({ type: 'get-users' }));
        }
    }
}

/**
 * Render the users list into all open panels (and the popout users panel).
 */
function renderChatUsersList(users) {
    if (!users) return;
    _chatUsersData = users;
    const { logged = [], anonCount = 0 } = users;
    const total = logged.length + anonCount;

    // Build the shared list markup once, reused by on-page panels and the popout.
    let listHtml = '<div class="chat-users-list">';
    for (const u of logged) {
        const avatar = u.avatar_url
            ? `<img src="${esc(u.avatar_url)}" class="chat-users-avatar" alt="" loading="lazy">`
            : `<div class="chat-users-avatar chat-users-avatar-default"><i class="fa-solid fa-user"></i></div>`;
        const badge = getBadgeHTML(u.role);
        listHtml += `<div class="chat-users-row"><a href="/${esc(u.username)}" class="chat-users-link" onclick="event.preventDefault(); if(typeof showPage==='function') showPage('/${esc(u.username)}')">${avatar}<span class="chat-users-name">${esc(u.display_name)}</span>${badge}</a></div>`;
    }
    if (anonCount > 0) {
        listHtml += `<div class="chat-users-row chat-users-anon"><div class="chat-users-avatar chat-users-avatar-default"><i class="fa-solid fa-user-secret"></i></div><span class="chat-users-name">${anonCount} anonymous viewer${anonCount !== 1 ? 's' : ''}</span></div>`;
    }
    if (total === 0) {
        listHtml += '<div class="chat-users-empty">No one here yet</div>';
    }
    listHtml += '</div>';

    // On-page panels (channel / broadcast / global) — only the open ones.
    const panels = document.querySelectorAll('.chat-users-panel');
    for (const panel of panels) {
        if (!panel.classList.contains('open')) continue;
        panel.innerHTML = `<div class="chat-users-header"><span>Users — ${total}</span><button class="chat-users-close" onclick="closeChatUsersPanel(this)" title="Close"><i class="fa-solid fa-xmark"></i></button></div>` + listHtml;
    }

    // Popout users panel (its own header already lives in the popout markup).
    const pcBody = document.getElementById('pc-users-body');
    if (pcBody) pcBody.innerHTML = listHtml;
}

function closeChatUsersPanel(btn) {
    const panel = btn?.closest('.chat-users-panel');
    if (panel) panel.classList.remove('open');
}

/* Chat link trust-domain system + linkify moved to chat-shared.js
   (window.handleChatLinkClick / showLinkContextMenu / OpenVibeChat.linkify),
   shared with the /kiosk page. */

/* ══════════════════════════════════════════════════════════════
   CHAT RESIZE HANDLE — drag to change chat sidebar width
   ══════════════════════════════════════════════════════════════ */
(function initChatResize() {
    const handle = document.getElementById('chat-resize-handle');
    const sidebar = document.getElementById('chat-sidebar');
    if (!handle || !sidebar) return;

    const MIN_W = 250;
    const MAX_RATIO = 0.5; // max 50% of viewport

    // Restore saved width
    const saved = localStorage.getItem('openvibe_chat_width');
    if (saved) {
        const w = parseInt(saved, 10);
        if (w >= MIN_W && w <= window.innerWidth * MAX_RATIO) {
            sidebar.style.width = w + 'px';
        }
    }

    let dragging = false;
    let startX = 0;
    let startW = 0;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startW = sidebar.offsetWidth;
        handle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        // Chat is on the right, so dragging left increases width
        const diff = startX - e.clientX;
        const maxW = window.innerWidth * MAX_RATIO;
        const newW = Math.max(MIN_W, Math.min(maxW, startW + diff));
        sidebar.style.width = newW + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('openvibe_chat_width', sidebar.offsetWidth);
    });
})();
