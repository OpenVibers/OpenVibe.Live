/**
 * channel-uploads.js — Viewer-facing "Add channel emote / sound" modal.
 *
 * Lets any logged-in viewer contribute custom :emotes: (gif/png) and !sound
 * commands to the channel they're currently watching. The server enforces
 * whether the feature is enabled, mods-only, size/duration/count limits.
 */
(function () {
    'use strict';

    function token() { try { return localStorage.getItem('token'); } catch { return null; } }

    function resolveStreamId(explicit) {
        if (explicit) return parseInt(explicit) || null;
        if (typeof currentStreamId !== 'undefined' && currentStreamId) return currentStreamId;
        if (window.currentStreamId) return window.currentStreamId;
        return null;
    }

    // The streamer/channel-owner user id for the channel being viewed — set live AND
    // offline (from the channel page's _activeChannelUserId), so the modal works when
    // the streamer isn't live.
    function resolveChannelOwnerId() {
        try { if (typeof _activeChannelUserId !== 'undefined' && _activeChannelUserId) return _activeChannelUserId; } catch { /* */ }
        if (window.currentStreamData && window.currentStreamData.user_id) return window.currentStreamData.user_id;
        return null;
    }

    function notify(msg, type) {
        if (typeof toast === 'function') toast(msg, type || 'info');
        else if (type === 'error') alert(msg);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    let overlay = null;
    let curStreamId = null;
    let curChannelOwnerId = null;  // streamer's user id — works even when offline (no live stream)
    let _soundPreviewUrl = null;   // object URL for the attached-sound preview
    let _emotePreviewUrl = null;   // object URL for the emote upload preview
    let curTab = 'emote';

    function ensureStyles() {
        if (document.getElementById('cu-styles')) return;
        const css = `
        .cu-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100000;padding:16px;}
        .cu-modal{background:var(--bg-elevated,#1c1c22);color:var(--text,#eee);width:min(560px,96vw);max-height:90vh;overflow:auto;border-radius:12px;border:1px solid rgba(255,255,255,.1);box-shadow:0 20px 60px rgba(0,0,0,.5);}
        .cu-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.08);}
        .cu-head h3{margin:0;font-size:16px;}
        .cu-close{background:none;border:none;color:inherit;font-size:20px;cursor:pointer;opacity:.7;}
        .cu-close:hover{opacity:1;}
        .cu-tabs{display:flex;gap:6px;padding:12px 18px 0;}
        .cu-tab{flex:1;padding:9px;border:1px solid rgba(255,255,255,.12);background:transparent;color:inherit;border-radius:8px 8px 0 0;cursor:pointer;font-weight:600;}
        .cu-tab.active{background:rgba(200,150,92,.18);border-bottom-color:transparent;}
        .cu-body{padding:16px 18px 20px;}
        .cu-form{display:flex;flex-direction:column;gap:10px;margin-bottom:14px;}
        .cu-form input[type=text]{padding:9px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.25);color:inherit;}
        .cu-form input[type=file]{font-size:13px;}
        .cu-btn{padding:9px 14px;border-radius:8px;border:none;background:var(--accent,#8b5cf6);color:#111;font-weight:700;cursor:pointer;}
        .cu-btn:disabled{opacity:.5;cursor:default;}
        .cu-hint{font-size:12px;opacity:.65;line-height:1.4;}
        .cu-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;}
        .cu-emote{position:relative;display:flex;flex-direction:column;gap:6px;width:96px;padding:8px;border-radius:12px;
            background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.08);
            transition:transform .16s cubic-bezier(.2,.8,.3,1.2),border-color .16s,box-shadow .16s;animation:cuEmoteIn .28s ease both;}
        .cu-emote:hover{transform:translateY(-3px);border-color:color-mix(in srgb,var(--accent,#8b5cf6) 55%,transparent);box-shadow:0 10px 24px rgba(0,0,0,.35);}
        @keyframes cuEmoteIn{from{opacity:0;transform:translateY(6px) scale(.96)}to{opacity:1;transform:none}}
        .cu-emote-thumb{position:relative;aspect-ratio:1;border-radius:9px;overflow:hidden;display:grid;place-items:center;
            background:repeating-conic-gradient(rgba(255,255,255,.035) 0% 25%,transparent 0% 50%) 0 0/16px 16px,rgba(0,0,0,.28);}
        .cu-emote-thumb img{width:80%;height:80%;object-fit:contain;transition:transform .2s;}
        .cu-emote:hover .cu-emote-thumb img{transform:scale(1.09);}
        .cu-emote-badge{position:absolute;top:4px;left:4px;background:var(--accent,#8b5cf6);color:#111;font-weight:800;font-size:9px;
            padding:1px 6px;border-radius:999px;box-shadow:0 1px 3px rgba(0,0,0,.45);letter-spacing:.2px;}
        .cu-emote-overlay{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;gap:6px;padding:6px;
            opacity:0;transition:opacity .16s;background:linear-gradient(0deg,rgba(0,0,0,.6),transparent 62%);}
        .cu-emote:hover .cu-emote-overlay,.cu-emote:focus-within .cu-emote-overlay{opacity:1;}
        .cu-act{width:26px;height:26px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:rgba(20,20,26,.85);color:#dfe6ee;
            cursor:pointer;display:grid;place-items:center;font-size:11px;backdrop-filter:blur(3px);
            transition:transform .12s,background .12s,color .12s,border-color .12s;}
        .cu-act:hover{transform:translateY(-2px);}
        .cu-sound-rows{display:flex;flex-direction:column;gap:5px;}
        .cu-sound{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:9px;background:rgba(0,0,0,.22);transition:background .14s;}
        .cu-sound:hover{background:rgba(0,0,0,.34);}
        .cu-play{width:30px;height:30px;border-radius:50%;border:none;background:var(--accent,#8b5cf6);color:#111;cursor:pointer;
            display:grid;place-items:center;font-size:11px;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,.3);transition:transform .12s,filter .12s;}
        .cu-play:hover{transform:scale(1.08);filter:brightness(1.08);}.cu-play:active{transform:scale(.94);}
        .cu-sound-meta{font-size:12px;opacity:.72;display:inline-flex;align-items:center;gap:5px;}
        .cu-sound-meta i{opacity:.55;}
        .cu-sound-del{margin-left:auto;width:26px;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.1);background:transparent;color:#e88;
            cursor:pointer;display:grid;place-items:center;font-size:12px;flex-shrink:0;transition:background .12s,color .12s,border-color .12s;}
        .cu-sound-del:hover{background:rgba(200,60,60,.4);border-color:#ff6b6b;color:#fff;}
        .cu-sound-more{margin-top:1px;}
        .cu-sound-more>summary{cursor:pointer;font-size:12px;opacity:.65;padding:5px 10px;list-style:none;border-radius:8px;user-select:none;transition:background .12s,opacity .12s;}
        .cu-sound-more>summary::-webkit-details-marker{display:none;}
        .cu-sound-more>summary::before{content:"\\25be";margin-right:6px;display:inline-block;transition:transform .15s;}
        .cu-sound-more[open]>summary::before{transform:rotate(180deg);}
        .cu-sound-more>summary:hover{opacity:1;background:rgba(255,255,255,.05);}
        .cu-sound-more .cu-sound-rows{margin-top:5px;}
        .cu-icon-btn{width:30px;height:30px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#cdd6e0;
            cursor:pointer;display:inline-grid;place-items:center;font-size:13px;flex-shrink:0;transition:transform .12s,background .12s,color .12s,border-color .12s;}
        .cu-icon-btn:hover{transform:translateY(-1px);background:rgba(255,255,255,.11);color:#fff;border-color:rgba(255,255,255,.25);}
        .cu-icon-btn.on{background:color-mix(in srgb,var(--accent,#8b5cf6) 22%,transparent);border-color:color-mix(in srgb,var(--accent,#8b5cf6) 55%,transparent);color:var(--accent,#8b5cf6);}
        .cu-add-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:8px;flex-shrink:0;cursor:pointer;font-weight:700;font-size:12px;
            border:1px solid color-mix(in srgb,var(--accent,#8b5cf6) 45%,transparent);background:color-mix(in srgb,var(--accent,#8b5cf6) 16%,transparent);color:var(--accent,#8b5cf6);
            transition:background .14s,transform .12s;}
        .cu-add-btn:hover{background:color-mix(in srgb,var(--accent,#8b5cf6) 30%,transparent);transform:translateY(-1px);}
        .cu-cfg:hover{background:rgba(60,120,200,.4);border-color:#6ea8ff;color:#fff;}
        .cu-del:hover{background:rgba(200,60,60,.45);border-color:#ff6b6b;color:#fff;}
        .cu-code-edit{display:flex;align-items:center;gap:5px;justify-content:center;width:100%;padding:4px 8px;border-radius:8px;
            border:1px solid transparent;background:rgba(255,255,255,.045);color:inherit;cursor:pointer;font-size:11px;font-weight:600;
            transition:background .14s,border-color .14s;}
        .cu-code-edit:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.16);}
        .cu-code-text{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .cu-code-pen{font-size:9px;opacity:.5;flex-shrink:0;transition:opacity .14s,transform .14s;}
        .cu-code-edit:hover .cu-code-pen{opacity:.95;transform:rotate(-8deg);}
        .cu-code-static{font-size:11px;opacity:.72;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}
        .cu-empty{opacity:.5;font-size:13px;padding:8px 0;}
        .cu-set-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 0;font-size:13px;}
        .cu-set-row input[type=number]{width:84px;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.25);color:inherit;}
        .cu-set-group{border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:10px 12px;}
        .cu-set-group-title{font-weight:700;font-size:12px;opacity:.85;margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px;}
        .cu-size-row{display:flex;align-items:center;gap:8px;font-size:13px;}
        .cu-size-row input[type=range]{flex:1;}
        .cu-count{background:var(--accent,#8b5cf6);color:#111;border-radius:10px;padding:0 7px;font-size:11px;font-weight:700;margin-left:2px;}
        .cu-sound-group{width:100%;border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:11px 13px;margin-bottom:10px;
            background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.012));transition:border-color .16s,box-shadow .16s;animation:cuEmoteIn .28s ease both;}
        .cu-sound-group:hover{border-color:rgba(255,255,255,.15);box-shadow:0 6px 18px rgba(0,0,0,.22);}
        .cu-sound-cmd-hd{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
        .cu-hd-spacer{flex:1;}
        .cu-cmd{display:inline-flex;align-items:center;gap:6px;font-weight:800;color:var(--accent,#8b5cf6);font-size:15px;padding:3px 9px;border-radius:8px;
            border:1px solid transparent;background:transparent;cursor:pointer;transition:background .14s,border-color .14s;}
        .cu-cmd:hover{background:color-mix(in srgb,var(--accent,#8b5cf6) 15%,transparent);border-color:color-mix(in srgb,var(--accent,#8b5cf6) 35%,transparent);}
        .cu-cmd-pen{font-size:9px;opacity:.4;transition:opacity .14s,transform .14s;}
        .cu-cmd:hover .cu-cmd-pen{opacity:.9;transform:rotate(-8deg);}
        .cu-tag{font-size:11px;opacity:.5;font-weight:600;}
        .cu-sound-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;opacity:.9;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);}
        .cu-sound-chip i{color:var(--accent,#8b5cf6);}
        .cu-emote-preview{padding:6px 0}.cu-emote-preview-row{display:flex;align-items:center;gap:4px;font-size:13px}
        `;
        const el = document.createElement('style');
        el.id = 'cu-styles';
        el.textContent = css;
        document.head.appendChild(el);
    }

    function close() {
        if (overlay) { overlay.remove(); overlay = null; }
    }

    // Is the current viewer the streamer/owner (or a global mod) of this channel?
    function isChannelOwner() {
        try {
            if (typeof canModerateCurrentStream === 'function') return canModerateCurrentStream();
            const csd = window.currentStreamData, cu = window.currentUser;
            return !!(csd && cu && csd.user_id === cu.id);
        } catch { return false; }
    }

    function render() {
        overlay.querySelectorAll('.cu-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === curTab));
        const body = overlay.querySelector('.cu-body');
        if (curTab === 'settings') renderSettingsTab(body);
        else if (curTab === 'sound') renderSoundTab(body);
        else renderEmoteTab(body);
    }

    function renderEmoteTab(body) {
        body.innerHTML = `
            <form class="cu-form" id="cu-emote-form">
                <input type="text" id="cu-emote-code" maxlength="32" placeholder="Emote code (letters/numbers/_)" autocomplete="off">
                <input type="file" id="cu-emote-file" accept="image/png,image/gif,image/webp,image/jpeg,image/avif">
                <div id="cu-emote-preview" class="cu-emote-preview" style="display:none"></div>
                <div class="cu-size-row">
                    <span>Size <b id="cu-emote-size-val">100%</b></span>
                    <input type="range" id="cu-emote-size" min="25" max="400" step="5" value="100">
                </div>
                <button class="cu-btn" type="submit">Upload emote to this channel</button>
                <div class="cu-hint">Type the code in chat to use it. PNG/GIF/WebP/JPEG, up to 2&nbsp;MB. Size is clamped to the streamer's allowed range.</div>
            </form>
            <div id="cu-emote-list" class="cu-list"><span class="cu-empty">Loading…</span></div>`;
        overlay.querySelector('#cu-emote-form').addEventListener('submit', submitEmote);
        const codeEl = overlay.querySelector('#cu-emote-code');
        const fileEl = overlay.querySelector('#cu-emote-file');
        const sizeEl = overlay.querySelector('#cu-emote-size');
        let _codeTouched = false;
        codeEl.addEventListener('input', () => { _codeTouched = true; });
        const renderPreview = () => {
            const box = overlay.querySelector('#cu-emote-preview');
            const f = fileEl.files[0];
            if (!f) { box.style.display = 'none'; box.innerHTML = ''; return; }
            if (_emotePreviewUrl) { try { URL.revokeObjectURL(_emotePreviewUrl); } catch {} }
            _emotePreviewUrl = URL.createObjectURL(f);
            const pct = Math.max(25, Math.min(400, parseInt(sizeEl.value) || 100)) / 100;
            const h = Math.round(28 * pct); // matches chat's base emote height
            box.style.display = '';
            box.innerHTML = `<div class="cu-emote-preview-row"><span class="muted" style="font-size:12px">Chat preview:</span> word <img src="${_emotePreviewUrl}" style="height:${h}px;vertical-align:middle;margin:0 3px" alt=""> word</div>`;
        };
        fileEl.addEventListener('change', () => {
            const f = fileEl.files[0];
            // Autofill the code from the filename (strip extension) unless the user typed one.
            if (f && (!_codeTouched || !codeEl.value.trim())) {
                codeEl.value = _codeFromFilename(f.name);
            }
            renderPreview();
        });
        sizeEl.addEventListener('input', () => { overlay.querySelector('#cu-emote-size-val').textContent = sizeEl.value + '%'; renderPreview(); });
        loadEmoteList();
    }

    // "emote.png" → "Emote"; ("example-Sound.mp3", lowerFirst) → "exampleSound"
    function _codeFromFilename(name, lowerFirst) {
        let base = String(name || '').replace(/\.[^.]+$/, '');
        base = base.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
        base = lowerFirst ? base.replace(/^(.)/, (m) => m.toLowerCase()) : base.replace(/^(.)/, (m) => m.toUpperCase());
        return base.slice(0, 32);
    }

    function renderSoundTab(body) {
        body.innerHTML = `
            <form class="cu-form" id="cu-sound-form">
                <input type="text" id="cu-sound-cmd" maxlength="24" placeholder="Command name (e.g. airhorn) → !airhorn" autocomplete="off">
                <input type="file" id="cu-sound-file" accept="audio/*" multiple>
                <input type="text" id="cu-sound-emote" maxlength="32" placeholder="Attach an emote code (optional) — shows the emote instead of “played !cmd”" autocomplete="off">
                <div id="cu-sound-preview" style="display:none;margin:2px 0"></div>
                <button class="cu-btn" type="submit">Upload sound(s) to this channel</button>
                <div class="cu-hint">Trigger it by typing <b>!command</b> in chat. MP3/WAV/OGG, within the streamer's max length. Select <b>multiple files</b> under the same command and one plays at random each time.</div>
            </form>
            <div id="cu-sound-list" class="cu-list" style="flex-direction:column;"><span class="cu-empty">Loading…</span></div>`;
        overlay.querySelector('#cu-sound-form').addEventListener('submit', submitSound);
        const fileInput = overlay.querySelector('#cu-sound-file');
        const cmdInput = overlay.querySelector('#cu-sound-cmd');
        let _cmdTouched = false;
        cmdInput.addEventListener('input', () => { _cmdTouched = true; });
        fileInput.addEventListener('change', () => {
            const preview = overlay.querySelector('#cu-sound-preview');
            if (_soundPreviewUrl) { try { URL.revokeObjectURL(_soundPreviewUrl); } catch {} _soundPreviewUrl = null; }
            const files = fileInput.files;
            if (!files.length) { preview.style.display = 'none'; preview.innerHTML = ''; return; }
            // Autofill the command from the first filename (lower camelCase) unless typed.
            if ((!_cmdTouched || !cmdInput.value.trim())) cmdInput.value = _codeFromFilename(files[0].name, true);
            _soundPreviewUrl = URL.createObjectURL(files[0]);
            const extra = files.length > 1 ? ` <b>+${files.length - 1} more</b> (random on play)` : '';
            preview.style.display = '';
            preview.innerHTML = `<audio controls preload="metadata" src="${_soundPreviewUrl}" style="width:100%;height:34px"></audio>
                <div class="cu-hint" style="margin-top:2px">Preview: <b>${esc(files[0].name)}</b>${extra}</div>`;
        });
        loadSoundList();
    }

    // Streamer-only tab: emote size limits + emote/sound toggles for the channel.
    async function renderSettingsTab(body) {
        body.innerHTML = '<div class="cu-empty">Loading channel settings…</div>';
        let ch = null;
        try {
            const r = await fetch('/api/channels/moderation/mine', { headers: { Authorization: `Bearer ${token()}` } });
            const data = await r.json();
            const list = data.channels || [];
            // Prefer the channel currently being viewed (works offline), else own channel.
            const ownerId = curChannelOwnerId || (window.currentStreamData && window.currentStreamData.user_id) || (window.currentUser && window.currentUser.id) || null;
            ch = list.find((c) => c.user_id === ownerId) || list[0] || null;
        } catch { /* */ }
        if (!ch) { body.innerHTML = '<div class="cu-empty">Could not load your channel settings.</div>'; return; }
        const s = ch.moderation_settings || {};
        const num = (v, d) => (v == null ? d : v);
        const chk = (v, d) => (num(v, d) ? 'checked' : '');
        const ev = (v) => String(v == null ? '' : v).replace(/"/g, '&quot;');
        body.innerHTML = `
            <div class="cu-form" style="gap:12px" data-channel-id="${ch.id}">
                <div class="cu-set-group">
                    <div class="cu-set-group-title">Emotes</div>
                    <label class="cu-set-row"><span>Custom emotes enabled</span><input type="checkbox" id="cu-set-emotes" ${chk(s.custom_emotes_enabled, 1)}></label>
                    <label class="cu-set-row"><span>Only mods can upload</span><input type="checkbox" id="cu-set-modsonly" ${chk(s.uploads_mods_only, 0)}></label>
                    <label class="cu-set-row"><span>Channel emote scale (%)</span><input type="number" id="cu-set-scale" min="50" max="300" value="${num(s.emote_scale, 100)}"></label>
                    <label class="cu-set-row"><span>Min per-emote size (%)</span><input type="number" id="cu-set-emin" min="25" max="200" value="${num(s.emote_size_min, 50)}"></label>
                    <label class="cu-set-row"><span>Max per-emote size (%)</span><input type="number" id="cu-set-emax" min="50" max="400" value="${num(s.emote_size_max, 200)}"></label>
                </div>
                <div class="cu-set-group">
                    <div class="cu-set-group-title">Sounds</div>
                    <label class="cu-set-row"><span>Custom sounds enabled</span><input type="checkbox" id="cu-set-sounds" ${chk(s.custom_sounds_enabled, 1)}></label>
                    <label class="cu-set-row"><span>Only mods can upload sounds</span><input type="checkbox" id="cu-set-sounds-modsonly" ${chk(s.sounds_mods_only, 0)}></label>
                    <label class="cu-set-row"><span>Max sound length (s)</span><input type="number" id="cu-set-maxsec" min="1" max="30" value="${num(s.max_sound_seconds, 10)}"></label>
                </div>
                <div class="cu-set-group">
                    <div class="cu-set-group-title">Alert Sounds</div>
                    <div class="cu-set-row"><span>Donation sound <span class="cu-alert-state" id="cu-alert-donation-state">—</span></span>
                        <span style="display:flex;gap:6px;align-items:center">
                            <button class="cu-btn cu-btn-sm" type="button" id="cu-alert-donation-btn">Upload</button>
                            <button class="cu-btn cu-btn-sm cu-btn-ghost" type="button" id="cu-alert-donation-clear" style="display:none">Clear</button>
                        </span>
                    </div>
                    <div class="cu-set-row"><span>Goal-reached sound <span class="muted" style="font-size:0.72rem">(override; falls back to donation sound)</span> <span class="cu-alert-state" id="cu-alert-goal-state">—</span></span>
                        <span style="display:flex;gap:6px;align-items:center">
                            <button class="cu-btn cu-btn-sm" type="button" id="cu-alert-goal-btn">Upload</button>
                            <button class="cu-btn cu-btn-sm cu-btn-ghost" type="button" id="cu-alert-goal-clear" style="display:none">Clear</button>
                        </span>
                    </div>
                    <input type="file" accept="audio/*" id="cu-alert-file" style="display:none">
                    <div class="cu-hint">Plays for viewers (who have chat sounds on) whenever someone donates Vibes. MP3/WAV/OGG, up to 15s.</div>
                </div>
                <div class="cu-set-group">
                    <div class="cu-set-group-title">Channel Points</div>
                    <div class="cu-hint">Channel Points, rewards, and the redemption queue moved to your <b>Dashboard → Points</b> tab.</div>
                </div>
                <button class="cu-btn" id="cu-set-save" type="button">Save channel settings</button>
                <div class="cu-hint">Applies to everyone in your channel's chat. Pitch/speed limits live in your dashboard's moderation panel.</div>
            </div>`;
        overlay.querySelector('#cu-set-save').onclick = () => saveChannelSettings(ch.id);
        wireAlertSounds();
    }

    // ── Alert sounds (donation / goal-reached) ───────────────────
    let _alertKind = 'donation';
    async function loadAlertSounds() {
        try {
            const r = await fetch('/api/sounds/alert/mine', { headers: { Authorization: `Bearer ${token()}` } });
            const d = await r.json();
            for (const k of ['donation', 'goal']) {
                const st = overlay.querySelector(`#cu-alert-${k}-state`);
                const clr = overlay.querySelector(`#cu-alert-${k}-clear`);
                const set = d[k] && d[k].set;
                if (st) { st.textContent = set ? '✓ set' : '(none)'; st.style.color = set ? 'var(--success, #4caf50)' : ''; }
                if (clr) clr.style.display = set ? '' : 'none';
            }
        } catch { /* */ }
    }
    function wireAlertSounds() {
        const fileInput = overlay.querySelector('#cu-alert-file');
        if (!fileInput) return;
        overlay.querySelector('#cu-alert-donation-btn').onclick = () => { _alertKind = 'donation'; fileInput.click(); };
        overlay.querySelector('#cu-alert-goal-btn').onclick = () => { _alertKind = 'goal'; fileInput.click(); };
        overlay.querySelector('#cu-alert-donation-clear').onclick = () => clearAlertSound('donation');
        overlay.querySelector('#cu-alert-goal-clear').onclick = () => clearAlertSound('goal');
        fileInput.onchange = async () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            const fd = new FormData(); fd.append('sound', file);
            try {
                const r = await fetch(`/api/sounds/alert/${_alertKind}`, { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: fd });
                const d = await r.json();
                if (!r.ok) throw new Error(d.error || 'Upload failed');
                notify(`${_alertKind === 'goal' ? 'Goal-reached' : 'Donation'} sound saved`, 'success');
                loadAlertSounds();
            } catch (e) { notify(e.message, 'error'); }
            fileInput.value = '';
        };
        loadAlertSounds();
    }
    async function clearAlertSound(kind) {
        try {
            const r = await fetch(`/api/sounds/alert/${kind}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
            if (!r.ok) throw new Error('Failed');
            notify('Sound cleared', 'success');
            loadAlertSounds();
        } catch (e) { notify(e.message, 'error'); }
    }

    async function saveChannelSettings(channelId) {
        const g = (id) => overlay.querySelector(id);
        const payload = {
            custom_emotes_enabled: g('#cu-set-emotes').checked,
            uploads_mods_only: g('#cu-set-modsonly').checked,
            emote_scale: parseInt(g('#cu-set-scale').value) || 100,
            emote_size_min: parseInt(g('#cu-set-emin').value) || 50,
            emote_size_max: parseInt(g('#cu-set-emax').value) || 200,
            custom_sounds_enabled: g('#cu-set-sounds').checked,
            sounds_mods_only: g('#cu-set-sounds-modsonly').checked,
            max_sound_seconds: parseInt(g('#cu-set-maxsec').value) || 10,
        };
        const btn = g('#cu-set-save');
        btn.disabled = true;
        try {
            const r = await fetch(`/api/channels/${channelId}/moderation`, {
                method: 'PUT', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || 'Save failed');
            notify('Channel settings saved', 'success');
        } catch (e) { notify(e.message, 'error'); }
        finally { btn.disabled = false; }
    }

    async function loadEmoteList() {
        const box = overlay && overlay.querySelector('#cu-emote-list');
        if (!box) return;
        try {
            const url = curStreamId ? `/api/emotes/all/${curStreamId}` : `/api/emotes/channel/${curChannelOwnerId}`;
            const r = await fetch(url);
            const data = await r.json();
            const list = (data.channel || data.emotes || []).filter((e) => e.source === 'channel');
            if (!list.length) { box.innerHTML = '<span class="cu-empty">No channel emotes yet — be the first!</span>'; return; }
            box.innerHTML = list.map((e, i) => {
                const editable = !!e.emote_id;
                const sizePct = (e.size && e.size !== 100) ? e.size : null;
                return `
                <div class="cu-emote" style="animation-delay:${Math.min(i * 18, 360)}ms">
                    <div class="cu-emote-thumb">
                        <img src="${esc(e.url)}" alt="${esc(e.code)}" loading="lazy">
                        ${sizePct ? `<span class="cu-emote-badge">${sizePct}%</span>` : ''}
                        ${editable ? `<div class="cu-emote-overlay">
                            <button class="cu-act cu-cfg" title="Display size" onclick="__cuEmoteSize(${e.emote_id}, ${e.size || 100})"><i class="fa-solid fa-gear"></i></button>
                            <button class="cu-act cu-del" title="Delete emote" onclick="__cuDeleteEmote(${e.emote_id})"><i class="fa-solid fa-trash-can"></i></button>
                        </div>` : ''}
                    </div>
                    ${editable
                        ? `<button class="cu-code-edit" title="Click to rename this emote" onclick="__cuRenameEmote(${e.emote_id}, '${esc(e.code)}')"><span class="cu-code-text">${esc(e.code)}</span><i class="fa-solid fa-pen cu-code-pen"></i></button>`
                        : `<span class="cu-code-static" title="${esc(e.code)}">${esc(e.code)}</span>`}
                </div>`;
            }).join('');
        } catch { box.innerHTML = '<span class="cu-empty">Could not load emotes.</span>'; }
    }

    async function loadSoundList() {
        const box = overlay && overlay.querySelector('#cu-sound-list');
        if (!box) return;
        try {
            const url = curStreamId ? `/api/sounds/all/${curStreamId}` : `/api/sounds/channel/${curChannelOwnerId}`;
            const r = await fetch(url);
            const data = await r.json();
            const list = data.sounds || [];
            if (!list.length) { box.innerHTML = '<span class="cu-empty">No channel sounds yet — be the first!</span>'; return; }
            // Group by command — a command can hold several sounds; one is chosen at random on play.
            const groups = {};
            list.forEach((s) => { (groups[s.command] = groups[s.command] || []).push(s); });
            const soundRow = (s) => `<div class="cu-sound">
                <button class="cu-play" title="Preview" onclick="__cuPreviewSound('${esc(s.url)}')"><i class="fa-solid fa-play"></i></button>
                <span class="cu-sound-meta"><i class="fa-regular fa-clock"></i> ${(typeof s.duration_seconds === 'number' ? s.duration_seconds.toFixed(1) : (s.duration_seconds || 0))}s · ${esc(s.uploader || '')}</span>
                <button class="cu-sound-del" title="Delete this sound" onclick="__cuDeleteSound(${s.id})"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
            box.innerHTML = Object.keys(groups).sort().map((cmd) => {
                const arr = groups[cmd];
                const emoteCode = (arr.find((s) => s.emote_code) || {}).emote_code || '';
                const shown = arr.slice(0, 3), hidden = arr.slice(3);
                return `<div class="cu-sound-group">
                    <div class="cu-sound-cmd-hd">
                        <button class="cu-cmd" title="Click to rename this command" onclick="__cuRenameSoundCmd('${esc(cmd)}')">!${esc(cmd)}<i class="fa-solid fa-pen cu-cmd-pen"></i></button>
                        ${arr.length > 1 ? `<span class="cu-count">×${arr.length}</span><span class="cu-tag">random</span>` : ''}
                        ${emoteCode ? `<span class="cu-sound-chip"><i class="fa-solid fa-face-grin-stars"></i>:${esc(emoteCode)}:</span>` : ''}
                        <span class="cu-hd-spacer"></span>
                        <button class="cu-icon-btn${emoteCode ? ' on' : ''}" title="${emoteCode ? 'Change or remove the attached emote' : 'Attach an emote to this command'}" onclick="__cuSoundEmote('${esc(cmd)}', '${esc(emoteCode)}')"><i class="fa-solid fa-face-grin-stars"></i></button>
                        <button class="cu-add-btn" onclick="__cuAddToSound('${esc(cmd)}')" title="Add another sound to this command"><i class="fa-solid fa-plus"></i> Add</button>
                    </div>
                    <div class="cu-sound-rows">
                        ${shown.map(soundRow).join('')}
                        ${hidden.length ? `<details class="cu-sound-more"><summary>Show ${hidden.length} more</summary><div class="cu-sound-rows">${hidden.map(soundRow).join('')}</div></details>` : ''}
                    </div>
                </div>`;
            }).join('');
        } catch { box.innerHTML = '<span class="cu-empty">Could not load sounds.</span>'; }
    }

    async function submitEmote(ev) {
        ev.preventDefault();
        if (!token()) { notify('Log in to upload emotes.', 'error'); return; }
        const code = overlay.querySelector('#cu-emote-code').value.trim();
        const file = overlay.querySelector('#cu-emote-file').files[0];
        if (!code || !file) { notify('Enter a code and pick an image.', 'error'); return; }
        const btn = ev.target.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            const fd = new FormData();
            fd.append('code', code);
            if (curStreamId) fd.append('stream_id', curStreamId);
            if (curChannelOwnerId) fd.append('channel_id', curChannelOwnerId);
            fd.append('image', file);
            const sizeEl = overlay.querySelector('#cu-emote-size');
            if (sizeEl) fd.append('size', sizeEl.value || '100');
            const r = await fetch('/api/emotes', { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: fd });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || 'Upload failed');
            notify(`Emote "${code}" added to the channel!`, 'success');
            overlay.querySelector('#cu-emote-code').value = '';
            overlay.querySelector('#cu-emote-file').value = '';
            loadEmoteList();
            // Force-refresh so the change applies immediately without a page reload.
            if (typeof reloadChannelEmotes === 'function' && curStreamId) reloadChannelEmotes(curStreamId);
            else if (typeof loadEmotes === 'function' && curStreamId) loadEmotes(curStreamId);
        } catch (e) { notify(e.message, 'error'); }
        finally { btn.disabled = false; }
    }

    async function submitSound(ev) {
        ev.preventDefault();
        if (!token()) { notify('Log in to upload sounds.', 'error'); return; }
        const cmd = overlay.querySelector('#cu-sound-cmd').value.trim();
        const files = Array.from(overlay.querySelector('#cu-sound-file').files || []);
        const emoteCode = (overlay.querySelector('#cu-sound-emote')?.value || '').trim();
        if (!cmd || !files.length) { notify('Enter a command and pick at least one audio file.', 'error'); return; }
        const btn = ev.target.querySelector('button[type=submit]');
        btn.disabled = true;
        let ok = 0; let firstErr = null;
        try {
            // Upload each selected file under the same command (server picks one at random on play).
            for (let i = 0; i < files.length; i++) {
                const fd = new FormData();
                fd.append('command', cmd);
                if (curStreamId) fd.append('stream_id', curStreamId);
                if (curChannelOwnerId) fd.append('channel_id', curChannelOwnerId);
                fd.append('sound', files[i]);
                if (emoteCode) fd.append('emote_code', emoteCode); // apply the emote to the command
                const r = await fetch('/api/sounds', { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: fd });
                const data = await r.json();
                if (r.ok) ok++; else if (!firstErr) firstErr = data.error || 'Upload failed';
            }
            if (ok) notify(`Added ${ok} sound${ok === 1 ? '' : 's'} to !${cmd}${firstErr ? ` (${files.length - ok} failed: ${firstErr})` : ''}`, ok === files.length ? 'success' : 'info');
            else notify(firstErr || 'Upload failed', 'error');
            overlay.querySelector('#cu-sound-cmd').value = '';
            overlay.querySelector('#cu-sound-file').value = '';
            if (overlay.querySelector('#cu-sound-emote')) overlay.querySelector('#cu-sound-emote').value = '';
            const preview = overlay.querySelector('#cu-sound-preview');
            if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
            if (_soundPreviewUrl) { try { URL.revokeObjectURL(_soundPreviewUrl); } catch {} _soundPreviewUrl = null; }
            loadSoundList();
            // Refresh the chat picker's Channel Sounds immediately (no page reload).
            if (typeof reloadChannelSounds === 'function' && curStreamId) reloadChannelSounds(curStreamId);
        } catch (e) { notify(e.message, 'error'); }
        finally { btn.disabled = false; }
    }

    // Add more files to an existing command (opens a picker prefilled with that command).
    window.__cuAddToSound = function (command) {
        const cmdEl = overlay.querySelector('#cu-sound-cmd');
        const fileEl = overlay.querySelector('#cu-sound-file');
        if (!cmdEl || !fileEl) return;
        cmdEl.value = command;
        cmdEl.dispatchEvent(new Event('input'));
        fileEl.click();
    };

    window.__cuDeleteEmote = async function (id) {
        if (!token()) return notify('Log in first.', 'error');
        try {
            const r = await fetch(`/api/emotes/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || 'Delete failed');
            notify('Emote removed.', 'success');
            loadEmoteList();
            // Force-refresh so the change applies immediately without a page reload.
            if (typeof reloadChannelEmotes === 'function' && curStreamId) reloadChannelEmotes(curStreamId);
            else if (typeof loadEmotes === 'function' && curStreamId) loadEmotes(curStreamId);
        } catch (e) { notify(e.message, 'error'); }
    };

    window.__cuDeleteSound = async function (id) {
        if (!token()) return notify('Log in first.', 'error');
        try {
            const r = await fetch(`/api/sounds/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || 'Delete failed');
            notify('Sound removed.', 'success');
            loadSoundList();
            if (typeof reloadChannelSounds === 'function' && curStreamId) reloadChannelSounds(curStreamId);
        } catch (e) { notify(e.message, 'error'); }
    };

    const refreshEmotes = () => {
        loadEmoteList();
        if (typeof reloadChannelEmotes === 'function' && curStreamId) reloadChannelEmotes(curStreamId);
        else if (typeof loadEmotes === 'function' && curStreamId) loadEmotes(curStreamId);
    };
    const refreshSounds = () => {
        loadSoundList();
        if (typeof reloadChannelSounds === 'function' && curStreamId) reloadChannelSounds(curStreamId);
    };
    const patchJson = async (url, body) => {
        const r = await fetch(url, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Update failed');
        return data;
    };
    // Channel target for command-group edits (mirrors upload's resolution).
    const soundChannelTarget = () => ({
        ...(curStreamId ? { stream_id: curStreamId } : {}),
        ...(curChannelOwnerId ? { channel_id: curChannelOwnerId } : {}),
    });

    window.__cuRenameEmote = async function (id, current) {
        if (!token()) return notify('Log in first.', 'error');
        const code = (prompt('New emote code (letters, numbers, underscores):', current) || '').trim();
        if (!code || code === current) return;
        try {
            const data = await patchJson(`/api/emotes/${id}`, { code });
            notify(`Emote renamed to :${data.code}:`, 'success');
            refreshEmotes();
        } catch (e) { notify(e.message, 'error'); }
    };

    window.__cuEmoteSize = async function (id, current) {
        if (!token()) return notify('Log in first.', 'error');
        const raw = prompt('Emote display size in percent (100 = normal):', String(current || 100));
        if (raw === null) return;
        const size = parseInt(raw, 10);
        if (!Number.isFinite(size)) return notify('Enter a number, e.g. 150', 'error');
        try {
            const data = await patchJson(`/api/emotes/${id}`, { size });
            notify(`Emote size set to ${data.size}%`, 'success');
            refreshEmotes();
        } catch (e) { notify(e.message, 'error'); }
    };

    window.__cuRenameSoundCmd = async function (cmd) {
        if (!token()) return notify('Log in first.', 'error');
        const next = (prompt(`Rename !${cmd} to (letters, numbers, underscores):`, cmd) || '').trim().replace(/^!+/, '');
        if (!next || next === cmd) return;
        try {
            const data = await patchJson('/api/sounds/command', { ...soundChannelTarget(), command: cmd, newCommand: next });
            notify(`Command renamed to !${data.command}`, 'success');
            refreshSounds();
        } catch (e) { notify(e.message, 'error'); }
    };

    window.__cuSoundEmote = async function (cmd, current) {
        if (!token()) return notify('Log in first.', 'error');
        const raw = prompt(`Emote code to attach to !${cmd} (empty to remove):`, current || '');
        if (raw === null) return;
        const emoteCode = raw.trim().replace(/^:|:$/g, '');
        try {
            await patchJson('/api/sounds/command', { ...soundChannelTarget(), command: cmd, emoteCode });
            notify(emoteCode ? `Attached :${emoteCode}: to !${cmd}` : `Removed the emote from !${cmd}`, 'success');
            refreshSounds();
        } catch (e) { notify(e.message, 'error'); }
    };

    let _previewAudio = null;
    window.__cuPreviewSound = function (url) {
        try { if (_previewAudio) { _previewAudio.pause(); } _previewAudio = new Audio(url); _previewAudio.volume = 0.7; _previewAudio.play().catch(() => {}); } catch {}
    };

    window.openChannelUploadModal = function (streamId) {
        curStreamId = resolveStreamId(streamId);
        curChannelOwnerId = resolveChannelOwnerId();
        if (!curStreamId && !curChannelOwnerId) { notify('Open a channel first to add emotes or sounds.', 'error'); return; }
        ensureStyles();
        close();
        overlay = document.createElement('div');
        overlay.className = 'cu-overlay';
        overlay.innerHTML = `
            <div class="cu-modal" role="dialog" aria-modal="true">
                <div class="cu-head">
                    <h3><i class="fa-solid fa-plus"></i> Add to this channel</h3>
                    <button class="cu-close" aria-label="Close">&times;</button>
                </div>
                <div class="cu-tabs">
                    <button class="cu-tab" data-tab="emote"><i class="fa-solid fa-face-grin-stars"></i> Emote</button>
                    <button class="cu-tab" data-tab="sound"><i class="fa-solid fa-volume-high"></i> Sound</button>
                    ${isChannelOwner() ? '<button class="cu-tab" data-tab="settings"><i class="fa-solid fa-sliders"></i> Settings</button>' : ''}
                </div>
                <div class="cu-body"></div>
            </div>`;
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('.cu-close').addEventListener('click', close);
        overlay.querySelectorAll('.cu-tab').forEach((t) => t.addEventListener('click', () => { curTab = t.dataset.tab; render(); }));
        document.body.appendChild(overlay);
        curTab = 'emote';
        render();
    };
})();
