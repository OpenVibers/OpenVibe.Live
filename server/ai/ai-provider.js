/**
 * ai-provider.js — Minimal OpenAI-compatible AI client.
 *
 * Works with any provider exposing the OpenAI REST shape:
 *   - Chat:          POST {baseUrl}/chat/completions
 *   - Transcription: POST {baseUrl}/audio/transcriptions   (Whisper-style)
 *
 * That covers OpenAI, OpenRouter, Groq, Together, local llama.cpp / LM Studio /
 * Ollama (OpenAI-compat mode), etc. Callers supply baseUrl + apiKey + model.
 * No SDK dependency — uses global fetch/FormData/Blob (Node 18+).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function normalizeBaseUrl(baseUrl) {
    let u = String(baseUrl || DEFAULT_BASE_URL).trim();
    if (!u) u = DEFAULT_BASE_URL;
    return u.replace(/\/+$/, '');
}

// A non-OpenAI base URL — local servers (Ollama / LM Studio / llama.cpp) are OpenAI-
// compatible but need NO API key, so we don't require one for these.
function isSelfHostedBaseUrl(baseUrl) {
    const u = normalizeBaseUrl(baseUrl).toLowerCase();
    return !!u && !u.includes('api.openai.com');
}

// True if the URL points at a local/private address the PUBLIC server can't reach.
function isLocalOrPrivateHost(baseUrl) {
    try {
        const h = new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
        return h === 'localhost' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local')
            || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)
            || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h);
    } catch { return false; }
}

// Translate a low-level fetch failure into an actionable message. undici throws a terse
// "fetch failed" (surfaced in browsers as "Failed to fetch") for any network-level problem
// — and the #1 cause here is a self-hosted endpoint that isn't reachable from our servers.
function _describeFetchError(err, url, baseUrl, timeoutMs) {
    if (err && err.name === 'AbortError') {
        return new Error(`The AI server at ${url} didn't respond within ${Math.round(timeoutMs / 1000)}s. Is it running and reachable?`);
    }
    if (isLocalOrPrivateHost(baseUrl)) {
        return new Error(`Can't reach ${url}. The AI chat viewers run on OpenVibe.Live's servers, so a self-hosted API must be reachable from the public internet — a local address like localhost/127.0.0.1 or a home/LAN IP won't work. Expose it with a public URL or a tunnel (e.g. ngrok, cloudflared) and use that as the Base URL.`);
    }
    return new Error(`Couldn't connect to the AI server at ${url}. Check the Base URL and that the server is online and reachable from the internet.`);
}

/**
 * Chat completion. Returns the assistant message text (string).
 * @param {{baseUrl?:string, apiKey:string, model:string, messages:Array, temperature?:number, maxTokens?:number, timeoutMs?:number}} opts
 */
async function chatCompletion(opts) {
    const {
        baseUrl, apiKey, model, messages,
        temperature = 1.0, maxTokens = 160, timeoutMs = 20000,
    } = opts;
    if (!model) throw new Error('AI model not configured');
    // API key is OPTIONAL: self-hosted OpenAI-compatible servers (Ollama, LM Studio,
    // llama.cpp) accept requests with no Authorization header. Only send one when present.
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
                signal: controller.signal,
            });
        } catch (netErr) {
            throw _describeFetchError(netErr, url, baseUrl, timeoutMs);
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            if (res.status === 401 || res.status === 403) {
                throw new Error(`The AI server rejected the request (HTTP ${res.status}). It needs a valid API key${apiKey ? '' : ' — none was provided'}.`);
            }
            throw new Error(`AI HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        return typeof text === 'string' ? text.trim() : '';
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Transcribe an audio file. Returns the transcript text (string, possibly '').
 * @param {{baseUrl?:string, apiKey:string, model?:string, filePath:string, language?:string, timeoutMs?:number}} opts
 */
async function transcribe(opts) {
    const {
        baseUrl, apiKey, model = 'whisper-1', filePath,
        language, timeoutMs = 30000,
    } = opts;
    if (!filePath || !fs.existsSync(filePath)) throw new Error('Transcription audio file missing');

    const url = `${normalizeBaseUrl(baseUrl)}/audio/transcriptions`;
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/wav' }), path.basename(filePath));
    form.append('model', model);
    form.append('response_format', 'text');
    if (language) form.append('language', language);

    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let res;
        try {
            res = await fetch(url, { method: 'POST', headers, body: form, signal: controller.signal });
        } catch (netErr) {
            throw _describeFetchError(netErr, url, baseUrl, timeoutMs);
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Transcribe HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
        // response_format=text returns raw text; some providers still return JSON.
        const raw = await res.text();
        try {
            const j = JSON.parse(raw);
            return String(j.text || j.transcript || '').trim();
        } catch {
            return String(raw || '').trim();
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Lightweight connectivity/credential check — a 1-token chat call.
 * Returns { ok:true } or { ok:false, error }.
 */
async function testConnection(opts) {
    try {
        await chatCompletion({
            ...opts,
            messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
            maxTokens: 5,
            temperature: 0,
            timeoutMs: 15000,
        });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

module.exports = { chatCompletion, transcribe, testConnection, normalizeBaseUrl, isSelfHostedBaseUrl, isLocalOrPrivateHost, DEFAULT_BASE_URL };
