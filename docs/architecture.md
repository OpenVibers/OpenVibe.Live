# System Architecture

## Overview

OpenVibe.Live is a self-hosted live streaming platform built on:
- **Express.js** — HTTP API and SPA serving
- **SQLite** (better-sqlite3) — Database for users, streams, VODs, chat, tokens
- **WebSocket** — Real-time chat, stream signaling, JSMPEG transport
- **mediasoup** — WebRTC SFU for low-latency browser streaming
- **FFmpeg** — Recording, remuxing, thumbnail generation, RTMP ingest

## Authentication

Authentication is provided by the **OpenVibe SSO** (openvibe.tools):
- RS256 JWT tokens verified against the SSO JWKS endpoint
- API tokens (`hbt_` prefix) stored as SHA-256 hashes in `api_tokens` table
- Both token types accepted in `Authorization: Bearer ...` headers

## Streaming Protocols

### WebRTC
```
Browser → mediasoup Router → mediasoup Consumers → Viewers
         ↓
    MediaRecorder → chunk uploads → server concat → WebM VOD
```

### RTMP
```
OBS → Node-Media-Server → HLS/HTTP-FLV → Viewers
                        ↓
                  FFmpeg capture → WebM VOD
```

### JSMPEG
```
FFmpeg → WebSocket → JSMPEG Relay → Canvas viewers
                   ↓
             FFmpeg stdin pipe → WebM VOD
```

## Data Flow

### Chat
```
Client WS → chat-server.js → SQLite (saveChatMessage)
                            → broadcast to room (stream/global)
                            → forward to global if stream chat
```

### VOD Recording
```
Stream data → FFmpeg/MediaRecorder → raw WebM file
            → periodic remux (60s) → .seekable.webm sidecar (live DVR)
            → stream end → finalizeVodRecording:
                1. Merge pending segments
                2. Remux for seeking (ffmpeg -c copy)
                3. ffprobe duration
                4. Auto-delete if < 10s
                5. Generate thumbnail
```

### Thumbnails
```
Live: Browser canvas capture → POST /thumbnails/live/:id (115s throttle)
      RTMP: HTTP-FLV frame extract (120s throttle)
      JSMPEG: WS relay frame extract (120s throttle)
VOD/Clip: ffmpeg -vframes 1 (deduped per entity)
```

## Key Server Modules

| Module | Path | Purpose |
|--------|------|---------|
| Main server | `server/index.js` | Express setup, route mounting |
| Chat server | `server/chat/chat-server.js` | WebSocket chat, moderation |
| Chat routes | `server/chat/routes.js` | REST API for chat history, logs, purge |
| Stream routes | `server/streaming/routes.js` | Stream CRUD, signaling |
| VOD routes | `server/vod/routes.js` | VOD CRUD, chunk upload, finalization |
| Recorder | `server/vod/recorder.js` | Server-side FFmpeg recording |
| Thumbnails | `server/thumbnails/thumbnail-service.js` | Thumbnail generation and serving |
| Database | `server/db/database.js` | SQLite queries, schema |
| Auth | `server/auth/auth.js` | JWT + API token verification |

## OpenVibe Integration

OpenVibe.Live is part of the OpenVibe, with openvibe.tools acting as the SSO hub. This service now uses openvibe.tools OAuth2 SSO in production; legacy migration scripts remain for historical reference only. The openvibe-tools server proxies admin API calls to OpenVibe.Live for unified management. No streaming features are duplicated — openvibe-tools is a gateway only.
