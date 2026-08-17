# Chat System

The OpenVibe.Live chat system provides real-time messaging, moderation, and extensibility.

## Architecture

- **WebSocket server**: `server/chat/chat-server.js` — manages connections, rooms, and message routing
- **REST API**: `server/chat/routes.js` — moderation endpoints, message search, admin tools
- **Client**: `public/js/chat.js` — rendering, emotes, TTS, settings sync

## Features

### Real-time Chat
- Per-stream chat rooms with global fallback
- Authenticated and anonymous users (anon IDs like `anon123`)
- Message history on connect
- User presence tracking (join/leave/count)

### Moderation Tools
- Ban, timeout, unban users
- Message deletion (individual or bulk time-range purge)
- Slow mode (configurable cooldown)
- Subscribers-only mode
- Word filtering and opsec filtering

### Chat Logs & Admin
- Paginated, filterable chat log viewer
- Filter by username, stream ID, date range, message type
- Export to CSV or JSON (up to 50,000 messages)
- Bulk purge by time range with preview count

### Settings Sync
- Chat settings (font size, timestamps, badges, TTS preferences) sync to server
- Server is the source of truth with local cache fallback
- Settings persist across devices via `GET/PUT /api/auth/preferences`

### Text-to-Speech (TTS)
- Site-wide server-generated TTS audio
- Self-hosted browser-voice TTS
- Per-channel TTS settings (volume, pitch, rate, voice, duration limit)
- TTS only activates on the broadcaster's own channel page

## Admin Endpoints

### Chat Logs
```
GET /api/chat/admin/logs?page=1&limit=50&username=bob&from=2024-01-01&to=2024-12-31
```

### Export Logs
```
GET /api/chat/admin/logs/export?format=csv
GET /api/chat/admin/logs/export?format=json
```

### Purge Preview
```
POST /api/chat/admin/purge/preview
Body: { "streamId": 123, "fromTime": "2024-01-01T00:00", "toTime": "2024-01-02T00:00" }
```

### Execute Purge
```
DELETE /api/chat/admin/purge
Body: { "streamId": 123, "fromTime": "2024-01-01T00:00", "toTime": "2024-01-02T00:00" }
```

## WebSocket Protocol

### Connect
```
wss://openvibe.live/ws/chat?token=JWT_OR_API_TOKEN&streamId=123
```

### Message Types (Client → Server)
| Type | Fields | Description |
|------|--------|-------------|
| `chat` | `message` | Send a chat message |
| `join` | `streamId` | Join a stream's chat room |

### Message Types (Server → Client)
| Type | Fields | Description |
|------|--------|-------------|
| `chat` | `username`, `message`, `timestamp`, ... | Chat message |
| `system` | `message` | System notification |
| `delete` | `messageId` | Single message deleted |
| `purge` | `fromTime`, `toTime` | Bulk messages purged |
| `tts` | `text`, `voice` | Server-generated TTS event |
| `tts-audio` | `url` | TTS audio file URL |
| `user_count` | `count` | User presence update |
