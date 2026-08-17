/* ═══════════════════════════════════════════════════════════════
   AI Chat Viewers 2.0 — dashboard management (config, budget, roster, clone)
   API: /api/ai-viewers   ·   Card: #dash-aibot-card
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    let _rosterLoaded = false;

    window.switchAivTab = function switchAivTab(tab, btn) {
        document.querySelectorAll('#aiv-subtabs .ch-tab').forEach(b => {
            const on = b === btn || b.dataset.avtab === tab;
            b.classList.toggle('active', on);
        });
        document.querySelectorAll('#dash-aibot-card .aiv-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById('aiv-panel-' + tab);
        if (panel) panel.classList.add('active');
        if (tab === 'roster' && !_rosterLoaded) { _rosterLoaded = true; loadAivRoster(); }
    };

    function _aivToggleKeyMode() {
        const mode = document.getElementById('aiv-keymode')?.value || 'shared';
        const byo = document.getElementById('aiv-byo-fields');
        const budgetWrap = document.getElementById('aiv-budget-wrap');
        if (byo) byo.style.display = mode === 'byo' ? '' : 'none';
        if (budgetWrap) budgetWrap.style.display = mode === 'byo' ? 'none' : '';
    }
    window._aivToggleKeyMode = _aivToggleKeyMode;

    function _setUsageMeter(b) {
        const el = document.getElementById('aiv-usage-meter');
        if (!el) return;
        if (b.use_shared_key) {
            const cap = b.cap_usd || 0;
            const spent = b.spent_today_usd || 0;
            const pct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;
            const over = cap > 0 && spent >= cap;
            el.innerHTML = `
                <div class="aiv-meter-head">
                    <span><i class="fa-solid fa-gauge"></i> Today: <b>$${spent.toFixed(4)}</b>${cap > 0 ? ` / $${cap.toFixed(2)}` : ' (no cap)'}</span>
                    <span class="aiv-status ${b.active ? 'ok' : 'off'}">${b.active ? 'Active' : (over ? 'Budget reached' : 'Inactive')}</span>
                </div>
                ${cap > 0 ? `<div class="aiv-meter-bar"><div class="aiv-meter-fill ${over ? 'over' : ''}" style="width:${pct}%"></div></div>` : ''}
                ${!b.active && b.reason === 'shared_ai_disabled' ? '<p class="muted" style="font-size:0.8rem;margin-top:6px">Shared AI is currently disabled by the site admin.</p>' : ''}`;
        } else {
            el.innerHTML = `<div class="aiv-meter-head">
                <span><i class="fa-solid fa-key"></i> Using your own API key (no cap). Today: <b>$${(b.spent_today_usd || 0).toFixed(4)}</b> est.</span>
                <span class="aiv-status ${b.active ? 'ok' : 'off'}">${b.active ? 'Active' : 'Needs a key'}</span>
            </div>`;
        }
    }

    window.loadAiViewers = async function loadAiViewers() {
        const card = document.getElementById('dash-aibot-card');
        if (!card) return;
        try {
            const data = await api('/ai-viewers/config');
            const c = data.config || {};
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
            const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
            chk('aiv-enabled', c.enabled);
            set('aiv-num', c.num_ambient_bots ?? 3);
            set('aiv-pacing', c.pacing_seconds ?? 45);
            set('aiv-persona', c.persona || '');
            chk('aiv-transcribe', c.transcribe_enabled);
            chk('aiv-vision', c.vision_enabled);
            set('aiv-keymode', c.use_shared_key ? 'shared' : 'byo');
            set('aiv-budget', ((c.daily_budget_cents ?? 20) / 100).toFixed(2));
            set('aiv-byo-url', c.byo_base_url || '');
            set('aiv-byo-model', c.byo_model || 'gpt-4o-mini');
            const keyStatus = document.getElementById('aiv-byo-key-status');
            if (keyStatus) keyStatus.textContent = c.has_byo_key ? 'A key is saved. Leave blank to keep it.' : '';
            const keyEl = document.getElementById('aiv-byo-key'); if (keyEl) keyEl.value = '';
            _aivToggleKeyMode();
            if (data.budget) _setUsageMeter(data.budget);
            // Refresh roster if its tab is already open.
            if (_rosterLoaded) loadAivRoster();
        } catch (e) { /* card may not be visible */ }
    };

    window.saveAiViewers = async function saveAiViewers(btn) {
        const val = (id) => document.getElementById(id);
        const mode = val('aiv-keymode')?.value || 'shared';
        const body = {
            enabled: val('aiv-enabled')?.checked ? 1 : 0,
            num_ambient_bots: parseInt(val('aiv-num')?.value) || 0,
            pacing_seconds: parseInt(val('aiv-pacing')?.value) || 45,
            persona: val('aiv-persona')?.value || '',
            transcribe_enabled: val('aiv-transcribe')?.checked ? 1 : 0,
            vision_enabled: val('aiv-vision')?.checked ? 1 : 0,
            use_shared_key: mode === 'shared' ? 1 : 0,
            daily_budget_cents: Math.round((parseFloat(val('aiv-budget')?.value) || 0) * 100),
            byo_base_url: val('aiv-byo-url')?.value || '',
            byo_model: val('aiv-byo-model')?.value || 'gpt-4o-mini',
        };
        const keyVal = val('aiv-byo-key')?.value || '';
        if (keyVal) body.byo_key = keyVal;
        if (btn) { btn.disabled = true; }
        try {
            const data = await api('/ai-viewers/config', { method: 'PUT', body });
            toast('AI viewers saved', 'success');
            if (data.budget) _setUsageMeter(data.budget);
            const keyEl = val('aiv-byo-key'); if (keyEl) keyEl.value = '';
            const keyStatus = document.getElementById('aiv-byo-key-status');
            if (keyStatus && data.config) keyStatus.textContent = data.config.has_byo_key ? 'A key is saved. Leave blank to keep it.' : '';
        } catch (e) { toast(e.message || 'Save failed', 'error'); }
        finally { if (btn) btn.disabled = false; }
    };

    window.previewAiViewers = async function previewAiViewers(btn) {
        const box = document.getElementById('aiv-preview');
        if (btn) btn.disabled = true;
        try {
            const data = await api('/ai-viewers/preview', { method: 'POST', body: {} });
            if (box) { box.style.display = ''; box.innerHTML = `<i class="fa-solid fa-comment"></i> ${esc(data.line || '')}`; }
        } catch (e) {
            if (box) { box.style.display = ''; box.innerHTML = `<span class="muted">${esc(e.message || 'Preview failed')}</span>`; }
        } finally { if (btn) btn.disabled = false; }
    };

    // ── Roster ────────────────────────────────────────────────
    window.loadAivRoster = async function loadAivRoster() {
        const list = document.getElementById('aiv-roster-list');
        if (!list) return;
        try {
            const data = await api('/ai-viewers/roster');
            const bots = data.bots || [];
            const count = document.getElementById('aiv-roster-count');
            if (count) count.textContent = bots.length ? `(${bots.length})` : '';
            if (!bots.length) { list.innerHTML = '<p class="muted">No bots yet. Enable ambient viewers, or right-click a chatter and “AI Clone” them.</p>'; return; }
            list.innerHTML = bots.map(renderBotRow).join('');
        } catch (e) { list.innerHTML = '<p class="muted">Failed to load roster</p>'; }
    };

    function renderBotRow(b) {
        const src = b.source === 'clone'
            ? `<span class="aiv-badge clone" title="Cloned from ${esc(b.cloned_from || '')}">clone</span>`
            : `<span class="aiv-badge">ambient</span>`;
        const mem = b.memory ? `<div class="aiv-bot-memory" title="Rolling memory">🧠 ${esc(b.memory)}</div>` : '';
        const idn = b.identity ? `<div class="aiv-bot-identity">${esc(b.identity)}</div>` : (b.blurb ? `<div class="aiv-bot-identity muted">${esc(b.blurb)}</div>` : '');
        return `
        <div class="aiv-bot ${b.is_active ? '' : 'inactive'}" data-id="${b.id}">
            <div class="aiv-bot-head">
                <span class="aiv-dot" style="background:${esc(b.color)}"></span>
                <b>${esc(b.display_name)}</b> ${src}
                <span class="muted aiv-bot-meta">${b.msg_count} msgs</span>
                <span class="aiv-bot-actions">
                    <button class="btn btn-tiny btn-outline" title="Edit identity" onclick="aivEditBot(${b.id})"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn btn-tiny btn-outline" title="Clear memory" onclick="aivClearBot(${b.id})"><i class="fa-solid fa-eraser"></i></button>
                    <button class="btn btn-tiny btn-outline" title="${b.is_active ? 'Deactivate' : 'Activate'}" onclick="aivToggleBot(${b.id}, ${b.is_active ? 0 : 1})"><i class="fa-solid ${b.is_active ? 'fa-pause' : 'fa-play'}"></i></button>
                    <button class="btn btn-tiny btn-danger" title="Delete" onclick="aivDeleteBot(${b.id})"><i class="fa-solid fa-trash"></i></button>
                </span>
            </div>
            ${idn}
            ${mem}
        </div>`;
    }

    window.aivEditBot = async function aivEditBot(id) {
        const row = document.querySelector(`.aiv-bot[data-id="${id}"] .aiv-bot-identity`);
        const cur = row ? row.textContent : '';
        const next = prompt('Edit this bot’s identity / character brief:', cur || '');
        if (next === null) return;
        try { await api(`/ai-viewers/bots/${id}`, { method: 'PATCH', body: { identity: next } }); toast('Updated', 'success'); loadAivRoster(); }
        catch (e) { toast(e.message || 'Failed', 'error'); }
    };

    window.aivClearBot = async function aivClearBot(id) {
        if (!confirm('Clear this bot’s rolling memory? Its personality stays.')) return;
        try { await api(`/ai-viewers/bots/${id}/clear-memory`, { method: 'POST', body: {} }); toast('Memory cleared', 'success'); loadAivRoster(); }
        catch (e) { toast(e.message || 'Failed', 'error'); }
    };

    window.aivToggleBot = async function aivToggleBot(id, active) {
        try { await api(`/ai-viewers/bots/${id}`, { method: 'PATCH', body: { is_active: active } }); loadAivRoster(); }
        catch (e) { toast(e.message || 'Failed', 'error'); }
    };

    window.aivDeleteBot = async function aivDeleteBot(id) {
        if (!confirm('Delete this bot for good?')) return;
        try { await api(`/ai-viewers/bots/${id}`, { method: 'DELETE' }); toast('Deleted', 'success'); loadAivRoster(); }
        catch (e) { toast(e.message || 'Failed', 'error'); }
    };

    // ── Clone (called from the chat context menu) ─────────────
    window.aivCloneChatter = async function aivCloneChatter(kind, ref, displayName) {
        toast(`Cloning ${displayName || 'chatter'}…`, 'info');
        try {
            const data = await api('/ai-viewers/clone', { method: 'POST', body: { kind, ref } });
            toast(`AI clone of ${data.bot?.display_name || displayName} created`, 'success');
            _rosterLoaded = true;
            loadAivRoster();
        } catch (e) { toast(e.message || 'Clone failed', 'error'); }
    };
})();
