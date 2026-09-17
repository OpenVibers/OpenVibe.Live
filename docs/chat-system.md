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

### TTS playback hardening (2026-08-31)

`media-src` now includes `data:` (the mod voice preview plays a `data:audio/…` URL; without it the element dies with "no supported source"). The admin **Test Voice** (`POST /api/tts/admin/test`) and mod preview (`POST /api/mod/tts-voice/preview`) additionally return a same-origin `url` — the clip is parked in the shared TTS cache (`data/tts-cache`) and streamed from `GET /api/tts/audio/<hash>.<wav|mp3>` (strict filename, no traversal) — so playback works even where a browser or shield refuses `blob:`/`data:` audio. Chat/broadcast TTS players retry once with a `data:` URL when the element rejects the blob URL. Note: `tts-audio` WS payloads carry base64 (`audio` + `mimeType`), not a `url`.


## Auto-translation (non-English streamers)

Every channel has a **language** it lives in: the streamer's explicit `channels.chat_language`
(`PUT /api/streams/channel` with `chat_language: 'ja'` / `'auto'` …), or, when `auto`, the
language detected from any non-English line in their bio or name (`server/i18n/translate.js`).
`GET /api/streams/channel/:username` returns it as `language: { code, name, flag, explicit, translate }`,
and the chat `auth` frame carries `channel_language` so the composer can show the
"Auto-translated ↔ Japanese" pill.

When AI is enabled (`ai_enabled` + a key; the `chat_translate_enabled` site setting defaults to on),
each chat line is translated a beat after it is broadcast and delivered to the same rooms as

```json
{ "type": "chat_translation", "id": 123, "from": "ja", "to": "en", "text": "…" }
```

Direction rules: any non-English message → English; an English message in a non-English
channel → the channel's language (so a Japanese streamer reads his chat without anyone typing
Japanese). Emote-only / command / link-only lines are skipped. Translations are cached by
content hash in the `translations` table and persisted into `chat_messages.metadata.translation`,
so history renders them too. Calls go through `ai/llm.js` (metered, budgeted, max 3 in flight;
overflow lines simply stay untranslated).

**Any line, your language.** Every chat message also has a hover 🌐 button that asks `POST /api/i18n/translate { text, to }` for the line in the viewer's browser language (rate-limited per IP: 15/min anonymous, 40/min signed in; cached like the automatic translations). This is the third direction — a Korean viewer reading a Japanese streamer, a Japanese viewer on an English stream — so nobody is left out, English users included.

Related surfaces: `GET /api/streams/channel/:username/bio-en` (bio in English),
`GET /api/chat-ai/live-captions/:username` (English rendering of live speech — needs the AI
timeline on and a multilingual whisper model, see `WHISPER_MODEL_MULTI`), and the home-page
"Star of OpenVibe" spotlight (`GET /api/home/star`, `star_streamer` setting / `STAR_STREAMER` env).


## Friendly global chat (2026-09-17)

A viewer-side setting (chat settings → Behavior). When on, messages in global chat that match
`FRIENDLY_FILTER_CATEGORIES` in `server/chat/moderation-utils.js` (slurs, hate slogans, threats,
sexual content, anything sexualising minors) fold into a "N messages hidden by Friendly chat ·
Show" line. Nothing is deleted and nobody is moderated for it. It is on for a viewer's first day
(the chat `auth` message carries `newcomer`, from the account age or the anon's first sighting)
unless the viewer chose otherwise; the rules come from `GET /api/chat/filters/friendly`.

## History and rendering

`buildChatMessageEl()` in `public/js/chat.js` renders every surface (page, popout, broadcast desk,
floating widget). History renders off-screen and swaps in once; the last 200 rows of a room are
cached in localStorage per user for an instant paint on reload. The view follows new messages
unless the reader scrolled back (`_watchChatPin`).
