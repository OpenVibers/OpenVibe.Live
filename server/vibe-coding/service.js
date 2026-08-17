'use strict';

const path = require('path');

const db = require('../db/database');

const DEFAULT_VIBE_CODING_SETTINGS = Object.freeze({
    enabled: 0,
    widget_title: 'Vibe Coding',
    viewer_depth: 'standard',
    show_prompts: 1,
    show_responses: 1,
    show_thinking: 0,
    show_tool_calls: 1,
    show_tool_arguments: 0,
    show_file_events: 1,
    show_file_snippets: 0,
    redact_file_paths: 1,
    paused: 0,
    delay_ms: 0,
    max_events: 18,
    max_prompt_chars: 220,
    max_response_chars: 360,
    max_thinking_chars: 140,
    max_tool_chars: 140,
    max_snippet_chars: 140,
});

const DEFAULT_PUBLISHER = Object.freeze({
    integrationId: 'custom',
    integrationLabel: 'Custom Publisher',
    vendor: null,
    clientType: 'other',
    clientName: 'Custom Publisher',
    clientVersion: null,
    workspaceName: null,
    machineName: null,
    viewerDepth: DEFAULT_VIBE_CODING_SETTINGS.viewer_depth,
    capabilities: {
        thinking: false,
        toolCalls: false,
        workspaceFileEvents: false,
    },
});

const LEGACY_COPILOT_PUBLISHER = Object.freeze({
    integrationId: 'github-copilot',
    integrationLabel: 'GitHub Copilot',
    vendor: 'GitHub',
    clientType: 'vscode-extension',
    clientName: 'OpenVibe.Live Copilot Companion',
});

function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
}

function normalizeBool(value, fallback) {
    if (value === undefined || value === null) return fallback;
    return value ? 1 : 0;
}

function normalizeStringOrNull(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

function normalizeDepth(value, fallback = DEFAULT_VIBE_CODING_SETTINGS.viewer_depth) {
    const normalized = String(value || fallback).trim().toLowerCase();
    if (normalized === 'headline' || normalized === 'deep') return normalized;
    return 'standard';
}

function normalizePublisherClientType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'vscode-extension' || normalized === 'cli' || normalized === 'browser' || normalized === 'service') {
        return normalized;
    }
    return 'other';
}

function parseJson(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function getPublisherFallback(source) {
    if (source && typeof source === 'object' && (source.extensionVersion || source.clientVersion || source.sendsThinking !== undefined || source.sendsToolCalls !== undefined || source.sendsWorkspaceFileEvents !== undefined)) {
        return LEGACY_COPILOT_PUBLISHER;
    }
    return DEFAULT_PUBLISHER;
}

function normalizePublisherDescriptor(value) {
    const source = value && typeof value === 'object' ? value : {};
    const fallback = getPublisherFallback(source);
    const rawCapabilities = parseJson(source.capabilities, {}) || {};

    return {
        integrationId: normalizeStringOrNull(source.integrationId) || fallback.integrationId,
        integrationLabel: normalizeStringOrNull(source.integrationLabel) || normalizeStringOrNull(source.integrationId) || fallback.integrationLabel,
        vendor: normalizeStringOrNull(source.vendor) || fallback.vendor,
        clientType: normalizePublisherClientType(source.clientType || fallback.clientType),
        clientName: normalizeStringOrNull(source.clientName) || normalizeStringOrNull(source.integrationLabel) || fallback.clientName,
        clientVersion: normalizeStringOrNull(source.clientVersion || source.extensionVersion),
        workspaceName: normalizeStringOrNull(source.workspaceName),
        machineName: normalizeStringOrNull(source.machineName),
        viewerDepth: normalizeDepth(source.viewerDepth),
        capabilities: {
            thinking: rawCapabilities.thinking !== undefined ? !!rawCapabilities.thinking : !!source.sendsThinking,
            toolCalls: rawCapabilities.toolCalls !== undefined ? !!rawCapabilities.toolCalls : !!source.sendsToolCalls,
            workspaceFileEvents: rawCapabilities.workspaceFileEvents !== undefined ? !!rawCapabilities.workspaceFileEvents : !!source.sendsWorkspaceFileEvents,
        },
    };
}

function normalizeEventPublisher(value) {
    if (!value || typeof value !== 'object') return null;
    const publisher = normalizePublisherDescriptor(value);
    return {
        integrationId: publisher.integrationId,
        integrationLabel: publisher.integrationLabel,
        vendor: publisher.vendor,
        clientType: publisher.clientType,
        clientName: publisher.clientName,
    };
}

function normalizeVibeCodingSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        enabled: normalizeBool(source.enabled, DEFAULT_VIBE_CODING_SETTINGS.enabled),
        widget_title: String(source.widget_title || DEFAULT_VIBE_CODING_SETTINGS.widget_title).trim() || DEFAULT_VIBE_CODING_SETTINGS.widget_title,
        viewer_depth: normalizeDepth(source.viewer_depth),
        show_prompts: normalizeBool(source.show_prompts, DEFAULT_VIBE_CODING_SETTINGS.show_prompts),
        show_responses: normalizeBool(source.show_responses, DEFAULT_VIBE_CODING_SETTINGS.show_responses),
        show_thinking: normalizeBool(source.show_thinking, DEFAULT_VIBE_CODING_SETTINGS.show_thinking),
        show_tool_calls: normalizeBool(source.show_tool_calls, DEFAULT_VIBE_CODING_SETTINGS.show_tool_calls),
        show_tool_arguments: normalizeBool(source.show_tool_arguments, DEFAULT_VIBE_CODING_SETTINGS.show_tool_arguments),
        show_file_events: normalizeBool(source.show_file_events, DEFAULT_VIBE_CODING_SETTINGS.show_file_events),
        show_file_snippets: normalizeBool(source.show_file_snippets, DEFAULT_VIBE_CODING_SETTINGS.show_file_snippets),
        redact_file_paths: normalizeBool(source.redact_file_paths, DEFAULT_VIBE_CODING_SETTINGS.redact_file_paths),
        paused: normalizeBool(source.paused, DEFAULT_VIBE_CODING_SETTINGS.paused),
        delay_ms: clampInt(source.delay_ms, 0, 120000, DEFAULT_VIBE_CODING_SETTINGS.delay_ms),
        max_events: clampInt(source.max_events, 1, 100, DEFAULT_VIBE_CODING_SETTINGS.max_events),
        max_prompt_chars: clampInt(source.max_prompt_chars, 60, 1200, DEFAULT_VIBE_CODING_SETTINGS.max_prompt_chars),
        max_response_chars: clampInt(source.max_response_chars, 80, 2400, DEFAULT_VIBE_CODING_SETTINGS.max_response_chars),
        max_thinking_chars: clampInt(source.max_thinking_chars, 40, 1200, DEFAULT_VIBE_CODING_SETTINGS.max_thinking_chars),
        max_tool_chars: clampInt(source.max_tool_chars, 40, 1200, DEFAULT_VIBE_CODING_SETTINGS.max_tool_chars),
        max_snippet_chars: clampInt(source.max_snippet_chars, 40, 1200, DEFAULT_VIBE_CODING_SETTINGS.max_snippet_chars),
    };
}

function parseBroadcastSettings(json) {
    if (!json) return {};
    if (typeof json === 'object') return json;
    try {
        return JSON.parse(json);
    } catch {
        return {};
    }
}

function getStoredVibeCodingSettings(broadcastSettings) {
    if (!broadcastSettings || typeof broadcastSettings !== 'object') return null;
    if (broadcastSettings.vibe_coding && typeof broadcastSettings.vibe_coding === 'object') {
        return broadcastSettings.vibe_coding;
    }
    if (broadcastSettings.vibeCoding && typeof broadcastSettings.vibeCoding === 'object') {
        return broadcastSettings.vibeCoding;
    }
    return null;
}

function setStoredVibeCodingSettings(broadcastSettings, settings) {
    if (!broadcastSettings || typeof broadcastSettings !== 'object') return;
    broadcastSettings.vibe_coding = settings;
    broadcastSettings.vibeCoding = settings;
}

function getManagedStreamRow(managedStreamId) {
    return db.get(
        `SELECT ms.*, u.username, u.display_name, u.avatar_url, u.profile_color
         FROM managed_streams ms
         JOIN users u ON ms.user_id = u.id
         WHERE ms.id = ?`,
        [managedStreamId]
    );
}

function getManagedStreamVibeCodingSettings(managedStreamId) {
    const row = getManagedStreamRow(managedStreamId);
    if (!row) return normalizeVibeCodingSettings();
    const broadcastSettings = parseBroadcastSettings(row.broadcast_settings);
    return normalizeVibeCodingSettings(getStoredVibeCodingSettings(broadcastSettings));
}

function updateManagedStreamVibeCodingSettings(managedStreamId, userId, partialSettings) {
    const row = db.get('SELECT broadcast_settings FROM managed_streams WHERE id = ? AND user_id = ?', [managedStreamId, userId]);
    if (!row) return null;
    const broadcastSettings = parseBroadcastSettings(row.broadcast_settings);
    const nextSettings = normalizeVibeCodingSettings({
        ...getStoredVibeCodingSettings(broadcastSettings),
        ...(partialSettings || {}),
    });
    setStoredVibeCodingSettings(broadcastSettings, nextSettings);
    db.updateManagedStreamBroadcastSettings(managedStreamId, userId, broadcastSettings);
    return nextSettings;
}

function getLiveStreamByManagedStreamId(managedStreamId) {
    return db.get(
        `SELECT s.*, ms.slug AS managed_stream_slug
         FROM streams s
         LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
         WHERE s.managed_stream_id = ? AND s.is_live = 1
         ORDER BY COALESCE(s.started_at, s.created_at) DESC
         LIMIT 1`,
        [managedStreamId]
    );
}

function upsertVibeCodingSession({ managedStreamId, userId, slotSlug, helloMessage }) {
    const publisher = normalizePublisherDescriptor(helloMessage?.publisher);
    db.run(
        `INSERT INTO vibe_coding_sessions (
            managed_stream_id, user_id, session_key, slot_slug, workspace_name,
            machine_name, extension_version, publisher_id, publisher_label,
            publisher_vendor, publisher_client_type, publisher_client_name,
            publisher_client_version, publisher_capabilities_json,
            publisher_depth, status, last_event_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
        ON CONFLICT(managed_stream_id, session_key) DO UPDATE SET
            workspace_name = excluded.workspace_name,
            machine_name = excluded.machine_name,
            extension_version = excluded.extension_version,
            publisher_id = excluded.publisher_id,
            publisher_label = excluded.publisher_label,
            publisher_vendor = excluded.publisher_vendor,
            publisher_client_type = excluded.publisher_client_type,
            publisher_client_name = excluded.publisher_client_name,
            publisher_client_version = excluded.publisher_client_version,
            publisher_capabilities_json = excluded.publisher_capabilities_json,
            publisher_depth = excluded.publisher_depth,
            slot_slug = excluded.slot_slug,
            status = 'active',
            ended_at = NULL,
            last_event_at = CURRENT_TIMESTAMP`,
        [
            managedStreamId,
            userId,
            String(helloMessage.sessionKey || ''),
            slotSlug || null,
            publisher.workspaceName,
            publisher.machineName,
            publisher.clientVersion,
            publisher.integrationId,
            publisher.integrationLabel,
            publisher.vendor,
            publisher.clientType,
            publisher.clientName,
            publisher.clientVersion,
            JSON.stringify(publisher.capabilities),
            publisher.viewerDepth,
        ]
    );
}

function getLatestPublisherForManagedStream(managedStreamId) {
    const row = db.get(
        `SELECT workspace_name, machine_name, extension_version, publisher_id,
                publisher_label, publisher_vendor, publisher_client_type,
                publisher_client_name, publisher_client_version,
                publisher_capabilities_json, publisher_depth
         FROM vibe_coding_sessions
         WHERE managed_stream_id = ?
         ORDER BY COALESCE(last_event_at, created_at) DESC, id DESC
         LIMIT 1`,
        [managedStreamId]
    );
    if (!row) return null;
    return normalizePublisherDescriptor({
        integrationId: row.publisher_id,
        integrationLabel: row.publisher_label,
        vendor: row.publisher_vendor,
        clientType: row.publisher_client_type,
        clientName: row.publisher_client_name,
        clientVersion: row.publisher_client_version || row.extension_version,
        workspaceName: row.workspace_name,
        machineName: row.machine_name,
        viewerDepth: row.publisher_depth,
        capabilities: parseJson(row.publisher_capabilities_json, {}),
    });
}

function markSessionEnded(managedStreamId, sessionKey) {
    db.run(
        `UPDATE vibe_coding_sessions
         SET status = 'ended', ended_at = CURRENT_TIMESTAMP, last_event_at = CURRENT_TIMESTAMP
         WHERE managed_stream_id = ? AND session_key = ?`,
        [managedStreamId, sessionKey]
    );
}

function storeVibeCodingEvent({ managedStreamId, userId, streamId, event }) {
    db.run(
        `INSERT INTO vibe_coding_events (
            managed_stream_id, user_id, stream_id, session_key, event_id,
            sequence_num, event_type, visibility, depth, summary, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(managed_stream_id, event_id) DO UPDATE SET
            stream_id = excluded.stream_id,
            sequence_num = excluded.sequence_num,
            event_type = excluded.event_type,
            visibility = excluded.visibility,
            depth = excluded.depth,
            summary = excluded.summary,
            payload_json = excluded.payload_json,
            created_at = CURRENT_TIMESTAMP`,
        [
            managedStreamId,
            userId,
            streamId || null,
            event.sessionKey || null,
            event.eventId,
            Number(event.sequence || 0),
            String(event.eventType || 'session.status'),
            String(event.visibility || 'public'),
            String(event.depth || 'standard'),
            String(event.summary || ''),
            JSON.stringify(event),
        ]
    );
    db.run(
        `UPDATE vibe_coding_sessions
         SET last_event_at = CURRENT_TIMESTAMP
         WHERE managed_stream_id = ? AND session_key = ?`,
        [managedStreamId, event.sessionKey || null]
    );
}

function getStoredEventsForManagedStream(managedStreamId, limit = DEFAULT_VIBE_CODING_SETTINGS.max_events) {
    const rows = db.all(
        `SELECT payload_json, created_at
         FROM vibe_coding_events
         WHERE managed_stream_id = ?
         ORDER BY id DESC
         LIMIT ?`,
        [managedStreamId, clampInt(limit, 1, 100, DEFAULT_VIBE_CODING_SETTINGS.max_events)]
    );

    return rows.reverse().map((row) => {
        try {
            return JSON.parse(row.payload_json);
        } catch {
            return null;
        }
    }).filter(Boolean);
}

function truncateText(value, maxChars, depth) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    let limit = maxChars;
    if (depth === 'headline') {
        limit = Math.max(40, Math.floor(maxChars * 0.6));
    } else if (depth === 'deep') {
        limit = Math.max(maxChars, Math.floor(maxChars * 1.1));
    }
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(20, limit - 1)).trim()}…`;
}

function shouldExposePublicToolPreview(toolName, settings) {
    if (settings?.show_tool_arguments) return true;
    const normalized = String(toolName || '').trim().toLowerCase();
    return normalized === 'run_in_terminal'
        || normalized === 'create_and_run_task'
        || normalized === 'run_notebook_cell';
}

function projectViewerEvent(event, settings) {
    if (!event || !settings || !settings.enabled || settings.paused) {
        return null;
    }

    const projected = {
        eventId: event.eventId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        sequence: event.sequence,
        depth: settings.viewer_depth,
        summary: '',
        source: event.source || null,
        prompt: null,
        response: null,
        thinking: null,
        tool: null,
        file: null,
        publisher: normalizeEventPublisher(event?.publisher),
        session: event.session || null,
        metadata: {
            requestId: event?.metadata?.requestId || null,
            responseId: event?.metadata?.responseId || null,
            workspaceName: event?.metadata?.workspaceName || null,
            model: event?.metadata?.model || null,
        },
    };

    if (event.eventType === 'session.status') {
        projected.summary = truncateText(event.summary, settings.max_prompt_chars, settings.viewer_depth);
        return projected;
    }

    if (event.eventType === 'prompt') {
        if (!settings.show_prompts) return null;
        const text = truncateText(event?.prompt?.text || event.summary, settings.max_prompt_chars, settings.viewer_depth);
        projected.summary = text;
        projected.prompt = { text };
        return projected;
    }

    if (event.eventType === 'response') {
        if (!settings.show_responses) return null;
        const text = truncateText(event?.response?.text || event.summary, settings.max_response_chars, settings.viewer_depth);
        projected.summary = text;
        projected.response = { text };
        return projected;
    }

    if (event.eventType === 'thinking') {
        if (!settings.show_thinking) return null;
        const text = truncateText(event?.thinking?.text || event.summary, settings.max_thinking_chars, settings.viewer_depth);
        projected.summary = text;
        projected.thinking = { text };
        return projected;
    }

    if (event.eventType === 'tool.call') {
        if (!settings.show_tool_calls) return null;
        const includeToolPreview = shouldExposePublicToolPreview(event?.tool?.name, settings);
        projected.summary = truncateText(event.summary || `Used ${event?.tool?.name || 'tool'}`, settings.max_tool_chars, settings.viewer_depth);
        projected.tool = {
            name: event?.tool?.name || 'tool',
            phase: event?.tool?.phase || 'completed',
            argumentsPreview: includeToolPreview ? truncateText(event?.tool?.argumentsPreview || '', settings.max_tool_chars, settings.viewer_depth) : null,
            resultPreview: includeToolPreview ? truncateText(event?.tool?.resultPreview || '', settings.max_tool_chars, settings.viewer_depth) : null,
        };
        return projected;
    }

    if (event.eventType === 'file.change' || event.eventType === 'file.save') {
        if (!settings.show_file_events) return null;
        const rawPath = String(event?.file?.relativePath || event?.file?.name || '').trim();
        const displayPath = settings.redact_file_paths ? path.posix.basename(rawPath.replace(/\\/g, '/')) : rawPath;
        projected.summary = event.eventType === 'file.save'
            ? `Saved ${displayPath || event?.file?.name || 'file'}`
            : `Editing ${displayPath || event?.file?.name || 'file'}`;
        projected.file = {
            name: event?.file?.name || displayPath || 'file',
            relativePath: displayPath || null,
            operation: event?.file?.operation || (event.eventType === 'file.save' ? 'save' : 'edit'),
            changeCount: Number(event?.file?.changeCount || 0),
            snippet: settings.show_file_snippets ? truncateText(event?.file?.snippet || '', settings.max_snippet_chars, settings.viewer_depth) : null,
        };
        return projected;
    }

    return null;
}

function getProjectedViewerFeed(managedStreamId, limit) {
    const settings = getManagedStreamVibeCodingSettings(managedStreamId);
    const events = getStoredEventsForManagedStream(managedStreamId, limit || settings.max_events)
        .map((event) => projectViewerEvent(event, settings))
        .filter(Boolean);
    return {
        settings,
        publisher: getLatestPublisherForManagedStream(managedStreamId),
        events,
    };
}

module.exports = {
    DEFAULT_VIBE_CODING_SETTINGS,
    normalizeVibeCodingSettings,
    normalizePublisherDescriptor,
    getManagedStreamRow,
    getManagedStreamVibeCodingSettings,
    updateManagedStreamVibeCodingSettings,
    getLiveStreamByManagedStreamId,
    getLatestPublisherForManagedStream,
    upsertVibeCodingSession,
    markSessionEnded,
    storeVibeCodingEvent,
    getStoredEventsForManagedStream,
    projectViewerEvent,
    getProjectedViewerFeed,
};