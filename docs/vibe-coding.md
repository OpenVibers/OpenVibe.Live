# Vibe Coding

OpenVibe.Live's vibe-coding feature lets a streamer publish a sanitized coding activity feed from an editor extension, CLI tool, agent, or other publisher into a managed stream slot. Viewers see a compact widget above chat, and the slot owner controls depth, visibility, and delay per slot.

GitHub Copilot is the reference publisher we provide today, but the protocol is intentionally provider-agnostic so other integrations such as Claude Code or custom tooling can emit the same canonical event model.

## Data Model

Persistent slot settings live in `managed_streams.broadcast_settings.vibe_coding` and are normalized to this shape:

```json
{
  "enabled": 1,
  "widget_title": "Vibe Coding",
  "viewer_depth": "standard",
  "show_prompts": 1,
  "show_responses": 1,
  "show_thinking": 0,
  "show_tool_calls": 1,
  "show_tool_arguments": 0,
  "show_file_events": 1,
  "show_file_snippets": 0,
  "redact_file_paths": 1,
  "paused": 0,
  "delay_ms": 0,
  "max_events": 18,
  "max_prompt_chars": 220,
  "max_response_chars": 360,
  "max_thinking_chars": 140,
  "max_tool_chars": 140,
  "max_snippet_chars": 140
}
```

Durable runtime data is stored in two SQLite tables:

- `vibe_coding_sessions` — one row per `managed_stream_id + session_key`
- `vibe_coding_events` — canonical sanitized events keyed by `managed_stream_id + event_id`

## Publisher WebSocket

Streamers publish live coding activity over a dedicated WebSocket endpoint:

```text
GET /ws/vibe-coding/publish?token=hbt_xxx&managedStreamId=123&slotSlug=camp-code
```

Authentication accepts JWTs or `hbt_` API tokens. API tokens should include the dedicated `vibe_coding_publish` scope. The legacy `stream` scope is still accepted for backward compatibility.

### Server messages

Ready:

```json
{
  "type": "vibe-coding.ready",
  "ok": true,
  "managed_stream_id": 123,
  "slot_slug": "camp-code",
  "live_stream_id": 456,
  "settings": {
    "enabled": 1,
    "viewer_depth": "standard"
  },
  "timestamp": "2026-04-21T23:10:00.000Z"
}
```

Hello ack:

```json
{
  "type": "vibe-coding.hello.ack",
  "session_key": "openvibe-20260421231000-ab12cd34",
  "timestamp": "2026-04-21T23:10:00.250Z"
}
```

Event ack:

```json
{
  "type": "vibe-coding.ack",
  "event_id": "28c49b5c-9070-4fd3-b750-b67d84338f64",
  "live_stream_id": 456,
  "delivered": true,
  "timestamp": "2026-04-21T23:10:01.500Z"
}
```

Error:

```json
{
  "type": "vibe-coding.error",
  "error": "API token requires vibe_coding_publish scope"
}
```

### Client messages

Hello:

```json
{
  "type": "vibe-coding.hello",
  "protocolVersion": 1,
  "managedStreamId": 123,
  "slotSlug": "camp-code",
  "timestamp": "2026-04-21T23:10:00.000Z",
  "sessionKey": "openvibe-20260421231000-ab12cd34",
  "publisher": {
    "integrationId": "github-copilot",
    "integrationLabel": "GitHub Copilot",
    "vendor": "GitHub",
    "clientType": "vscode-extension",
    "clientName": "OpenVibe.Live Copilot Companion",
    "clientVersion": "0.0.1",
    "workspaceName": "openvibe",
    "machineName": "streamer-laptop",
    "viewerDepth": "standard",
    "capabilities": {
      "thinking": false,
      "toolCalls": true,
      "workspaceFileEvents": true
    }
  }
}
```

Event envelope:

```json
{
  "type": "vibe-coding.event",
  "protocolVersion": 1,
  "managedStreamId": 123,
  "slotSlug": "camp-code",
  "sessionKey": "openvibe-20260421231000-ab12cd34",
  "timestamp": "2026-04-21T23:10:01.100Z",
  "event": {
    "version": 1,
    "eventId": "28c49b5c-9070-4fd3-b750-b67d84338f64",
    "sessionKey": "openvibe-20260421231000-ab12cd34",
    "sessionId": "7b3e6b3a-78df-40d7-a53d-9acfa1b2cb30",
    "sequence": 17,
    "eventType": "response",
    "visibility": "public",
    "depth": "standard",
    "occurredAt": "2026-04-21T23:10:01.099Z",
    "summary": "Refactored the publish server to sanitize Copilot events before viewer fanout.",
    "source": {
      "channel": "chat-session",
      "rawType": "request.response"
    },
    "publisher": {
      "integrationId": "github-copilot",
      "integrationLabel": "GitHub Copilot",
      "vendor": "GitHub",
      "clientType": "vscode-extension",
      "clientName": "OpenVibe.Live Copilot Companion"
    },
    "response": {
      "text": "Refactored the publish server to sanitize Copilot events before viewer fanout.",
      "truncated": false
    },
    "metadata": {
      "requestId": "req-123",
      "responseId": "resp-456",
      "workspaceName": "openvibe",
      "model": "gpt-5.4"
    }
  }
}
```

Ping:

```json
{
  "type": "vibe-coding.ping",
  "protocolVersion": 1,
  "timestamp": "2026-04-21T23:10:30.000Z"
}
```

### Canonical event types

- `session.status`
- `prompt`
- `response`
- `thinking`
- `tool.call`
- `file.change`
- `file.save`

The extension publishes only canonical sanitized events. Raw debug log lines, raw transcript lines, raw chat-session lines, secrets, and absolute file paths are not broadcast directly.

`source.channel` is publisher-defined so non-Copilot integrations can describe where an event came from without changing the canonical event types.

## REST Endpoints

Public feed for viewer widgets:

```text
GET /api/vibe-coding/channel/:username/:slotIdOrSlug/events?limit=18
```

Response:

```json
{
  "managed_stream": {
    "id": 123,
    "slug": "camp-code",
    "title": "Night Bus Refactor"
  },
  "live_stream_id": 456,
  "settings": {
    "enabled": 1,
    "viewer_depth": "standard"
  },
  "publisher": {
    "integrationId": "github-copilot",
    "integrationLabel": "GitHub Copilot",
    "vendor": "GitHub",
    "clientType": "vscode-extension",
    "clientName": "OpenVibe.Live Copilot Companion",
    "clientVersion": "0.0.1",
    "workspaceName": "openvibe",
    "machineName": "streamer-laptop",
    "viewerDepth": "standard",
    "capabilities": {
      "thinking": false,
      "toolCalls": true,
      "workspaceFileEvents": true
    }
  },
  "events": []
}
```

Authenticated recent event history for the slot owner:

```text
GET /api/vibe-coding/managed/:managedStreamId/events?limit=50
```

Authenticated slot settings endpoints:

```text
GET /api/vibe-coding/managed/:managedStreamId/settings
PUT /api/vibe-coding/managed/:managedStreamId/settings
```

The workspace UI currently saves the same settings through the existing managed-stream broadcast settings save flow, which persists to `managed_streams.broadcast_settings`.

## Viewer Delivery

Viewer clients do not connect to a second public WebSocket. Live slot events are projected through the existing stream chat socket as a new message type:

```json
{
  "type": "vibe-coding",
  "managed_stream_id": 123,
  "slot_slug": "camp-code",
  "delay_ms": 0,
  "event": {
    "eventId": "28c49b5c-9070-4fd3-b750-b67d84338f64",
    "eventType": "file.change",
    "summary": "Editing server/vibe-coding/publish-server.js",
    "file": {
      "name": "publish-server.js",
      "relativePath": "server/vibe-coding/publish-server.js",
      "operation": "edit",
      "changeCount": 3,
      "snippet": null
    }
  }
}
```

The browser chat client inserts the vibe-coding widget above the slot chat header, hydrates its initial state from the REST endpoint, and can display the active publisher label so the same widget works for Copilot, Claude Code, or custom integrations.