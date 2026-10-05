# Chat System

The OpenVibe.Live chat system provides real-time messaging, moderation, and extensibility.

## Architecture

- **WebSocket server**: OpenVibe.Chat (nginx sends `/ws/chat` there) — Live runs no chat server of its own
- **REST API**: OpenVibe.Chat (nginx sends `/api/chat`, `/api/dm`, `/api/tts`, `/api/sounds` there) — moderation endpoints, message search, admin tools. Live's local `server/chat/routes.js` is retired.
- **Client**: `public/js/chat.js` — rendering, emotes, TTS, settings sync

### OpenVibe.Chat (roadmap Wave 6; live since 2026-09-23)

Chat runs in [OpenVibe.Chat](https://github.com/OpenVibers/OpenVibe.Chat) (127.0.0.1:4400) with the
same WebSocket protocol and REST paths. Live runs no chat server in any mode (`CHAT_AUTHORITY=chat`
in production, `server/chat/chat-authority.js`); the local `ChatServer` and its `/ws/chat` upgrade
path are deleted.

- nginx sends `/ws/chat`, `/api/chat/`, `/api/dm/`, `/api/tts/` and `/api/sounds` to Chat; Live mounts
  none of them, and a `/ws/chat` upgrade that still lands on Live is destroyed.
- Live's chat producers (AI viewer lines, relayed and RobotStreamer chat, donations and alert sounds,
  cards, `/api/mod` deletes and moderation, cache hints) go through one seam,
  [server/chat/chat-delivery.js](../server/chat/chat-delivery.js), to Chat's typed service-token ingress
  ([server/chat/chat-client.js](../server/chat/chat-client.js): `POST /internal/chat/messages|events|moderation|invalidate`,
  `GET /internal/chat/presence`). Chat persists, broadcasts and speaks (`tts`) in one call per
  operation; each carries one idempotency key reused on every retry. A Chat 4xx is logged and dropped; a 5xx
  or timeout is retried past Chat's five-minute delivery lease, then logged and dropped; neither is thrown.
- `server/chat/chat-delivery.js` also carries the surface Live's remaining modules used on the old
  chat server: the push names (`broadcastToStream`, `broadcastToChannelRoom`, `sendDm`, …) go to the
  same ingress; synchronous reads (`getTotalConnections`, viewer counts, slow modes, a connected user's
  IP, anon ids) come from Chat's presence snapshot, polled every 3 s by `init()`; Live's IP-approval and
  ban writes send Chat a cache hint; a push with no ingress target (`forwardToGlobal`,
  `synthesizeAndBroadcastTTS`, …) is dropped and logged once, and TTS is never synthesised in Live. The
  arena commands (`/internal/chat-effects/arena-command`) answer the sender in the response's `replies`.
- Deploy notices reach Chat only as the `live.release.deployed` event: with Events publishing off the commits
  stay unannounced and the next boot tries again.
- **The old ordered-calls bridge is gone** (T3 J2): no `chat-remote.js`, no `POST /internal/live/calls`, no
  placeholder ids, and nothing under `server/` reads or writes `chat_bridge_outbox`
  (`test/chat-bridge-removed.test.js`). The table is dropped by the operator migration
  `op_002_drop_chat_bridge_outbox` through `scripts/chat-bridge-outbox-drop.js`, once the release before is
  out of rollback range: `--deliver` first hands Chat (its bridge receiver, until Chat's J3) every chat write
  that release queued and Chat never acknowledged, then `--apply` takes a backup and drops the table; the drop
  refuses while any `op = 'db'` row remains.
- Chat reads Live data and asks for side effects on `/internal/chat-context/*` and
  `/internal/chat-effects/*` (`server/chat/live-context-routes.js`), with Network service tokens
  (`live.chat_context.read`, `live.chat_effects.write`,
  `server/net/service-guard.js`). Effects re-check the acting moderator/owner/admin and are refused
  unless `CHAT_AUTHORITY=chat`.
- Live reads chat stats, queues and history from Chat's internal read API —
  `POST /internal/chat/stats` (`site`, `user`, `stream`, `channel-top` and `site-daily`),
  `GET /internal/chat/messages`, `/timeline`, `/first-chat`, `/sounds`, `/sounds/by-command`,
  `/moderation/pending-ip`, `/moderation/relay-users`, `/moderation/tts-override` — through
  [server/chat/chat-reads.js](../server/chat/chat-reads.js), replacing the read mirror for home stats,
  recaps, AI context, VOD chat replay and the `/api/mod` queues. A Chat outage answers a cached value,
  never a 500; outside chat mode (dev, drills) the same reads answer null/empty — Live keeps no copy of
  Chat's tables (below).
- **The read mirror is retired** (2026-10-05): OpenVibe.Chat #25 removed the sender (its `LIVE_MIRROR`
  writer and the capture triggers), and this change removed Live's receiver — the
  `POST /internal/chat-effects/mirror` route in `live-context-routes.js`, its
  `live.chat_mirror.write` capability and the `chat-delivery.js` mirror helper. Nothing in chat mode
  read it any more: the two HOME_SERIES charts `messages` and `active` read Chat's site-daily series,
  the AI context's "first time chatting here" flag reads Chat's first-chat read, and the
  RobotStreamer `!sound` lookup reads Chat's sounds-by-command read — each through
  [server/chat/chat-reads.js](../server/chat/chat-reads.js); an unreachable Chat answers a cached value,
  else null/empty, never a Live copy.
- **Every chat table is Chat's** (roadmap T3). The staged set — `channel_moderators`,
  `channel_moderation_settings`, `emotes`, `user_tags`, `chat_ai_summaries` and `chat_timeline_events` —
  is read only through [server/chat/moderation-client.js](../server/chat/moderation-client.js) (Chat's
  internal read API, `GET /internal/moderation/...`, capability `chat.moderation.read`, cached 30 s, off
  under `LIVE_DRILL`); the dashboard, channel page and upload UI call Chat directly
  (`/api/chat/channels/:id/…`, `/api/emotes`, `/api/chat/ai/…`); alert sounds are Chat's, played on
  Live's request as an `alert` event `{ streamerId, streamId, kind }` on Chat's ingress
  ([server/monetization/alerts.js](../server/monetization/alerts.js)). Live's staged-table machinery, its
  chat-AI summary job and the old emote/channel-moderation routes were deleted in N+1; the seven
  supporting tables were dropped in N+2 and the unread `emotes` copy in N+3 (ADR-016).
- **The twelve chat tables are dropped** (T3 final step, 2026-10-05): `chat_messages`,
  `dm_conversations`, `dm_participants`, `dm_messages`, `dm_blocks`, `tts_voice_overrides`,
  `channel_sounds`, `relay_users`, `hidden_relay_users`, `pending_ip_messages`, `stream_first_chats`
  and `moderation_actions`. Chat imported them with ids kept at the cutover and has been their only
  writer since; Live's readers and writers are gone (#28–#32 and the release that carries this, #33)
  and it no longer creates them. #33 is in production and its N-1 fixtures no longer run SQL over the
  tables ([test/n-1.test.js](../test/n-1.test.js)), so the drop is boot migration `007_drop_chat_tables`
  ([server/db/migrations.js](../server/db/migrations.js)) (ADR-028) — see
  [docs/cutover-chat-tables-003.md](cutover-chat-tables-003.md). The deployment notice is Chat's too: Live
  queues `live.release.deployed` and Chat folds and stores the rolling card. `test/chat-tables-dropped.test.js`
  guards that nothing under `server/` names them.

## Features

### Real-time Chat
- Per-stream chat rooms with global fallback
- Authenticated and anonymous users (anon IDs like `anon123`)
- Message history on connect
- User presence tracking (join/leave/count)

### Moderation Tools
- Ban, timeout, unban users
- Message deletion (individual or bulk time-range purge): the lines leave every surface that showed
  them (the stream, the rest of the channel room and its popouts, the global feed) and cursor reads
  name them in `deleted_ids`. `/clear` only clears screens; the lines stay in history
- Slow mode: the channel's saved `slow_mode_seconds` (dashboard, or `/slow N` / `/slow off`), enforced
  by OpenVibe.Chat and kept across restarts; moderators are exempt
- Sub-only mode (`sub_only`: dashboard, or `/subonly` / `/subonly off` by the streamer, channel mods
  and chat staff): only people with an active channel subscription (`subscriptions`, asked through
  `GET /internal/chat-context/subscriber`), the streamer, channel mods and chat staff may chat; Network
  VIP does not count, anonymous viewers cannot chat, and when Live cannot be asked the answer is no
- Blocks: someone who blocked a person on OpenVibe.Network no longer gets that person's lines, live or
  in history reads (only their own view; moderation logs show everything)
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
Body: { "streamId": 123, "from": "2024-01-01T00:00:00Z", "to": "2024-01-02T00:00:00Z" }
```

### Execute Purge
```
DELETE /api/chat/admin/purge
Body: { "streamId": 123, "from": "2024-01-01T00:00:00Z", "to": "2024-01-02T00:00:00Z" }
```

`from` and `to` (also on the log filter and `/api/chat/:streamId/replay`) are UTC, as ISO instants
or SQLite's `YYYY-MM-DD HH:MM:SS`; both bounds are inclusive. The preview, the purge, the log filter
and VOD chat replay all read them the same way, so a purged range disappears from replay exactly.

## WebSocket Protocol

### Connect
```
wss://openvibe.live/ws/chat?stream=123
Authorization: Bearer JWT_OR_API_TOKEN        (non-browser clients)
```
Browsers send the token in the first `join` message instead (`{ "type": "join", "streamId": 123, "token": "…" }`); the `ov_token`/`token` cookies also authenticate the upgrade on the site's own origin. A `?token=` query parameter still works for older bots but is deprecated (C-05): URLs are logged.

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

When AI is enabled (`ai_enabled`, and `AI_SERVICE` not `off`; the `chat_translate_enabled` site setting defaults to on),
each chat line is translated a beat after it is broadcast and delivered to the same rooms as

```json
{ "type": "chat_translation", "id": 123, "from": "ja", "to": "en", "text": "…" }
```

Direction rules: any non-English message → English; an English message in a non-English
channel → the channel's language (so a Japanese streamer reads his chat without anyone typing
Japanese). Emote-only / command / link-only lines are skipped. Translations are cached by
content hash in the `translations` table and persisted by Chat into the message's
`metadata.translation`, so history renders them too. Calls go through `ai/llm.js` (metered, budgeted, max 3 in flight;
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
