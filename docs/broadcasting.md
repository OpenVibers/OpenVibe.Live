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

### JSMPEG (FFmpeg)
- **Best for**: Headless/embedded streaming (Raspberry Pi, IP cameras, 3D printers)
- **Latency**: ~1 second
- **Setup**: Run FFmpeg command with the provided endpoint
- **Features**: Flexible input sources, low resource usage

## Broadcast Page Features

### Live Controls
When streaming via WebRTC browser, you have access to:
- **Stop Stream** — End the broadcast
- **Switch Cam** — Change camera device
- **Screen Share** — Share screen/window/tab
- **Cam PiP** — Picture-in-Picture camera overlay on screen share
- **Mic** — Toggle microphone
- **Stats** — Show bitrate, FPS, resolution, codec overlay
- **Preview** — Toggle self-preview on/off (saves CPU)
- **Viewer** — Open a popup showing exactly what viewers see (real mediasoup consumer path)
- **Clip** — Create a clip from the live stream
- **Media** — Media request PiP player

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
