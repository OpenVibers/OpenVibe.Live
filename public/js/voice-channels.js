/**
 * OpenVibe.Live — Voice Channels Client
 *
 * Discord-style voice channel UI for the Chat tab.
 * Manages channel list, device setup preview, joining/leaving, and renders
 * participant grids. Delegates actual WebRTC signaling to call.js.
 *
 * Loaded after call.js — uses callState and call.js functions directly.
 */

/* ── VC State ──────────────────────────────────────────────── */
const vcState = {
    channels: [],
    selectedChannelId: null,
    /** @type {MediaStream|null} Preview stream for setup panel */
    previewStream: null,
    previewAudioCtx: null,
    previewAnalyser: null,
    previewSource: null,
    previewLevelInterval: null,
    previewTestNode: null,
    testing: false,
    settingsOpen: false,
    pollTimer: null,
    pollInterval: 30000,   // safety net; the server pushes the list on every change
    lastJoinedChannelId: null,
    joinSeq: 0,
    status: 'idle',
};

/* ── Channel List ──────────────────────────────────────────── */

let _vcFetchSeq = 0;
async function vcFetchChannels() {
    const seq = ++_vcFetchSeq;
    try {
        const token = typeof _getAuthToken === 'function' ? _getAuthToken() : null;
        const resp = await fetch('/api/streams/voice-channels', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!resp.ok || seq !== _vcFetchSeq) return; // a newer answer already landed
        const data = await resp.json();
        vcApplyChannels(data.channels || data || []);
    } catch {}
}
/** The list from a fetch or a server push. */
function vcApplyChannels(channels) {
    const next = Array.isArray(channels) ? channels : [];
    // The server's push is the public list; a private call this viewer can see (they were invited
    // or created it) is only in their own fetch, so it is carried over rather than dropped.
    const keep = vcState.channels.filter((c) => c.private && !next.some((n) => n.id === c.id));
    vcState.channels = keep.length ? [...next, ...keep] : next;
    vcRenderChannelList();
    vcUpdateMiniBar();
}

/**
 * The channel list is updated in place, keyed by channel id: an item that is still there keeps its
 * node (a click that straddles an update is not lost, nothing flickers), new ones slide in, gone
 * ones fade out.
 */
function vcRenderChannelList() {
    const list = document.getElementById('vc-channel-list');
    if (!list) return;
    const joinedId = (callState.joined || callState.connecting) ? (callState.channelId || null) : null;
    const have = new Map([...list.querySelectorAll(':scope > .vc-channel-item')].map((el) => [el.dataset.channelId, el]));
    let cursor = null;
    for (const ch of vcState.channels) {
        const fresh = vcChannelItem(ch, joinedId);
        const old = have.get(String(ch.id));
        let node;
        if (old) {
            have.delete(String(ch.id));
            if (old.dataset.sig !== fresh.dataset.sig) { old.replaceWith(fresh); node = fresh; } else node = old;
        } else {
            fresh.classList.add('is-entering');
            node = fresh;
        }
        const anchor = cursor ? cursor.nextSibling : list.firstChild;
        if (node !== anchor) list.insertBefore(node, anchor);
        cursor = node;
    }
    for (const [, el] of have) {
        el.classList.add('is-leaving');
        el.style.pointerEvents = 'none';
        setTimeout(() => el.remove(), 220);
    }
}

function vcChannelItem(ch, joinedId) {
    const item = document.createElement('div');
    item.className = 'vc-channel-item' + (ch.id === joinedId ? ' joined' : '') + (ch.private ? ' is-private' : '');
    item.dataset.channelId = ch.id;

    const icon = document.createElement('span');
    icon.className = 'vc-channel-icon';
    if (ch.streamId) { icon.innerHTML = '<i class="fa-solid fa-broadcast-tower"></i>'; icon.title = 'Stream channel'; }
    else if (ch.permanent) { icon.innerHTML = '<i class="fa-solid fa-globe"></i>'; icon.title = 'Public channel'; }
    else if (ch.private) { icon.innerHTML = '<i class="fa-solid fa-phone"></i>'; icon.title = 'Private call'; }
    else icon.innerHTML = '<i class="fa-solid fa-headset"></i>';

    const nameRow = document.createElement('div');
    nameRow.className = 'vc-channel-name-row';
    const name = document.createElement('span');
    name.className = 'vc-channel-name';
    name.textContent = ch.name;
    nameRow.appendChild(name);
    const mode = document.createElement('span');
    mode.className = 'vc-channel-mode';
    mode.textContent = ch.mode === 'mic' ? 'Voice' : ch.mode === 'cam+mic' ? 'Video' : 'Voice+Cam';
    nameRow.appendChild(mode);

    const count = document.createElement('span');
    count.className = 'vc-channel-count';
    const pc = ch.participantCount || 0;
    count.innerHTML = `<i class="fa-solid fa-user"></i> ${pc}`;
    if (pc >= (ch.maxParticipants || 8)) count.classList.add('full');

    const participantList = document.createElement('div');
    participantList.className = 'vc-participant-list';
    const parts = ch.participants || [];
    parts.slice(0, 6).forEach(p => {
        const row = document.createElement('div');
        row.className = 'vc-participant-row';
        const av = document.createElement('div');
        av.className = 'vc-avatar-mini';
        if (p.avatarUrl) {
            av.style.backgroundImage = `url("${String(p.avatarUrl).replace(/["\\]/g, '')}")`;
        } else {
            const initial = (p.displayName || p.username || p.anonId || '?')[0].toUpperCase();
            if (p.profileColor) av.style.background = p.profileColor;
            av.textContent = initial;
        }
        const pname = document.createElement('span');
        pname.className = 'vc-participant-name';
        pname.textContent = p.displayName || p.username || p.anonId || 'Anonymous';
        row.appendChild(av);
        row.appendChild(pname);
        if (p.muted) {
            const mu = document.createElement('i');
            mu.className = 'fa-solid fa-microphone-slash vc-participant-muted';
            row.appendChild(mu);
        } else if (p.speaking) row.classList.add('speaking');
        participantList.appendChild(row);
    });
    if (parts.length > 6) {
        const more = document.createElement('div');
        more.className = 'vc-participant-more';
        more.textContent = `+${parts.length - 6} more`;
        participantList.appendChild(more);
    }

    const body = document.createElement('div');
    body.className = 'vc-channel-body';
    body.appendChild(nameRow);
    body.appendChild(participantList);
    item.appendChild(icon);
    item.appendChild(body);
    item.appendChild(count);
    // What a re-render compares: identical content keeps the existing node.
    item.dataset.sig = [ch.name, ch.mode, pc, ch.maxParticipants, ch.id === joinedId ? 1 : 0, ...parts.map(p => `${p.peerId}:${p.displayName || p.username || p.anonId}:${p.muted ? 1 : 0}:${p.speaking ? 1 : 0}:${p.avatarUrl || ''}`)].join('|');
    item.onclick = () => vcSelectChannel(ch.id);
    return item;
}

function vcSelectChannel(channelId) {
    // Already in (or joining) this channel
    if ((callState.joined || callState.connecting) && callState.channelId === channelId) return;

    const ch = vcState.channels.find(c => c.id === channelId);
    if (!ch) { vcFetchChannels(); return; }

    // Leave the current one first, even one that is still connecting, so a quick second click
    // cannot leave you in A with B's name on the panel.
    if (callState.joined || callState.connecting) vcLeave({ switching: true });

    vcJoinChannel(ch);
}

/* ── Discord-style Direct Join ─────────────────────────────── */

async function vcJoinChannel(ch) {
    if (!ch) return;
    const seq = ++vcState.joinSeq;

    // Configure callState for channel-based join
    callState.channelId = ch.id;
    callState.streamId = ch.id; // backward compat with call.js internals
    callState.callMode = ch.mode;
    callState.isStreamer = false;
    callState.broadcastMode = false;
    callState.vcMode = true;
    callState.startCameraOff = true; // always start with camera off

    vcState.lastJoinedChannelId = ch.id;

    // Show the panel at once, empty and marked "connecting" (the previous channel's tiles used to
    // stay on screen until the new welcome arrived).
    const connPanel = document.getElementById('vc-connected-panel');
    if (connPanel) { connPanel.style.display = ''; connPanel.classList.add('is-open'); }
    const grid = document.getElementById('vc-participants-grid');
    if (grid) grid.innerHTML = '';
    vcSetStatus('connecting');

    const channelLabel = document.getElementById('vc-connected-channel');
    if (channelLabel) channelLabel.textContent = ch.name;

    // Show/hide camera button based on channel mode
    const camBtn = document.getElementById('vc-btn-camera');
    if (camBtn) camBtn.style.display = ch.mode === 'mic' ? 'none' : '';
    const camSwitchGroup = document.getElementById('vc-cam-switch-group');
    if (camSwitchGroup) camSwitchGroup.style.display = ch.mode === 'mic' ? 'none' : '';

    // Sync in-call input mode settings
    const inputModeSwitch = document.getElementById('vc-input-mode-switch');
    if (inputModeSwitch) inputModeSwitch.value = callState.inputMode;
    vcOnInputModeChange(callState.inputMode);

    try {
        await joinCall();
    } catch (err) {
        if (seq !== vcState.joinSeq) return;
        console.error('[VC] Join failed:', err);
        toast(`Failed to join voice channel: ${err.message || 'Unknown error'}`, 'error');
        callState.channelId = null;
        callState.vcMode = false;
        if (connPanel) connPanel.style.display = 'none';
        return;
    }
    if (seq !== vcState.joinSeq) return; // another channel was chosen meanwhile

    // Device pickers, now that the microphone is open and labels are readable.
    vcEnumerateDevices(ch.mode).catch(() => {});
    vcRenderChannelList();
    if (typeof updateChatModeVoiceOption === 'function') updateChatModeVoiceOption(true);
    vcUpdateMiniBar();
}

/* ── Device Setup Panel ────────────────────────────────────── */

async function vcEnumerateDevices(mode) {
    try {
        // First try enumerating without a temp stream — if permission was already
        // granted, browsers return labeled devices. This avoids acquiring a temp
        // getUserMedia stream that can steal the audio device from an active broadcast
        // on Linux/PipeWire.
        // Runs after the call's own microphone is open, so labels are readable without opening a
        // second one (two getUserMedia calls at once fought over the device on PipeWire).
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        const videoInputs = devices.filter(d => d.kind === 'videoinput');

        const micSelects = ['vc-mic-select', 'vc-mic-switch'].map(id => document.getElementById(id)).filter(Boolean);
        const camSelects = ['vc-cam-select', 'vc-cam-switch'].map(id => document.getElementById(id)).filter(Boolean);

        micSelects.forEach(sel => {
            sel.innerHTML = '<option value="default">Default Microphone</option>';
            audioInputs.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Microphone ${sel.options.length}`;
                sel.appendChild(opt);
            });
            if ([...sel.options].some(o => o.value === callState.selectedMic)) sel.value = callState.selectedMic;
        });

        camSelects.forEach(sel => {
            sel.innerHTML = '<option value="default">Default Camera</option>';
            videoInputs.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Camera ${sel.options.length}`;
                sel.appendChild(opt);
            });
            if ([...sel.options].some(o => o.value === callState.selectedCam)) sel.value = callState.selectedCam;
        });
    } catch (err) {
        console.warn('[VC] Device enumeration failed:', err.message);
    }
}

function vcOnInputModeChange(value) {
    if (!['open', 'ptt', 'vad'].includes(value)) return;
    callState.inputMode = value;
    _saveCallUserSettings();

    // Sync both setup and in-call selects
    ['vc-input-mode', 'vc-input-mode-switch'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    });

    // Show/hide PTT / VAD groups in setup
    const showPtt = value === 'ptt';
    const showVad = value === 'vad';
    ['vc-ptt-group', 'vc-ptt-switch-group'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showPtt ? '' : 'none';
    });
    ['vc-vad-group', 'vc-vad-switch-group'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showVad ? '' : 'none';
    });

    // PTT status in connected panel
    const pttStatus = document.getElementById('vc-ptt-status');
    if (pttStatus) pttStatus.style.display = (showPtt && callState.joined) ? '' : 'none';

    if (callState.joined) {
        _applyLocalAudioGate();
    }
}

function vcOnPttKeyChange(value) {
    if (!value) return;
    callState.pttKey = value;
    _saveCallUserSettings();

    ['vc-ptt-key', 'vc-ptt-key-switch'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    });

    const keyDisplay = document.getElementById('vc-ptt-status-key');
    if (keyDisplay) {
        const map = {
            Space: 'Space', KeyV: 'V', KeyT: 'T', KeyB: 'B', KeyX: 'X',
            AltLeft: 'Left Alt', AltRight: 'Right Alt',
            ControlLeft: 'Left Ctrl', ShiftLeft: 'Left Shift',
            Mouse3: 'Middle Click', Mouse4: 'Mouse 4', Mouse5: 'Mouse 5',
        };
        keyDisplay.textContent = map[value] || value;
    }
}

function vcOnVadChange(value) {
    const num = Math.max(5, Math.min(80, parseInt(value, 10) || 32));
    callState.vadThreshold = num;
    _saveCallUserSettings();

    ['vc-vad-threshold', 'vc-vad-threshold-switch'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = num;
    });
    ['vc-vad-value', 'vc-vad-switch-value'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = `${num}%`;
    });
}

/* ── Join / Leave ──────────────────────────────────────────── */

function vcLeave(opts = {}) {
    vcState.joinSeq++;
    leaveCall();
    callState.channelId = null;
    callState.vcMode = false;
    vcState.lastJoinedChannelId = null;
    vcState.settingsOpen = false;

    const connPanel = document.getElementById('vc-connected-panel');
    if (connPanel) { connPanel.style.display = 'none'; connPanel.classList.remove('is-open'); }
    const grid = document.getElementById('vc-participants-grid');
    if (grid) grid.innerHTML = '';
    // streamId doubles as the channel id in this mode; left set, call.js would ask the stream API
    // about a channel that is not a stream.
    callState.streamId = null;
    vcSetStatus('idle');

    const settingsPanel = document.getElementById('vc-incall-settings');
    if (settingsPanel) settingsPanel.style.display = 'none';

    vcState.selectedChannelId = null;
    vcRenderChannelList();

    // Switching channels keeps the chat where it is; a real leave goes back to global.
    if (!opts.switching && typeof updateChatModeVoiceOption === 'function') updateChatModeVoiceOption(false);

    // Hide mini VC bar
    vcUpdateMiniBar();
}

/** Status pill: connecting / connected / reconnecting. */
function vcSetStatus(state) {
    vcState.status = state;
    const badge = document.querySelector('#vc-connected-panel .vc-connected-badge');
    if (!badge) return;
    const label = { connecting: 'Connecting\u2026', connected: 'Voice Connected', reconnecting: 'Reconnecting\u2026' }[state] || 'Voice';
    badge.className = `vc-connected-badge is-${state}`;
    badge.innerHTML = `<i class="fa-solid fa-circle"></i> ${label}`;
}

/* ── Controls ──────────────────────────────────────────────── */

function vcToggleMute() {
    toggleCallMute();
    vcUpdateControlButtons();
    vcUpdateMiniBar();
}

function vcToggleCamera() {
    toggleCallCamera(); // re-renders the panel itself when the track is up
}

function vcToggleSettings() {
    vcState.settingsOpen = !vcState.settingsOpen;
    const panel = document.getElementById('vc-incall-settings');
    if (panel) panel.style.display = vcState.settingsOpen ? '' : 'none';

    const btn = document.getElementById('vc-btn-settings');
    if (btn) btn.classList.toggle('active', vcState.settingsOpen);
}

function vcSwitchMic(deviceId) {
    callState.selectedMic = deviceId;
    if (typeof _saveCallUserSettings === 'function') _saveCallUserSettings();
    switchCallMic(deviceId);
}

function vcSwitchCam(deviceId) {
    callState.selectedCam = deviceId;
    if (typeof _saveCallUserSettings === 'function') _saveCallUserSettings();
    switchCallCam(deviceId);
}

function vcUpdateControlButtons() {
    // Show/hide the no-mic banner (when joined without microphone permission)
    const noMicBanner = document.getElementById('vc-no-mic-banner');
    if (noMicBanner) noMicBanner.style.display = (callState.joined && callState.noMic) ? '' : 'none';

    const muteBtn = document.getElementById('vc-btn-mute');
    if (muteBtn) {
        // Hide mute button when no mic is active — the enable-mic banner replaces it
        muteBtn.style.display = callState.noMic ? 'none' : '';
        const muted = callState.muted || callState.forceMuted;
        muteBtn.innerHTML = muted
            ? '<i class="fa-solid fa-microphone-slash"></i>'
            : '<i class="fa-solid fa-microphone"></i>';
        muteBtn.classList.toggle('active', muted);
        muteBtn.title = callState.forceMuted ? 'Force-muted' : (callState.muted ? 'Unmute' : 'Mute');
    }

    const camBtn = document.getElementById('vc-btn-camera');
    if (camBtn && callState.callMode !== 'mic') {
        const camOff = callState.cameraOff || callState.forceCameraOff;
        camBtn.innerHTML = camOff
            ? '<i class="fa-solid fa-video-slash"></i>'
            : '<i class="fa-solid fa-video"></i>';
        camBtn.classList.toggle('active', camOff);
    }
}

/* ── Participant Grid Rendering ────────────────────────────── */

/**
 * Called from the patched _renderCallUI when callState.vcMode is true.
 * Renders participants into the vc-participants-grid.
 */
function vcRenderUI() {
    if (!callState.joined) {
        // Still connecting — don't tear down the UI yet, just skip rendering
        if (callState.connecting) return;
        // Disconnected (kicked, banned, call ended, etc.)
        const connPanel = document.getElementById('vc-connected-panel');
        if (connPanel) connPanel.style.display = 'none';
        // Reset VC state
        callState.vcMode = false;
        callState.channelId = null;
        vcState.lastJoinedChannelId = null;
        vcState.settingsOpen = false;
        vcRenderChannelList();
        return;
    }

    vcUpdateControlButtons();

    const grid = document.getElementById('vc-participants-grid');
    if (!grid) return;
    // Keyed by peer: a tile that is still there is swapped for its fresh version (video elements are
    // cached on the peer, so the picture does not restart), newcomers pop in, leavers fade out.
    const wanted = [];
    wanted.push(_createParticipantTile({
        peerId: callState.myPeerId,
        username: callState.localUsername,
        displayName: callState.localDisplayName || (typeof currentUser !== 'undefined' ? (currentUser?.display_name || currentUser?.username) : 'You'),
        anonId: callState.localAnonId,
        userId: callState.localUserId || (typeof currentUser !== 'undefined' ? currentUser?.id : null),
        isStreamer: callState.isStreamer,
        muted: callState.muted || callState.forceMuted,
        speaking: callState.localSpeaking,
        cameraOff: callState.cameraOff || callState.forceCameraOff,
        forceMuted: callState.forceMuted,
        forceCameraOff: callState.forceCameraOff,
        nameFX: callState.localNameFX,
        avatarUrl: callState.localAvatarUrl || (typeof currentUser !== 'undefined' ? currentUser?.avatar_url : null),
        profileColor: callState.localProfileColor || (typeof currentUser !== 'undefined' ? currentUser?.profile_color : null),
        isLocal: true,
    }));
    for (const [peerId, peer] of callState.peers) {
        wanted.push(_createParticipantTile({
            peerId,
            username: peer.username,
            anonId: peer.anonId,
            displayName: peer.displayName,
            userId: peer.userId,
            isStreamer: peer.isStreamer,
            muted: peer.muted,
            speaking: peer.speaking,
            cameraOff: peer.cameraOff,
            forceMuted: peer.forceMuted,
            forceCameraOff: peer.forceCameraOff,
            nameFX: peer.nameFX,
            localMuted: peer.localMuted,
            localVolume: peer.localVolume,
            localCameraOff: peer.localCameraOff,
            videoStream: peer.videoStream,
            avatarUrl: peer.avatarUrl,
            profileColor: peer.profileColor,
            connecting: peer.connecting,
        }));
    }
    const have = new Map([...grid.querySelectorAll(':scope > .call-participant-tile:not(.is-leaving)')].map((el) => [el.dataset.peerId, el]));
    let cursor = null;
    for (const tile of wanted) {
        const old = have.get(tile.dataset.peerId);
        if (old) { have.delete(tile.dataset.peerId); if (old._ovLvl) { tile._ovLvl = old._ovLvl; tile.style.setProperty('--lvl', old.style.getPropertyValue('--lvl')); } old.replaceWith(tile); }
        else tile.classList.add('is-entering');
        const anchor = cursor ? cursor.nextSibling : grid.firstChild;
        if (tile !== anchor) grid.insertBefore(tile, anchor);
        cursor = tile;
    }
    for (const [, el] of have) { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 260); }

    // Hide camera switch in mic-only mode
    const camSwitchGroup = document.getElementById('vc-cam-switch-group');
    if (camSwitchGroup) camSwitchGroup.style.display = callState.callMode === 'mic' ? 'none' : '';

    // PTT status
    const pttStatus = document.getElementById('vc-ptt-status');
    if (pttStatus) pttStatus.style.display = callState.inputMode === 'ptt' ? '' : 'none';
    const pttKey = document.getElementById('vc-ptt-status-key');
    if (pttKey) {
        const map = { Space: 'Space', KeyV: 'V', KeyT: 'T', AltLeft: 'Left Alt' };
        pttKey.textContent = map[callState.pttKey] || callState.pttKey;
    }
}

/* ── Create Channel Modal ──────────────────────────────────── */

function vcShowCreateModal() {
    // Check if user already has a channel
    if (typeof currentUser !== 'undefined' && currentUser?.id) {
        const existing = vcState.channels.find(c => !c.permanent && !c.streamId && c.createdBy === currentUser.id);
        if (existing) {
            toast('You already have a voice channel. Delete it before creating a new one.', 'error');
            return;
        }
    }
    const modal = document.getElementById('vc-create-modal');
    if (modal) modal.style.display = '';
    const nameInput = document.getElementById('vc-create-name');
    if (nameInput) { nameInput.value = ''; nameInput.focus(); }
}

function vcHideCreateModal() {
    const modal = document.getElementById('vc-create-modal');
    if (modal) modal.style.display = 'none';
}

async function vcCreateChannel() {
    const name = (document.getElementById('vc-create-name')?.value || '').trim();
    const mode = document.getElementById('vc-create-mode')?.value || 'mic+cam';
    const maxP = Math.min(8, parseInt(document.getElementById('vc-create-max')?.value, 10) || 8);

    if (!name) {
        const input = document.getElementById('vc-create-name');
        if (input) { input.classList.add('error'); setTimeout(() => input.classList.remove('error'), 1500); }
        return;
    }

    try {
        const token = localStorage.getItem('token');
        const resp = await fetch('/api/streams/voice-channels', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ name, mode, maxParticipants: maxP }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            toast(data.error || 'Failed to create channel', 'error');
            return;
        }
        vcHideCreateModal();
        await vcFetchChannels();
        // Auto-join the newly created channel
        const newCh = vcState.channels.find(c => c.id === data.channel?.id);
        if (newCh) vcJoinChannel(newCh);
    } catch (err) {
        console.error('[VC] Create channel failed:', err);
    }
}

/* ── Channel Polling ───────────────────────────────────────── */

function vcStartPolling() {
    vcStopPolling();
    vcFetchChannels();
    vcState.pollTimer = setInterval(() => { if (!document.hidden) vcFetchChannels(); }, vcState.pollInterval);
}

function vcStopPolling() {
    if (vcState.pollTimer) {
        clearInterval(vcState.pollTimer);
        vcState.pollTimer = null;
    }
}

/* ── Participant Count Update (called from call.js) ────────── */

function vcUpdateParticipantCount(count) {
    // Update count in-place instead of triggering a full HTTP fetch per WS event
    const ch = vcState.channels.find(c => c.id === callState.channelId);
    if (ch) {
        ch.participantCount = count;
        vcRenderChannelList();
    }
}

/* ── Initialization ────────────────────────────────────────── */

/**
 * Called when the Chat tab becomes visible.
 * Starts polling for channel updates and renders the list.
 */
function vcInit() {
    vcStartPolling();
}

/**
 * Called when navigating away from the Chat tab.
 * Stops polling but does NOT leave the voice channel.
 */
function vcDeinit() {
    vcStopPolling();
}

/**
 * Start/stop voice polling with the Chat page and keep the mini bar in step with the route.
 *
 * This file is loaded on demand (public/features.json → voice), usually after DOMContentLoaded, so
 * it boots through the loader's after-hook. It used to attach one MutationObserver per page section
 * (about 16) just to toggle the mini bar; one listener for the router's page event replaces them.
 */
let _vcBooted = false;
function vcBoot() {
    if (_vcBooted) return;
    _vcBooted = true;
    const sync = () => {
        const chatTab = document.getElementById('page-chat');
        const isVisible = !!(chatTab && chatTab.classList.contains('active'));
        if (isVisible && !vcState.pollTimer) vcInit();
        else if (!isVisible && vcState.pollTimer) vcDeinit();
        vcUpdateMiniBar();
    };
    document.addEventListener('ov:page', sync);
    sync();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', vcBoot); else vcBoot();

/* ── Mini Voice Channel Bar ────────────────────────────────── */

/**
 * Show/hide the mini VC indicator bar based on:
 * - Whether user is connected to a voice channel
 * - Whether user is currently on the Chat tab (hide if on chat tab)
 */
function vcUpdateMiniBar() {
    const miniBar = document.getElementById('vc-mini-bar');
    if (!miniBar) return;

    const chatTab = document.getElementById('page-chat');
    const isOnChatTab = chatTab && chatTab.classList.contains('active');
    const isConnected = typeof callState !== 'undefined' && callState.joined && callState.vcMode;

    if (isConnected && !isOnChatTab) {
        miniBar.style.display = '';
        // Update channel name
        const nameEl = document.getElementById('vc-mini-channel-name');
        if (nameEl) {
            const ch = vcState.channels.find(c => c.id === callState.channelId);
            nameEl.textContent = ch ? ch.name : (callState.channelId || 'Voice Channel');
        }
        // Update mute button state
        const muteBtn = document.getElementById('vc-mini-mute');
        if (muteBtn) {
            const muted = callState.muted || callState.forceMuted;
            muteBtn.innerHTML = muted
                ? '<i class="fa-solid fa-microphone-slash"></i>'
                : '<i class="fa-solid fa-microphone"></i>';
            muteBtn.style.color = muted ? '#ef4444' : '';
        }
    } else {
        miniBar.style.display = 'none';
    }
}
