/**
 * ai-chatbot-settings.js — Dashboard config panel for AI chat viewers.
 * Loads/saves via /api/ai-chatbot. The API token is write-only: the server
 * returns only a masked hint, and a blank token field preserves the stored one.
 */
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    // When a token is already saved, the field shows this masked sentinel (so it clearly
    // reads as "a key is set" instead of an empty box that looks unsaved). We only send a
    // new api_token when the user actually types one — the sentinel means "keep existing".
    const TOKEN_SENTINEL = '••••••••••••••••';

    // The literal text the user typed into the token field, or '' to mean "no change".
    function currentTokenInput() {
        const el = $('aibot-token');
        if (!el) return '';
        const v = el.value;
        if (v === TOKEN_SENTINEL) return '';        // unchanged → preserve stored token
        return String(v || '').trim();
    }

    function collect() {
        const body = {
            enabled: !!$('aibot-enabled')?.checked,
            base_url: $('aibot-base-url')?.value.trim() || '',
            model: $('aibot-model')?.value.trim() || '',
            num_bots: Number($('aibot-num')?.value || 3),
            post_interval_seconds: Number($('aibot-interval')?.value || 45),
            persona: $('aibot-persona')?.value || '',
            transcribe_enabled: !!$('aibot-transcribe')?.checked,
            transcribe_model: $('aibot-transcribe-model')?.value.trim() || '',
            vision_enabled: !!$('aibot-vision')?.checked,
        };
        const token = currentTokenInput();
        if (token) body.api_token = token;   // only send when the user typed a NEW key
        return body;
    }

    window.loadAiChatbotConfig = async function loadAiChatbotConfig() {
        if (!$('dash-aibot-card')) return;
        try {
            const data = await api('/ai-chatbot');
            const c = data.config || {};
            if ($('aibot-enabled')) $('aibot-enabled').checked = !!c.enabled;
            if ($('aibot-base-url')) $('aibot-base-url').value = c.base_url || 'https://api.openai.com/v1';
            if ($('aibot-model')) $('aibot-model').value = c.model || 'gpt-4o-mini';
            if ($('aibot-num')) $('aibot-num').value = c.num_bots ?? 3;
            if ($('aibot-interval')) $('aibot-interval').value = c.post_interval_seconds ?? 45;
            if ($('aibot-persona')) $('aibot-persona').value = c.persona || '';
            if ($('aibot-transcribe')) $('aibot-transcribe').checked = !!c.transcribe_enabled;
            if ($('aibot-transcribe-model')) $('aibot-transcribe-model').value = c.transcribe_model || 'whisper-1';
            if ($('aibot-vision')) $('aibot-vision').checked = !!c.vision_enabled;
            const status = $('aibot-token-status');
            const selfHosted = !!(c.base_url && !/api\.openai\.com/i.test(c.base_url));
            if (status) {
                status.innerHTML = c.has_token
                    ? `<span style="color:#53fc18">✓ Key saved</span> (${c.api_token_masked}). The dots below mean it's stored — leave them to keep it, or type a new key to replace.`
                    : selfHosted
                        ? 'No token needed for a self-hosted server (Ollama / LM Studio) — leave this blank.'
                        : 'No key saved yet — paste your API key above.';
            }
            // Show a masked sentinel when a key exists so the field never looks "empty/unsaved".
            const tokenEl = $('aibot-token');
            if (tokenEl) {
                tokenEl.value = c.has_token ? TOKEN_SENTINEL : '';
                tokenEl.dataset.hasToken = c.has_token ? '1' : '';
                if (!tokenEl._sentinelWired) {
                    tokenEl._sentinelWired = true;
                    // Clear the placeholder-dots when the user goes to type a real key…
                    tokenEl.addEventListener('focus', () => { if (tokenEl.value === TOKEN_SENTINEL) tokenEl.value = ''; });
                    // …and restore them if they left it untouched (so it still reads as "saved").
                    tokenEl.addEventListener('blur', () => { if (!tokenEl.value && tokenEl.dataset.hasToken === '1') tokenEl.value = TOKEN_SENTINEL; });
                }
            }
        } catch (err) {
            // Not logged in / no dashboard — silently ignore
        }
    };

    window.saveAiChatbot = async function saveAiChatbot(btn) {
        if (btn) btn.disabled = true;
        try {
            await api('/ai-chatbot', { method: 'PUT', body: collect() });
            toast('AI chat viewer settings saved', 'success');
            await window.loadAiChatbotConfig();
        } catch (err) {
            toast(err.message || 'Failed to save', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    };

    window.testAiChatbot = async function testAiChatbot(btn) {
        if (btn) btn.disabled = true;
        try {
            const b = collect();
            const r = await api('/ai-chatbot/validate', { method: 'POST', body: { base_url: b.base_url, model: b.model, api_token: b.api_token } });
            if (r.ok) toast('AI connection OK ✓', 'success');
            else toast('Connection failed: ' + (r.error || 'unknown error'), 'error');
        } catch (err) {
            toast(err.message || 'Test failed', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    };

    window.previewAiChatbot = async function previewAiChatbot(btn) {
        const box = $('aibot-preview');
        if (btn) btn.disabled = true;
        try {
            const b = collect();
            const r = await api('/ai-chatbot/preview', { method: 'POST', body: { base_url: b.base_url, model: b.model, api_token: b.api_token, persona: b.persona } });
            if (box) {
                box.style.display = 'block';
                box.textContent = r.sample ? `💬 “${r.sample}”` : '(empty response)';
            }
        } catch (err) {
            if (box) { box.style.display = 'block'; box.textContent = 'Preview failed: ' + (err.message || 'error'); }
        } finally {
            if (btn) btn.disabled = false;
        }
    };

    // Chain into the dashboard load so config populates when the dashboard opens.
    const _prevLoadDashboard = window.loadDashboard;
    window.loadDashboard = async function aiChatbotLoadDashboard() {
        if (typeof _prevLoadDashboard === 'function') await _prevLoadDashboard();
        try { await window.loadAiChatbotConfig(); } catch { /* ignore */ }
    };
    if (window.loadDashboard) { /* keep global alias consistent */ }
})();
