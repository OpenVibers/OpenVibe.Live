/* ═══════════════════════════════════════════════════════════════
   AI Chat Viewers v3 — control panel (dashboard card + Broadcast per-slot section)
   API: /api/ai-viewers   ·   Card: #dash-aibot-card
   Renders every knob from the server's settings schema, shows what the bots can
   currently see/hear, a live activity feed with the director's reasons, roster
   management, and the key/budget/model routing controls.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    let _rosterLoaded = false;
    let _cfg = null;            // last /config payload
    let _logAfter = 0;
    let _logTimer = null;
    let _statusTimer = null;
    const _dirty = {};          // pending settings edits (key → value)
    let _saveTimer = null;

    const GROUPS = [
        { id: 'activity', title: 'Activity', icon: 'fa-gauge-high', keys: ['activity', 'lines_per_min', 'director_interval_sec', 'idle_interval_sec', 'lines_per_tick', 'min_gap_sec'] },
        { id: 'social', title: 'Social', icon: 'fa-comments', keys: ['bot_to_bot_ratio', 'reply_probability', 'mention_fast_path_sec', 'reply_to_relay_chat', 'greet_first_timers', 'react_to_sounds', 'react_to_scene_changes', 'max_open_threads', 'max_thread_turns', 'thread_idle_close_sec'] },
        { id: 'senses', title: 'Senses', icon: 'fa-eye', keys: ['hear_enabled', 'hear_window_sec', 'vision_policy', 'vision_max_age_sec', 'vision_periodic_sec'] },
        { id: 'style', title: 'Style', icon: 'fa-palette', keys: ['channel_personality', 'tone', 'language', 'emote_usage', 'max_words', 'topics', 'blocklist', 'channel_memory'] },
        { id: 'behaviour', title: 'Behaviour', icon: 'fa-sliders', keys: ['quiet_from', 'quiet_to', 'quiet_tz', 'quiet_allow_replies', 'tts_enabled', 'powerchat_forward', 'memory_fold_min', 'remember_viewers'] },
    ];
    const LABELS = {
        activity: 'Activity preset', lines_per_min: 'Lines per minute', director_interval_sec: 'Director pass (active) — seconds', idle_interval_sec: 'Director pass (idle) — seconds', lines_per_tick: 'Lines per pass', min_gap_sec: 'Min gap between lines (s)',
        bot_to_bot_ratio: 'Bots talking to each other', reply_probability: 'Reply to viewers', mention_fast_path_sec: 'Streamer reply within (s)', reply_to_relay_chat: 'Reply to relayed chat (Twitch/Kick/YT/RS)', greet_first_timers: 'Greet first-time chatters', react_to_sounds: 'React to sounds', react_to_scene_changes: 'React to scene changes', max_open_threads: 'Open conversations', max_thread_turns: 'Max turns per conversation', thread_idle_close_sec: 'Close idle conversation after (s)',
        hear_enabled: 'Hear the stream (live transcript)', hear_window_sec: 'Hearing window (s)', vision_policy: 'Look at the screen', vision_max_age_sec: 'Screen view is stale after (s)', vision_periodic_sec: 'Periodic look every (s)',
        channel_personality: 'Channel personality', tone: 'Tone', language: 'Language', emote_usage: 'Emotes', max_words: 'Max words per line', topics: 'Favourite topics', blocklist: 'Never mention', channel_memory: 'Running bits (auto-maintained)',
        quiet_from: 'Quiet hours from', quiet_to: 'Quiet hours to', quiet_tz: 'Time zone', quiet_allow_replies: 'Still answer the streamer in quiet hours', tts_enabled: 'TTS for bot lines', powerchat_forward: 'Show on PowerChat overlay', memory_fold_min: 'Consolidate memories every (min)', remember_viewers: 'Use what the site knows about regulars',
    };
    const ENUM_LABELS = {
        activity: { quiet: 'Quiet (~1/min)', normal: 'Normal (~3/min)', lively: 'Lively (~5/min)', chaos: 'Chaos (~8/min)', custom: 'Custom (use sliders)' },
        vision_policy: { off: 'Never', thumbnail: 'Cached thumbnail only', when_addressed: 'Fresh frame when you address chat', periodic: 'Periodically while active' },
        emote_usage: { none: 'None', some: 'Some', lots: 'Lots' },
    };

    // ── helpers ────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);
    function ago(ms) { if (ms == null) return '—'; const s = Math.round(ms / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; }
    function money(n) { return '$' + (Number(n || 0)).toFixed(4); }
    function tsAgo(iso) { if (!iso) return ''; const t = new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z')).getTime(); return ago(Date.now() - t); }

    window.switchAivTab = function switchAivTab(tab, btn) {
        document.querySelectorAll('#aiv-subtabs .ch-tab').forEach(b => b.classList.toggle('active', b === btn || b.dataset.avtab === tab));
        document.querySelectorAll('#dash-aibot-card .aiv-panel').forEach(p => p.classList.remove('active'));
        const panel = $('aiv-panel-' + tab);
        if (panel) panel.classList.add('active');
        if (tab === 'roster' && !_rosterLoaded) { _rosterLoaded = true; loadAivRoster(); }
        if (tab === 'activity') startActivity(); else stopActivity();
    };

    function _aivToggleKeyMode() {
        const mode = $('aiv-keymode')?.value || 'shared';
        const byo = $('aiv-byo-fields'); const budgetWrap = $('aiv-budget-wrap');
        if (byo) byo.style.display = mode === 'byo' ? '' : 'none';
        if (budgetWrap) budgetWrap.style.display = mode === 'byo' ? 'none' : '';
    }
    window._aivToggleKeyMode = _aivToggleKeyMode;

    // ── status / meter ─────────────────────────────────────────
    function renderStatus(st, b) {
        const pill = $('aiv-status-pill');
        if (pill) {
            let cls = 'off', txt = 'Off';
            if (st && st.kill_switch) { cls = 'off'; txt = 'Disabled by admin'; }
            else if (st && st.running) { cls = st.paused ? 'warn' : (st.mode === 'normal' ? 'ok' : 'warn'); txt = st.paused ? 'Paused' : `Running · ${st.bots} viewers · ${st.mode.replace('_', ' ')}`; }
            else if (_cfg && _cfg.config && _cfg.config.enabled) { cls = 'warn'; txt = st && st.budget_active === false ? `Idle · ${String(st.budget_reason || st.mode || '').replace(/_/g, ' ')}` : 'Enabled · waiting for a live stream'; }
            pill.className = `aiv-status ${cls}`; pill.textContent = txt;
        }
        const senses = $('aiv-senses');
        if (senses) {
            if (!st || !st.running) senses.innerHTML = `<span class="muted">${st && st.timeline_enabled === false ? 'Live transcript is off site-wide (admin: ai_timeline_enabled) — the bots will only see chat and the screen.' : 'Go live to see what the bots can hear and see.'}</span>`;
            else senses.innerHTML = `
                <span title="Live transcript"><i class="fa-solid fa-ear-listen"></i> heard ${st.senses.heard_lines ? `${st.senses.heard_lines} lines, latest ${ago(st.senses.heard_age_ms)}` : (st.timeline_enabled ? 'nothing recent' : 'off')}</span>
                <span title="Latest screen analysis"><i class="fa-solid fa-eye"></i> seen ${st.senses.seen_age_ms != null ? ago(st.senses.seen_age_ms) : 'never'}${st.senses.seen_text ? ` — ${esc(st.senses.seen_text.slice(0, 90))}` : ''}</span>
                <span title="Cached prompt prefix"><i class="fa-solid fa-bolt"></i> context ${st.senses.stable_prefix_chars ? `${Math.round(st.senses.stable_prefix_chars / 4)} tokens cached` : 'building'}</span>
                <span><i class="fa-solid fa-clock"></i> next pass ${st.next_tick_in_ms != null ? `in ${Math.round(st.next_tick_in_ms / 1000)}s` : '—'} · ${st.lines_last_minute}/min · bot↔bot ${Math.round((st.bot_share || 0) * 100)}%</span>`;
        }
        if (b) _setUsageMeter(b, st);
    }
    function _setUsageMeter(b, st) {
        const el = $('aiv-usage-meter'); if (!el) return;
        const mode = st && st.mode ? st.mode : (b.active ? 'normal' : 'silent');
        const ladder = { normal: 'normal', economy: 'economy (fewer lines)', replies_only: 'replies only', streamer_only: 'streamer replies only', silent: 'silent' }[mode] || mode;
        if (b.use_shared_key) {
            const cap = b.cap_usd || 0, spent = b.spent_today_usd || 0;
            const pct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;
            el.innerHTML = `<div class="aiv-meter-head"><span><i class="fa-solid fa-gauge"></i> Today: <b>${money(spent)}</b>${cap > 0 ? ` / $${cap.toFixed(2)}` : ' (no cap)'} · mode: <b>${ladder}</b></span><span class="aiv-status ${b.active ? 'ok' : 'off'}">${b.active ? 'Active' : (String(b.reason || 'inactive').replace(/_/g, ' '))}</span></div>
                ${cap > 0 ? `<div class="aiv-meter-bar"><div class="aiv-meter-fill ${pct >= 100 ? 'over' : pct >= 80 ? 'warn' : ''}" style="width:${pct}%"></div></div>` : ''}
                <p class="muted" style="font-size:0.75rem;margin-top:6px">As spend approaches the cap the viewers slow down (60%), then only reply (80%), then only answer you (95%), then go quiet.</p>`;
        } else {
            el.innerHTML = `<div class="aiv-meter-head"><span><i class="fa-solid fa-key"></i> Your own key (no cap). Today: <b>${money(b.spent_today_usd)}</b></span><span class="aiv-status ${b.active ? 'ok' : 'off'}">${b.active ? 'Active' : 'Needs a key'}</span></div>`;
        }
    }

    // ── settings form (schema-driven) ─────────────────────────
    function fieldHtml(sp, val) {
        const key = sp.key, label = LABELS[key] || key, help = sp.help || '';
        const id = `aivs-${key}`;
        if (sp.type === 'bool') return `<label class="staff-inline-toggle aiv-field" title="${esc(help)}"><input type="checkbox" id="${id}" data-skey="${key}" ${val ? 'checked' : ''} onchange="aivSet('${key}', this.checked)"> <span>${esc(label)}</span></label>`;
        if (sp.type === 'enum') {
            const opts = (sp.values || []).filter(v => v !== '' || key === 'engine').map(v => `<option value="${esc(v)}" ${String(val) === String(v) ? 'selected' : ''}>${esc((ENUM_LABELS[key] || {})[v] || v || '(default)')}</option>`).join('');
            return `<label class="aiv-field" title="${esc(help)}"><span>${esc(label)}</span><select id="${id}" data-skey="${key}" class="form-input" onchange="aivSet('${key}', this.value)">${opts}</select></label>`;
        }
        if (sp.type === 'int' || sp.type === 'num') {
            const step = sp.type === 'num' ? (sp.max <= 1 ? 0.05 : 0.5) : 1;
            const pct = key === 'bot_to_bot_ratio' || key === 'reply_probability';
            return `<label class="aiv-field aiv-slider" title="${esc(help)}"><span>${esc(label)} <b id="${id}-val">${pct ? Math.round(val * 100) + '%' : val}</b></span>
                <input type="range" id="${id}" data-skey="${key}" min="${sp.min}" max="${sp.max}" step="${step}" value="${val}" oninput="document.getElementById('${id}-val').textContent=${pct ? "Math.round(this.value*100)+'%'" : 'this.value'}" onchange="aivSet('${key}', ${sp.type === 'num' ? 'parseFloat(this.value)' : 'parseInt(this.value,10)'})"></label>`;
        }
        if (key === 'channel_personality' || key === 'channel_memory' || key === 'topics' || key === 'blocklist') return `<label class="aiv-field" title="${esc(help)}"><span>${esc(label)}</span><textarea id="${id}" data-skey="${key}" class="form-input" rows="${key === 'channel_personality' ? 3 : 2}" onchange="aivSet('${key}', this.value)">${esc(val || '')}</textarea><span class="ai-bot-hint">${esc(help)}</span></label>`;
        return `<label class="aiv-field" title="${esc(help)}"><span>${esc(label)}</span><input type="text" id="${id}" data-skey="${key}" class="form-input" value="${esc(val == null ? '' : val)}" placeholder="${key.startsWith('quiet_') && key !== 'quiet_tz' ? 'HH:MM' : ''}" onchange="aivSet('${key}', this.value)"></label>`;
    }
    function renderSettings() {
        const root = $('aiv-settings-root'); if (!root || !_cfg) return;
        const s = _cfg.settings || {}; const byKey = {}; (_cfg.schema || []).forEach(sp => { byKey[sp.key] = sp; });
        root.innerHTML = `
            <div class="aiv-topline">
                <label class="staff-inline-toggle"><input type="checkbox" id="aiv-enabled" ${_cfg.config && _cfg.config.enabled ? 'checked' : ''} onchange="aivSetEnabled(this.checked)"> <b>Enable AI chat viewers</b></label>
                <label class="aiv-field aiv-inline"><span>Viewers</span><input type="range" id="aivs-roster_size" min="0" max="${byKey.roster_size ? byKey.roster_size.max : 12}" step="1" value="${s.roster_size ?? 3}" oninput="document.getElementById('aivs-roster_size-val').textContent=this.value" onchange="aivSet('roster_size', parseInt(this.value,10))"><b id="aivs-roster_size-val">${s.roster_size ?? 3}</b></label>
                <span id="aiv-status-pill" class="aiv-status off">…</span>
            </div>
            <div class="aiv-senses" id="aiv-senses"></div>
            ${GROUPS.map((g, i) => `<details class="aiv-group" ${i === 0 ? 'open' : ''}><summary><i class="fa-solid ${g.icon}"></i> ${g.title}</summary><div class="aiv-group-body">${g.keys.filter(k => byKey[k]).map(k => fieldHtml(byKey[k], s[k])).join('')}</div></details>`).join('')}
            <div class="ai-bot-actions">
                <button class="btn btn-outline btn-small" onclick="previewAiViewers(this)"><i class="fa-solid fa-wand-magic-sparkles"></i> Preview what they'd say now</button>
                <span class="muted" id="aiv-save-state" style="font-size:0.8rem"></span>
            </div>
            <div id="aiv-preview" class="ai-bot-preview" style="display:none;"></div>`;
        renderStatus(_cfg.status, _cfg.budget);
    }

    // Debounced write-through save of individual settings.
    window.aivSet = function aivSet(key, value) {
        _dirty[key] = value;
        const st = $('aiv-save-state'); if (st) st.textContent = 'Saving…';
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(flushSettings, 600);
    };
    async function flushSettings() {
        const settings = { ..._dirty }; for (const k of Object.keys(_dirty)) delete _dirty[k];
        if (!Object.keys(settings).length) return;
        try {
            const data = await api('/ai-viewers/config', { method: 'PUT', body: { settings } });
            _cfg = { ..._cfg, ...data };
            const st = $('aiv-save-state'); if (st) { st.textContent = 'Saved ✓'; setTimeout(() => { if (st.textContent === 'Saved ✓') st.textContent = ''; }, 2500); }
            renderStatus(data.status, data.budget);
            if (settings.activity && settings.activity !== 'custom' && data.settings) { const el = $('aivs-lines_per_min'); if (el) { el.value = data.settings.lines_per_min; const v = $('aivs-lines_per_min-val'); if (v) v.textContent = data.settings.lines_per_min; } }
        } catch (e) { toast(e.message || 'Save failed', 'error'); }
    }
    window.aivSetEnabled = async function aivSetEnabled(on) {
        try { const data = await api('/ai-viewers/config', { method: 'PUT', body: { enabled: on ? 1 : 0 } }); _cfg = { ..._cfg, ...data }; renderStatus(data.status, data.budget); toast(on ? 'AI viewers enabled — they join your next live stream (or now, if you are live).' : 'AI viewers disabled', 'success'); }
        catch (e) { toast(e.message || 'Failed', 'error'); }
    };

    // ── activity feed ──────────────────────────────────────────
    function logRow(r) {
        const icon = { line: 'fa-comment', tick: 'fa-clapperboard', skip: 'fa-forward', mention: 'fa-bullhorn', fold: 'fa-brain', vision: 'fa-eye', degrade: 'fa-gauge', pause: 'fa-pause', error: 'fa-triangle-exclamation', info: 'fa-circle-info' }[r.event] || 'fa-circle';
        const cost = r.cost_usd != null ? `<span class="muted" title="${r.tokens_in || 0} in (${r.tokens_cached || 0} cached) / ${r.tokens_out || 0} out · ${esc(r.model || '')}">${money(r.cost_usd)}${r.tokens_in ? ` · ${Math.round(((r.tokens_cached || 0) / r.tokens_in) * 100)}% cached` : ''}</span>` : '';
        const who = r.bot_username ? `<b>${esc(r.bot_username)}</b>${r.target ? ` <span class="muted">→ ${esc(r.target)}</span>` : ''}` : `<span class="muted">${esc(r.event)}</span>`;
        return `<div class="aiv-log-row aiv-log-${esc(r.event)}"><i class="fa-solid ${icon}"></i><div><div>${who} ${r.text ? `— ${esc(r.text)}` : ''}</div>${r.reason ? `<div class="muted aiv-log-reason">${esc(r.reason)}</div>` : ''}</div><div class="aiv-log-meta">${cost}<span class="muted">${tsAgo(r.created_at)}</span></div></div>`;
    }
    async function pollLog() {
        const box = $('aiv-log'); if (!box) return;
        try {
            const data = await api(`/ai-viewers/log?after=${_logAfter}&limit=60`);
            const rows = data.rows || [];
            if (rows.length) {
                if (_logAfter === 0) box.innerHTML = '';
                for (const r of rows) { box.insertAdjacentHTML('afterbegin', logRow(r)); _logAfter = Math.max(_logAfter, r.id); }
                while (box.children.length > 120) box.lastChild.remove();
            } else if (_logAfter === 0 && !box.children.length) box.innerHTML = '<p class="muted">Nothing yet — the feed fills in while you are live.</p>';
        } catch { /* */ }
    }
    async function pollStatus() {
        try { const d = await api('/ai-viewers/status'); renderStatus(d.status, d.budget); const s = $('aiv-hour-stats'); if (s && d.last_hour) s.textContent = `Last hour: ${d.last_hour.lines || 0} lines · ${d.last_hour.ticks || 0} passes · ${d.last_hour.skips || 0} skipped · ${money(d.last_hour.cost_usd)}${d.last_hour.tokens_in ? ` · ${Math.round(((d.last_hour.tokens_cached || 0) / d.last_hour.tokens_in) * 100)}% cached` : ''}`; } catch { /* */ }
    }
    function startActivity() { stopActivity(); pollLog(); pollStatus(); _logTimer = setInterval(pollLog, 5000); _statusTimer = setInterval(pollStatus, 10000); }
    function stopActivity() { clearInterval(_logTimer); clearInterval(_statusTimer); _logTimer = _statusTimer = null; }
    window.aivCommand = async function aivCommand(cmd, btn) {
        if (btn) btn.disabled = true;
        try { const d = await api(`/ai-viewers/${cmd}`, { method: 'POST', body: {} }); toast(d.message || 'ok', 'success'); renderStatus(d.status, null); pollLog(); }
        catch (e) { toast(e.message || 'Failed', 'error'); } finally { if (btn) btn.disabled = false; }
    };

    // ── load / preview ─────────────────────────────────────────
    window.loadAiViewers = async function loadAiViewers() {
        const card = $('dash-aibot-card'); if (!card) return;
        try {
            _cfg = await api('/ai-viewers/config');
            const c = _cfg.config || {}, s = _cfg.settings || {};
            renderSettings();
            const set = (id, v) => { const el = $(id); if (el) el.value = v; };
            set('aiv-keymode', c.use_shared_key ? 'shared' : 'byo');
            set('aiv-budget', ((c.daily_budget_cents ?? 20) / 100).toFixed(2));
            set('aiv-byo-url', c.byo_base_url || ''); set('aiv-byo-model', c.byo_model || 'gpt-4o-mini');
            for (const role of ['chat', 'vision', 'director', 'summary']) set(`aiv-byo-model-${role}`, (s.byo && s.byo[`model_${role}`]) || '');
            set('aiv-byo-provider', (s.byo && s.byo.provider) || 'openai');
            const keyStatus = $('aiv-byo-key-status'); if (keyStatus) keyStatus.textContent = c.has_byo_key ? 'A key is saved. Leave blank to keep it.' : '';
            const keyEl = $('aiv-byo-key'); if (keyEl) keyEl.value = '';
            _aivToggleKeyMode();
            if (_rosterLoaded) loadAivRoster();
            if ($('aiv-panel-activity')?.classList.contains('active')) startActivity();
        } catch (e) { /* card may not be visible */ }
    };

    window.saveAiViewers = async function saveAiViewers(btn) {
        const val = (id) => $(id);
        const mode = val('aiv-keymode')?.value || 'shared';
        const body = {
            use_shared_key: mode === 'shared' ? 1 : 0,
            daily_budget_cents: Math.round((parseFloat(val('aiv-budget')?.value) || 0) * 100),
            byo_base_url: val('aiv-byo-url')?.value || '',
            byo_model: val('aiv-byo-model')?.value || 'gpt-4o-mini',
            settings: { byo: { provider: val('aiv-byo-provider')?.value || 'openai' } },
        };
        for (const role of ['chat', 'vision', 'director', 'summary']) body.settings.byo[`model_${role}`] = val(`aiv-byo-model-${role}`)?.value || '';
        const keyVal = val('aiv-byo-key')?.value || ''; if (keyVal) body.byo_key = keyVal;
        if (btn) btn.disabled = true;
        try {
            const data = await api('/ai-viewers/config', { method: 'PUT', body });
            _cfg = { ..._cfg, ...data };
            toast('Saved', 'success'); renderStatus(data.status, data.budget);
            const keyEl = val('aiv-byo-key'); if (keyEl) keyEl.value = '';
            const keyStatus = $('aiv-byo-key-status'); if (keyStatus && data.config) keyStatus.textContent = data.config.has_byo_key ? 'A key is saved. Leave blank to keep it.' : '';
        } catch (e) { toast(e.message || 'Save failed', 'error'); }
        finally { if (btn) btn.disabled = false; }
    };
    window.testAivByo = async function testAivByo(btn) {
        const out = $('aiv-byo-test-out'); if (btn) btn.disabled = true; if (out) out.textContent = 'Testing…';
        try {
            const d = await api('/ai-viewers/byo/test', { method: 'POST', body: { byo_key: $('aiv-byo-key')?.value || '', byo_base_url: $('aiv-byo-url')?.value || '', byo_model: $('aiv-byo-model')?.value || '' } });
            if (out) out.innerHTML = d.ok ? `<span style="color:#4ade80">● OK — ${esc(d.model || '')} answered in ${d.latencyMs} ms</span>` : `<span style="color:#f87171">● ${esc(d.error || 'failed')}</span>`;
        } catch (e) { if (out) out.innerHTML = `<span style="color:#f87171">${esc(e.message)}</span>`; } finally { if (btn) btn.disabled = false; }
    };

    window.previewAiViewers = async function previewAiViewers(btn) {
        const box = $('aiv-preview'); if (btn) btn.disabled = true;
        if (box) { box.style.display = ''; box.innerHTML = '<span class="muted"><i class="fa-solid fa-spinner fa-spin"></i> Asking the director… (this is a dry run — nothing is posted)</span>'; }
        try {
            const d = await api('/ai-viewers/preview', { method: 'POST', body: {} });
            if (!box) return;
            if (d.line) { box.innerHTML = `<i class="fa-solid fa-comment"></i> ${esc(d.line)}`; return; }
            const p = d.plan;
            box.innerHTML = `
                <div class="muted" style="font-size:0.78rem">Context: ${d.context ? `${Math.round(d.context.stable_chars / 4)} tokens stable (cached) + ${Math.round(d.context.volatile_chars / 4)} tokens fresh · heard ${d.context.sources.heardAgeMs != null ? ago(d.context.sources.heardAgeMs) : 'nothing'} · seen ${d.context.sources.seenAgeMs != null ? ago(d.context.sources.seenAgeMs) : 'never'} · ${d.context.sources.chatLines} chat lines · ${d.context.sources.people} people known` : ''}${d.cost != null ? ` · this preview cost ${money(d.cost)}${d.usage && d.usage.cached ? ` (${Math.round((d.usage.cached / d.usage.input) * 100)}% cached)` : ''}` : ''}</div>
                ${p && p.lines && p.lines.length ? p.lines.map(l => `<div class="aiv-preview-line"><b>${esc(l.bot)}</b> <span class="muted">→ ${esc(l.target)}${l.reply_to ? ' @' + esc(l.reply_to) : ''} · +${Math.round((l.delay_ms || 0) / 1000)}s</span><br>${esc(l.text)}<br><span class="muted aiv-log-reason">${esc(l.reason || '')}</span></div>`).join('') : `<p class="muted">The director would stay quiet right now${p && p.notes ? ` — ${esc(p.notes)}` : ''}.</p>`}
                <details style="margin-top:6px"><summary class="muted" style="cursor:pointer;font-size:0.78rem">What the bots were shown</summary><pre class="aiv-pre">${esc(d.stable_preview || '')}\n\n---\n\n${esc(d.volatile_preview || '')}</pre></details>`;
        } catch (e) { if (box) box.innerHTML = `<span class="muted">${esc(e.message || 'Preview failed')}</span>`; }
        finally { if (btn) btn.disabled = false; }
    };

    // ── roster ────────────────────────────────────────────────
    window.loadAivRoster = async function loadAivRoster() {
        const list = $('aiv-roster-list'); if (!list) return;
        try {
            const data = await api('/ai-viewers/roster');
            const bots = data.bots || [];
            const count = $('aiv-roster-count'); if (count) count.textContent = bots.length ? `(${bots.length})` : '';
            if (!bots.length) { list.innerHTML = '<p class="muted">No viewers yet. Set the roster size above, or right-click a chatter and “AI Clone” them.</p>'; return; }
            const muted = new Set((((_cfg || {}).settings || {}).runtime || {}).muted || []);
            list.innerHTML = bots.map(b => renderBotRow(b, muted.has(String(b.username || b.display_name).toLowerCase()))).join('');
        } catch (e) { list.innerHTML = '<p class="muted">Failed to load roster</p>'; }
    };
    function renderBotRow(b, isMuted) {
        const src = b.source === 'clone' ? `<span class="aiv-badge clone" title="Cloned from ${esc(b.cloned_from || '')}">clone</span>` : `<span class="aiv-badge">ambient</span>`;
        const mem = b.memory ? `<div class="aiv-bot-memory" title="Rolling memory">🧠 ${esc(b.memory)}</div>` : '';
        const idn = b.identity ? `<div class="aiv-bot-identity">${esc(b.identity)}</div>` : (b.blurb ? `<div class="aiv-bot-identity muted">${esc(b.blurb)}</div>` : '');
        return `<div class="aiv-bot ${b.is_active ? '' : 'inactive'} ${isMuted ? 'muted-bot' : ''}" data-id="${b.id}">
            <div class="aiv-bot-head">
                <span class="aiv-dot" style="background:${esc(b.color)}"></span><b>${esc(b.display_name)}</b> ${src}${isMuted ? '<span class="aiv-badge" title="Muted by a mod">muted</span>' : ''}
                <span class="muted aiv-bot-meta">${b.msg_count} msgs</span>
                <span class="aiv-bot-actions">
                    <button class="btn btn-tiny btn-outline" title="Edit identity" onclick="aivEditBot(${b.id})"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn btn-tiny btn-outline" title="${isMuted ? 'Unmute' : 'Mute (mods can also /ai mute name)'}" onclick="aivMuteBot(${b.id}, ${isMuted ? 0 : 1})"><i class="fa-solid ${isMuted ? 'fa-volume-high' : 'fa-volume-xmark'}"></i></button>
                    <button class="btn btn-tiny btn-outline" title="Clear memory" onclick="aivClearBot(${b.id})"><i class="fa-solid fa-eraser"></i></button>
                    <button class="btn btn-tiny btn-outline" title="${b.is_active ? 'Deactivate' : 'Activate'}" onclick="aivToggleBot(${b.id}, ${b.is_active ? 0 : 1})"><i class="fa-solid ${b.is_active ? 'fa-pause' : 'fa-play'}"></i></button>
                    <button class="btn btn-tiny btn-danger" title="Delete" onclick="aivDeleteBot(${b.id})"><i class="fa-solid fa-trash"></i></button>
                </span>
            </div>${idn}${mem}</div>`;
    }
    window.aivEditBot = async function aivEditBot(id) {
        const row = document.querySelector(`.aiv-bot[data-id="${id}"] .aiv-bot-identity`);
        const next = prompt('Edit this viewer’s identity / character brief:', row ? row.textContent : '');
        if (next === null) return;
        try { await api(`/ai-viewers/bots/${id}`, { method: 'PATCH', body: { identity: next } }); toast('Updated', 'success'); loadAivRoster(); } catch (e) { toast(e.message || 'Failed', 'error'); }
    };
    window.aivMuteBot = async function aivMuteBot(id, mute) {
        try { const d = await api(`/ai-viewers/bots/${id}/${mute ? 'mute' : 'unmute'}`, { method: 'POST', body: {} }); toast(d.message || 'ok', 'success'); _cfg = await api('/ai-viewers/config'); loadAivRoster(); } catch (e) { toast(e.message || 'Failed', 'error'); }
    };
    window.aivClearBot = async function aivClearBot(id) {
        if (!confirm('Clear this viewer’s rolling memory? Its personality stays.')) return;
        try { await api(`/ai-viewers/bots/${id}/clear-memory`, { method: 'POST', body: {} }); toast('Memory cleared', 'success'); loadAivRoster(); } catch (e) { toast(e.message || 'Failed', 'error'); }
    };
    window.aivToggleBot = async function aivToggleBot(id, active) {
        try { await api(`/ai-viewers/bots/${id}`, { method: 'PATCH', body: { is_active: active } }); loadAivRoster(); } catch (e) { toast(e.message || 'Failed', 'error'); }
    };
    window.aivDeleteBot = async function aivDeleteBot(id) {
        if (!confirm('Delete this viewer for good?')) return;
        try { await api(`/ai-viewers/bots/${id}`, { method: 'DELETE' }); toast('Deleted', 'success'); loadAivRoster(); } catch (e) { toast(e.message || 'Failed', 'error'); }
    };
    window.aivCloneChatter = async function aivCloneChatter(kind, ref, displayName) {
        toast(`Cloning ${displayName || 'chatter'}…`, 'info');
        try { const data = await api('/ai-viewers/clone', { method: 'POST', body: { kind, ref } }); toast(`AI clone of ${data.bot?.display_name || displayName} created`, 'success'); _rosterLoaded = true; loadAivRoster(); }
        catch (e) { toast(e.message || 'Clone failed', 'error'); }
    };

    // ── Broadcast workspace: compact per-slot section ──────────
    window.aivRenderSlotSection = async function aivRenderSlotSection(container, managedStreamId) {
        if (!container) return;
        try {
            const d = await api('/ai-viewers/config');
            _cfg = _cfg || d;
            const s = d.settings || {}, st = d.status || {}, c = d.config || {};
            const slotOn = !(s.slots && s.slots[String(managedStreamId)] === false);
            const pill = st.kill_switch ? ['off', 'Disabled by admin'] : st.running ? [st.paused ? 'warn' : 'ok', st.paused ? 'Paused' : `Running · ${st.bots} viewers · ${String(st.mode).replace('_', ' ')}`] : c.enabled ? ['warn', 'Enabled · joins when live'] : ['off', 'Off'];
            container.innerHTML = `
                <div class="aiv-slot-head"><span class="aiv-status ${pill[0]}">${esc(pill[1])}</span>
                    <label class="staff-inline-toggle"><input type="checkbox" ${c.enabled ? 'checked' : ''} onchange="aivSetEnabled(this.checked)"> <b>AI viewers on for my channel</b></label>
                    <label class="staff-inline-toggle"><input type="checkbox" ${slotOn ? 'checked' : ''} onchange="aivSetSlot('${managedStreamId}', this.checked)"> <span>…and on this slot</span></label>
                </div>
                <div class="aiv-slot-grid">
                    <label><span>Activity</span><select class="form-input form-input-sm" onchange="aivSet('activity', this.value)">${['quiet', 'normal', 'lively', 'chaos', 'custom'].map(v => `<option value="${v}" ${s.activity === v ? 'selected' : ''}>${ENUM_LABELS.activity[v]}</option>`).join('')}</select></label>
                    <label><span>Viewers <b id="aivslot-roster-val">${s.roster_size ?? 3}</b></span><input type="range" min="0" max="12" step="1" value="${s.roster_size ?? 3}" oninput="document.getElementById('aivslot-roster-val').textContent=this.value" onchange="aivSet('roster_size', parseInt(this.value,10))"></label>
                    <label><span>Bots talking to each other <b id="aivslot-ratio-val">${Math.round((s.bot_to_bot_ratio || 0) * 100)}%</b></span><input type="range" min="0" max="0.8" step="0.05" value="${s.bot_to_bot_ratio ?? 0.3}" oninput="document.getElementById('aivslot-ratio-val').textContent=Math.round(this.value*100)+'%'" onchange="aivSet('bot_to_bot_ratio', parseFloat(this.value))"></label>
                    <label><span>Look at the screen</span><select class="form-input form-input-sm" onchange="aivSet('vision_policy', this.value)">${['off', 'thumbnail', 'when_addressed', 'periodic'].map(v => `<option value="${v}" ${s.vision_policy === v ? 'selected' : ''}>${ENUM_LABELS.vision_policy[v]}</option>`).join('')}</select></label>
                </div>
                <div class="bc-ws-toggle-grid" style="margin-top:8px">
                    <label class="bc-toggle-label bc-ws-toggle-chip"><input type="checkbox" ${s.hear_enabled ? 'checked' : ''} onchange="aivSet('hear_enabled', this.checked)"><i class="fa-solid fa-ear-listen"></i><span>Hear the stream</span></label>
                    <label class="bc-toggle-label bc-ws-toggle-chip"><input type="checkbox" ${s.tts_enabled ? 'checked' : ''} onchange="aivSet('tts_enabled', this.checked)"><i class="fa-solid fa-volume-high"></i><span>TTS</span></label>
                    <label class="bc-toggle-label bc-ws-toggle-chip"><input type="checkbox" ${s.powerchat_forward ? 'checked' : ''} onchange="aivSet('powerchat_forward', this.checked)"><i class="fa-solid fa-bolt"></i><span>PowerChat</span></label>
                    <label class="bc-toggle-label bc-ws-toggle-chip"><input type="checkbox" ${s.reply_to_relay_chat ? 'checked' : ''} onchange="aivSet('reply_to_relay_chat', this.checked)"><i class="fa-solid fa-tower-broadcast"></i><span>Reply to relayed chat</span></label>
                </div>
                <div class="ai-bot-actions" style="margin-top:8px">
                    <button class="btn btn-small btn-outline" onclick="aivCommand('${st.paused ? 'resume' : 'pause'}', this)"><i class="fa-solid ${st.paused ? 'fa-play' : 'fa-pause'}"></i> ${st.paused ? 'Resume' : 'Pause'}</button>
                    <button class="btn btn-small btn-outline" onclick="aivCommand('nudge', this)" ${st.running ? '' : 'disabled'}><i class="fa-solid fa-hand-point-right"></i> Nudge</button>
                    <a class="btn btn-small btn-outline" href="/dashboard#chatai" onclick="if(typeof navigate==='function'){event.preventDefault();navigate('/dashboard');setTimeout(()=>{const b=document.querySelector('#dash-tabs .ch-tab[data-dtab=chatai]'); if(b) b.click();},300);}"><i class="fa-solid fa-sliders"></i> All settings, roster &amp; activity feed</a>
                </div>
                <div class="muted" style="font-size:0.78rem;margin-top:6px">Mods can type <code>/ai pause</code>, <code>/ai resume</code>, <code>/ai mute name</code> in chat. The bots always answer you when you address chat or say a viewer's name.</div>`;
        } catch (e) { container.innerHTML = `<span class="muted">AI viewers unavailable: ${esc(e.message)}</span>`; }
    };
    window.aivSetSlot = function aivSetSlot(msId, on) { aivSet('slots', { [String(msId)]: !!on }); };
})();
