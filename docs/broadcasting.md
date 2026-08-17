# Broadcasting Guide

OpenVibe.Live supports three live broadcast protocols, each suited to different use cases.

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
- Visual disconnect alert banner when connection drops
- **Audible alert** — opt-in audio beep on disconnect (enable in Audio settings → "Disconnect Sound Alert")
- Automatic reconnection with exponential backoff (3s → 30s max)
- Connection status indicator (protocol name when connected, status when not)

### RTMP/JSMPEG Preview
When using RTMP or JSMPEG, a live thumbnail preview refreshes every 10 seconds showing your stream output.

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
