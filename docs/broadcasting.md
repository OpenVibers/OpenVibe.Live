# Broadcasting Guide

OpenVibe.Live supports four live broadcast methods, each suited to different use cases.

## Broadcast Methods

### WebRTC (Browser)
- **Best for**: Quick streams directly from your browser
- **Latency**: Sub-second
- **Setup**: Click "Go Live", grant camera/mic permissions
- **Features**: Screen share, camera PiP overlay, live stats, camera switching

### RTMP (OBS/Streamlabs)
- **Best for**: Professional streaming with OBS, multi-scene setups
- **Latency**: 2-5 seconds
- **Setup**: Copy Server URL and Stream Key into OBS
- **Features**: Full OBS feature set, live thumbnail preview on broadcast page

### WHIP (OBS, FFmpeg, GStreamer — or any web page)
- **Best for**: WebRTC-native encoders and custom publishers, including browser-only sites
- **Latency**: Sub-second
- **Setup**: Choose *Streaming method: WHIP*, copy the WHIP URL into OBS (Service: WHIP) or `ffmpeg -f whip`
- **Features**: VP8/H.264 + Opus, auto-creates the live session on first POST, open CORS so a static page can publish with `RTCPeerConnection` + `fetch()` — see the [WHIP Ingest API](whip.md) / [Publishing from a browser](whip.md#publishing-from-a-browser) and the hosted [browser publisher](https://openvibe.live/whip-publisher.html)

### OpenRestream (OBS, restreaming everywhere)
- **Best for**: Streaming to Twitch, YouTube, Kick and other servers at the same time as your OpenVibe Live channel
- **Setup**: Create a stream on [openre.stream](https://openre.stream), copy its RTMP server and key into OBS, and add
  your other destinations there
- **On Live by default**: each stream made on OpenRestream gets its own slot on your channel, marked *managed on
  OpenRestream*. Its sessions go live on `openvibe.live/@you` with chat, clips and VODs, through the OpenRestream mirror
  (`server/openre/mirror.js`). Switch "Show it on my OpenVibe Live channel" off on OpenRestream and Live ignores that
  stream; your other destinations keep going.
- **How**: OpenRestream calls `POST /internal/openre/slots` (capability `live.openre.slot.bind`,
  [server/openre/bind.js](../server/openre/bind.js)) with a Network service token. Live creates a new slot with
  `ingest_authority = 'openre'`, or returns the one already bound to that stream. It never changes an existing slot.
  A person needs a Live account first, which they get by signing in to openvibe.live once.

### JSMPEG (FFmpeg)
- **Best for**: Headless/embedded streaming (Raspberry Pi, IP cameras, 3D printers)
- **Latency**: ~1 second
- **Setup**: Run FFmpeg command with the provided endpoint
- **Features**: Flexible input sources, low resource usage

## Broadcast Page Features

### Live Controls
When streaming via WebRTC browser, you have access to:
- **Stop Stream** — End the broadcast
- **Mute** / **Camera off** — Silence the microphone or black out the camera without ending the stream (the track is
  disabled; the choice holds when the camera is switched or a track recovers)
- **Flip camera** — Front ↔ back in one tap (shown when the device has more than one camera)
- **Choose camera** — Pick any camera from a list
- **Share screen** — Share screen/window/tab
- **Camera in corner** — Picture-in-picture camera over a shared screen
- **Mic** — Add or remove the microphone while sharing a screen
- **Stream health** — Show bitrate, FPS, resolution, codec overlay
- **Test chat voice** / **Skip spoken message** — Hear how chat is read aloud; stop the current message and clear the queue
- **Hide preview** — Hide your own preview (you stay live; saves CPU and battery)
- **Watch as viewer** — Open your channel the way viewers see it (real mediasoup consumer path)
- **Clip** — Create a clip from the live stream
- **Media requests** — Media request PiP player

### The live studio on a phone
On a phone (narrower than 760 px, or a phone turned sideways), a browser stream opens the live studio
(`public/js/broadcast-studio.js`): the camera fills the screen, the stream chat sits over the bottom of the picture,
and the controls sit on top. The top bar has LIVE, time live, people watching, restream status and connection, with
**End** (it asks first). The right-hand rail has Flip, Mute, Camera, Light (the torch, when the camera has one), Chat,
Clip (the last 30 seconds) and More, a sheet with share, watch as viewer, choose camera, screen, media requests, a
one-minute clip, chat read aloud, the restream controls, stream health, all settings and **Full page** (the classic
page, with a button back). The studio drives the same functions as the page and reads its counters.

### Viewer counts across platforms
A live stream's viewers are counted wherever it goes out (`server/streaming/viewer-places.js`): OpenVibe itself (the
larger of Chat's count and the player sockets'), RobotStreamer, and each restream destination of the stream's slot
(Twitch through Helix, Kick through its API, YouTube with a `youtube_api_key` site setting; a platform that gives no
number is listed as live without one). `GET /api/streams/channel/:username` gives each live stream these
`viewer_places`. The channel player's count and the broadcaster's (the go-live page, the OBS/JSMPEG/WHIP panels and the
phone studio) are their sum, and a tap on the player's count or the studio's lists them (`public/js/viewer-places.js`).
The broadcaster's page reads the same answer every 20 seconds, so both sides see one number.

### Stream Chat
The broadcast page includes an embedded chat sidebar with:
- Full chat functionality (emotes, GIFs, TTS)
- **Pop Out Chat** button — opens chat in a separate window (lightweight WebSocket popup)
- User list and chat settings
- Mobile: floating action button to toggle chat overlay

### Disconnect Handling
- Visual disconnect alert banner when the connection drops (a browser broadcast's connection, or the
  encoder's RTMP feed stopping after it was received)
- **Audible alert** — opt-in audio beep on disconnect (enable in Audio settings → "Disconnect Sound Alert",
  or Alerts → "Disconnect Audio" in the encoder settings; one preference, kept in this browser)
- **Low-bitrate alert** — opt-in (Audio settings → "Low Bitrate Alert"): when a browser broadcast's upload
  stays under 30% of its target bitrate for about 18 seconds, a warning and a lower beep, once until it recovers
- Automatic reconnection with exponential backoff (3s → 30s max)
- Connection status indicator (protocol name when connected, status when not)

### RTMP Preview
When using RTMP, the page shows your stream's live thumbnail (`/api/thumbnails/stream-<id>-live.jpg`),
checked every 10 seconds. Live thumbnails, the ones the live cards show too, are refreshed about every
2 minutes: the server grabs a frame from RTMP, JSMPEG and WebRTC/WHIP streams, and a browser broadcaster
with a visible tab posts its own.

## Multi-Stream
You can run multiple simultaneous streams (e.g., different cameras). Each gets its own tab in the broadcast page with independent controls and viewer counts.

## Stream Settings
Configurable per-stream settings include:
- Video resolution and frame rate
- Target bitrate
- Audio device selection
- TTS mode and voice settings
- Auto-reconnect behavior
- Stream title and category

### What the browser encoder is asked for
A browser broadcast reaches the SFU through mediasoup-client (`public/js/broadcast.js`, `_handleSfuProduceRequest`;
the options come from `sfuVideoProduceOptions` in `broadcast-state.js`):
- **Codec:** the settings' Codec Preference (VP8 or H.264). Under Auto, a phone or tablet sends **H.264**, which its
  hardware encodes, and a computer sends the router's first codec (VP8). Screen shares stay on the router's first codec.
  The recorder, restreams, live thumbnails and AI vision build their pipelines from the producer's codec, as they do
  for H.264 from OBS over WHIP.
- **Limits:** Max Bitrate and FPS are the encoding's `maxBitrate` and `maxFramerate`, and the start bitrate is
  `min(2500, target)` kbps. A camera keeps its frame rate under pressure (`degradationPreference: maintain-framerate`:
  resolution drops first); a screen share keeps its detail.
- **Changed while live:** resolution, frame rate and bitrate apply without a restart (`applyBroadcastQuality`: the
  camera's `applyConstraints` and the producer's encoding parameters), from the settings or the phone studio's Video
  quality.
- **Battery saver** (`openvibe_battery_saver` in localStorage, this device only): 480p, 30 fps, at most 1 Mbps.
- The browser's own VOD recorder is only a fallback: it starts when `GET /api/vods/stream/:id/recording` says the
  server is not recording the stream after about 24 seconds, never when the channel records nothing, and it stops when
  the server refuses a slice (403).
- On a phone, the frame watchdog reads the camera track's frame count (MediaStreamTrack stats) instead of copying a
  frame every second (a computer still copies one each second: that keeps PipeWire capture awake).
