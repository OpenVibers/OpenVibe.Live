# Restreaming

How a live OpenVibe stream is forwarded to other platforms, what each path does to the picture,
what the broadcaster sees, and how the forwarders are kept in step with the stream's lifecycle.

## Two forwarders

| Path | Module | Destinations | What happens to the video |
|---|---|---|---|
| **ffmpeg restreams** | `server/streaming/restream-manager.js` | Twitch, YouTube, Kick, any RTMP/RTMPS or SRT ingest (`restream_destinations` rows) | RTMP source: **codec copy** (nothing re-encoded). Browser/WHIP/JSMPEG source: re-encoded to H.264/AAC on the server with the destination's quality preset |
| **RobotStreamer passthrough** | `server/integrations/rs-passthrough-relay.js` | One robot per stream slot (`robotstreamer_integrations`) | **Zero re-encode**: the source's RTP is pulled from our mediasoup SFU and written straight into a werift peer connection joined to RobotStreamer's SFU |

The RobotStreamer path needs an SFU producer, so it serves browser and OBS/WHIP sources. RTMP and
JSMPEG streams get the chat mirror only (`robotstreamer-service.js` skips the relay for them
instead of letting it wait for a producer that never comes).

## Latency

- Output muxing is real-time on every path: `-muxdelay 0 -muxpreload 0 -flush_packets 1`.
- Encoded paths use `-tune zerolatency`, CBR, 2-second closed GOPs and a **1× VBV** (`bufsize =
  bitrate`), which is about a second less end-to-end than the previous 2× buffer at the same
  bitrate. Custom bitrates keep the 1× rule.
- RTMP sources are forwarded with `-c copy`, so their latency is the platform's own.
- The RobotStreamer relay adds no encoder at all; its latency is the network path to RS plus RS's
  own WebRTC playout. Keyframe requests from RS are relayed to the source encoder (rate-limited
  to one per 2 s so a lossy link cannot turn into a keyframe storm).
- SRT destinations take a `latency` (receiver buffer) per destination; 120 ms is libsrt's default
  and right for a same-continent ingest, 300–600 ms for intercontinental or Wi-Fi hops.

## SRT destinations

A destination whose server URL starts with `srt://host:port` is sent as MPEG-TS in caller mode
(`pkt_size=1316`). The "stream key" field becomes the SRT `streamid`; the destination's
`srt_latency_ms` and optional `srt_passphrase` (10–79 characters, AES per the SRT spec) travel as
URL options. The passphrase is stored server-side and never returned to the client
(`has_srt_passphrase` only). Command lines in the log are redacted (`server/utils/redact.js` masks
`passphrase=`, `streamid=` and the key segment).

## Live acknowledgement and errors (ffmpeg)

ffmpeg is spawned with `-progress pipe:1 -stats_period 1`. The first progress block with
`frame > 0` (or `out_time > 0` for a codec copy) is the **live** signal — it means the ingest
accepted the stream and is taking data. Before this the dashboard guessed "Live" after 15 s
regardless. If no progress arrives within 20 s the run is killed with a "no response from the
ingest" error so the retry machinery and the dashboard see a real failure instead of a
"Starting…" that never ends.

The last stderr lines of a failed run are kept raw (`session.lastErrorRaw`, logged) and mapped to
a sentence a streamer can act on (`RestreamManager.friendlyFfmpegError`): rejected key, unreachable
or unresolvable ingest, TLS failure, connection closed by the platform, SRT passphrase mismatch,
bad encoder option. Restarts back off exponentially (5 s → 2 min, 30 attempts); a destination
that never went live and crashes four times in a row is put in a persisted cooldown
(circuit breaker) so it is not hammered on every go-live.

`GET /api/restream/status` returns, per live stream and destination: `status`, `platform`,
`transport` (`rtmp`/`srt`), `liveAt`, `uptimeMs`, `restartAttempts`/`maxRestartAttempts`,
`nextRestartAt`, `lastError` and the latest `progress` (`fps`, `bitrate_kbps`, `speed`,
`dropped`, `frame`). It also carries `robotstreamer[streamId]` — the passthrough state below.

## RobotStreamer passthrough lifecycle

The relay must never outlive its source: RobotStreamer keeps a robot "live" for exactly as long
as our producers exist on its SFU, so a relay left running after the streamer stopped shows RS
viewers a live robot with a black picture. The session therefore ends on any of:

1. `producer-removed` for the stream's video producer on our SFU (tab closed, room closed);
2. the stream row going not-live (checked every 5 s as a backstop for end paths that never
   touch the SFU room — stale-heartbeat sweeps, an ingest handler calling `db.endStream`);
3. an explicit stop: the broadcaster's **Stop** button (`POST /api/robotstreamer/restream/stop`),
   the integration being disabled, or any of the stream-end paths below.

Restarts (RS websocket closed, ICE/DTLS to RS lost, the run throwing, a producer being replaced
on reconnect) first re-check that the source is live, then back off 3 s → 30 s and give up after
12 consecutive attempts. A run that stayed live for a minute resets the counter. A session that
gave up stays visible as `failed` with its reason until **Retry**
(`POST /api/robotstreamer/restream/start`) relaunches it.

`rsPassthroughRelay.status(streamId)` (in `/api/restream/status`) reports `state`
(`starting | live | restarting | failed`), `restarts`, `last_error` / `last_restart_reason`,
`next_restart_at`, `uptime_ms`, `video_codec`, `has_audio`, `keyframe_requests`, `ingest_stalls`
and RS's own RTCP view of us (`rs.loss_pct`, `rs.rtt_ms`, `rs.nacks`, `rs.plis`).

## Every stream-end path stops the forwarders

| End path | Where | Stops |
|---|---|---|
| Streamer ends the stream | `DELETE /api/streams/:id` | RS, chat relays, AI bots, restreams (via room close), voice channel |
| Broadcaster socket gone for 60 s | `broadcast-server.js` grace timer → `_stopForwarders()` | RS, restreams, chat relays, AI bots |
| OBS stops (RTMP `donePublish`) | `index.js` `rtmpServer.on('unpublish')` | restreams, RS, chat relays, AI bots |
| WHIP session ends | `whip-handler.js` `endActiveWhipStream` | restreams, RS, chat relays, AI bots, room |
| No heartbeat for 5 min | `index.js` stale sweep | RS, chat relays, AI bots, restreams, room |
| Admin force-end | `DELETE /api/admin/streams/:id` | RS, restreams, chat relays, AI bots, room, SFU room, voice channel |
| Process shutdown | `index.js` SIGTERM handler | `rsPassthroughRelay.stopAll()` closes each RS peer so RS's viewers get `consumerClosed` immediately |

## Dashboard

The live-controls restream panel (`public/js/broadcast.js` `updateRestreamControlPanel`) polls
`/api/restream/status` every 5 s while live and shows, per destination, a badge (Idle / Starting /
Live / Error / Failed / Paused) plus a detail line: uptime, fps and bitrate, an encoder-behind
warning when `speed < 0.95×`, dropped frames, the last error, and a countdown to the next retry.
The RobotStreamer row is driven by the server's passthrough state when the server relay owns the
robot (its Start/Stop reach the server; before, the button only touched the browser's unused
publisher). The stream-slot settings form (`broadcast-workspace.js`) exposes per destination:
quality preset, video/audio bitrate, fps, x264 encoder speed, and for `srt://` URLs the latency
and passphrase.

## Tests

- `test/rs-passthrough-lifecycle.test.js` — stop-when-source-ended, backoff, cap, relaunch, status.
- `test/restream-manager-lifecycle.test.js` — URL building (RTMP/RTMPS/Kick/SRT), per-transport
  output flags, 1× VBV, friendly errors, and the progress-based live ACK against a real ffmpeg.
- `test/rs-passthrough-ssrc-filter.test.js`, `test/rs-chat-bridge-single-flight.test.js` — earlier
  regressions.
