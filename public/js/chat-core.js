/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Chat core: the part of chat that every page needs
   ═══════════════════════════════════════════════════════════════
   public/js/chat.js is the chat UI — the socket, the messages, the panels, the moderation. It
   belongs where chat is (a channel, the chat page, the broadcast desk) and nowhere else, so it is
   a lazy feature (public/features.json → chatUI): a page without chat does not download it.

   This file is the part every page does need, and nothing more:
     - toast(): the one-line wrapper every script on the site calls;
     - the chat settings (this browser's copy and the server's), because the floating chat button
       reads them and the server copy is synced on every page;
     - the floating chat button's visibility: the button sits in index.html on every page, and it
       has to appear on the pages that have no chat of their own;
     - the voice-call invite deep link (/?vcInvite=…), which a notification can land on any page.

   Loaded before chat.js. Both are plain scripts, so they share one global scope: chat.js reads
   chatSettings and _fcwOpen from here, and this file calls back into chat.js only by name, and
   only when the function it needs is there.
   ═══════════════════════════════════════════════════════════════ */

/** Run now if the document is already parsed, otherwise when it is. */
function _onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
}

function toast(message, type = 'info') {
    // Delegate to the app-level toast saved in app.js (loaded before this file).
    // Do NOT use window.toast here — this file's own function declaration overwrites
    // window.toast, so that check is always self-referential and causes infinite recursion.
    if (typeof window._appToast === 'function') {
        return window._appToast(message, type);
    }
    if (typeof console !== 'undefined' && console.log) {
        console.log(`[Chat toast ${type}] ${String(message)}`);
    }
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
    ttsHearWatching: false,       // Also read TTS aloud in this browser on channels you WATCH. Off by default: the stream's
                                  // own audio already carries its chat TTS (the streamer plays it), and a second copy in
                                  // every viewer's browser was read over the stream (owner and Maticus, 2026-10-26).
                                  // This browser only: not part of the synced chat.tts_defaults record.
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
    // Friendly global chat: null = not chosen yet (on for a viewer's first day), true/false = chosen.
    friendlyGlobal: null,
};
let chatSettings = { ...CHAT_SETTINGS_DEFAULTS };

const CHAT_SELF_DELETE_MINUTES = 3;

function normalizeChatAutoDeleteMinutes(value) {
    const minutes = parseInt(value, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) return 0;
    return Math.max(CHAT_SELF_DELETE_MINUTES, minutes);
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
    _applyChatUi();
    // Debounced push to server
    _debounceSyncSettingsToServer();
}

/**
 * The chat UI paints itself from the settings. It is not on every page (it is a lazy feature),
 * so it is asked for by name — a page without chat simply has nothing to paint.
 */
function _applyChatUi() {
    if (typeof applyChatSettings === 'function') applyChatSettings();
    if (typeof syncSettingsPanelUI === 'function') syncSettingsPanelUI();
    if (typeof syncTTSToggleButtons === 'function') syncTTSToggleButtons();
}

// Portable chat preferences live in OpenVibe.Network (user modules chat.preferences and chat.tts_defaults),
// read and written through OpenVibe.Chat at /api/chat/preferences and /api/chat/tts-settings. Only the
// settings mapped below have fields there; the rest of chatSettings stays in Live's /api/auth/preferences. A patch value of null removes the
// field, i.e. "Live's default"; Chat writes nothing when nothing changed.
const CHAT_PREFS_FONT_SCALE = { small: 0.88, large: 1.18 };
function _chatPrefsFromSettings(s) {
    return {
        timestamps: s.showTimestamps ? true : null,
        compact: s.compactMode ? true : null,
        font_scale: CHAT_PREFS_FONT_SCALE[s.fontSize] || null,
        show_badges: s.showBadges === false ? false : null,
    };
}
function _chatSettingsFromPrefs(p) {
    const out = {
        showTimestamps: p.timestamps === true,
        compactMode: p.compact === true,
        fontSize: 'default',
        showBadges: p.show_badges !== false,
    };
    if (typeof p.font_scale === 'number') out.fontSize = p.font_scale < 0.95 ? 'small' : p.font_scale > 1.05 ? 'large' : 'default';
    return out;
}
// Text-to-speech and sounds: the user module chat.tts_defaults (v2), through /api/chat/tts-settings.
// A field at Live's default is sent as null (removed), so the record only holds what the person changed.
const TTS_MODULE_SOURCES = { native: 'ttsSrcNative', robotstreamer: 'ttsSrcRS', kick: 'ttsSrcKick', youtube: 'ttsSrcYoutube', twitch: 'ttsSrcTwitch' };
function _ttsModuleFromSettings(s) {
    const sources = {};
    for (const [k, key] of Object.entries(TTS_MODULE_SOURCES)) if (s[key] === false) sources[k] = false;
    const pct = (v) => (Number.isInteger(v) && v >= 0 && v <= 100 && v !== 80 ? v : null);
    return {
        send: s.ttsEnabled === false ? false : null,
        send_while_live: s.streamingTtsEnabled === false ? false : null,
        volume: pct(s.ttsVolume),
        sounds: s.soundsEnabled === false ? false : null,
        sound_volume: pct(s.soundVolume),
        sources: Object.keys(sources).length ? sources : null,
    };
}
function _settingsFromTtsModule(t) {
    const out = {
        ttsEnabled: t.send !== false,
        streamingTtsEnabled: t.send_while_live !== false,
        ttsVolume: Number.isInteger(t.volume) ? t.volume : 80,
        soundsEnabled: t.sounds !== false,
        soundVolume: Number.isInteger(t.sound_volume) ? t.sound_volume : 80,
    };
    const src = t.sources && typeof t.sources === 'object' ? t.sources : {};
    for (const [k, key] of Object.entries(TTS_MODULE_SOURCES)) out[key] = src[k] !== false;
    return out;
}
const CHAT_MODULES = [
    { url: '/api/chat/preferences', key: 'preferences', from: _chatPrefsFromSettings, to: _chatSettingsFromPrefs },
    { url: '/api/chat/tts-settings', key: 'settings', from: _ttsModuleFromSettings, to: _settingsFromTtsModule },
];
function _pushChatPrefs(token) {
    return Promise.all(CHAT_MODULES.map((m) => fetch(m.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ [m.key]: m.from(chatSettings) }),
    }).catch(() => { /* Chat or Network unavailable: Live's copy still has them */ })));
}
/** After Live's copy: each Network record wins for its fields; none yet → seed it from this browser. */
function _syncChatPrefsFromChat(token) {
    for (const m of CHAT_MODULES) {
        fetch(m.url, { headers: { 'Authorization': `Bearer ${token}` } })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                const rec = data && data[m.key];
                if (!rec || typeof rec !== 'object') return;
                if (!data.revision) {
                    fetch(m.url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ [m.key]: m.from(chatSettings) }) }).catch(() => {});
                    return;
                }
                chatSettings = { ...chatSettings, ...m.to(rec) };
                try { localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(chatSettings)); } catch { }
                _applyChatUi();
            })
            .catch(() => { /* offline — use local */ });
    }
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
                _applyChatUi();
            }
        })
        .catch(() => { /* offline — use local */ })
        .finally(() => _syncChatPrefsFromChat(token));
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
        _pushChatPrefs(token);
    }, 500);
}

// ── Floating chat widget state ───────────────────────────────
let _fcwOpen = false;

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

// The floating chat button follows the page: it shows on the pages that have no chat of their own.
// (The router announces page changes; this replaces one MutationObserver per page section.)
_onReady(() => {
    document.addEventListener('ov:page', _fcwUpdateVisibility);
    // Initial check
    setTimeout(_fcwUpdateVisibility, 100);
});

async function _joinVoiceChannelFromInvite(channelId, channelName, switchToChat = false) {
    if (!channelId) return;

    if (switchToChat && typeof showPage === 'function') {
        showPage('chat');
    }

    // Voice code loads on demand (features.json → voice); an invite is reason enough to fetch it.
    if (typeof vcJoinChannel !== 'function' && window.ov) {
        try { await ov.load('voice'); } catch { /* falls through to the pending-invite path */ }
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
    if (typeof callState !== 'undefined' && (callState.joined || callState.connecting) && callState.channelId === ch.id) {
        return;
    }
    // Through the same door as a click: leaves whatever channel we are in first.
    vcSelectChannel(ch.id);
}

async function acceptVcInvite(channelId, channelName) {
    try {
        // The incoming-call overlay belongs to the chat UI; on a page without chat there is none.
        if (typeof window._dismissIncomingVcCallOverlay === 'function') window._dismissIncomingVcCallOverlay();
        await _joinVoiceChannelFromInvite(channelId, channelName || 'Voice Channel', true);
    } catch (err) {
        toast(err.message || 'Failed to join call invite', 'error');
    }
}

/**
 * Deep-link support from notifications: /?vcInvite=<channelId>.
 * The invite lands on whatever page the person was on, so the join happens here rather than in
 * the chat UI. A pending invite (the voice feature was not there yet) waits for the chat page.
 */
_onReady(() => {
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
