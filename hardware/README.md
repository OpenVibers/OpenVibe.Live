# OpenVibe.Live — Hardware Integration

Scripts for streaming from and controlling hardware devices (Raspberry Pi, single-board computers, etc.) with OpenVibe.Live.

## Requirements

- **Python 3.7+**
- **FFmpeg** — `sudo apt install ffmpeg`
- **websocket-client** — `pip3 install websocket-client`
- For TTS: **espeak** — `sudo apt install espeak`
- For GPIO: **gpiozero** — `pip3 install gpiozero` (Raspberry Pi only)
- For PulseAudio/PipeWire audio: **pulseaudio-utils** — `sudo apt install pulseaudio-utils`

## Quick Start (Bash Script)

The easiest way to stream. Supports camera, screen capture, OBS virtual camera, and audio-only modes.

```bash
# Basic camera stream
./scripts/start-stream.sh YOUR_STREAM_KEY localhost 9710

# Screen capture
MODE=screen ./scripts/start-stream.sh YOUR_KEY localhost 9710

# OBS Virtual Camera → JSMPEG
MODE=obs ./scripts/start-stream.sh YOUR_KEY localhost 9710

# Audio only (no video)
MODE=audioonly ./scripts/start-stream.sh YOUR_KEY localhost 9711

# HD 720p with PulseAudio
RESOLUTION=1280x720 BITRATE=1200k AUDIO=pulse FPS=30 ./scripts/start-stream.sh YOUR_KEY localhost 9710

# Disable audio
NOAUDIO=1 ./scripts/start-stream.sh YOUR_KEY localhost 9710

# Custom camera device
VIDEO_DEV=/dev/video2 ./scripts/start-stream.sh YOUR_KEY localhost 9710
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODE` | camera | `camera`, `screen`, `obs`, or `audioonly` |
| `RESOLUTION` | 640x480 | Video resolution |
| `FPS` | 24 | Frames per second |
| `BITRATE` | 800k | Video bitrate |
| `AUDIO_BITRATE` | 128k | Audio bitrate |
| `AUDIO` | alsa | `alsa` or `pulse` |
| `NOAUDIO` | 0 | Set to `1` to disable audio |
| `VIDEO_DEV` | auto | Camera device path (e.g. `/dev/video0`) |
| `SCREEN_RES` | 1920x1080 | Screen capture resolution (screen mode only) |
| `DISPLAY_ID` | :0.0 | X11 display (screen mode only) |

## Finding Your Devices

### Camera / Video

```bash
# List all video devices
v4l2-ctl --list-devices

# List supported formats and resolutions
v4l2-ctl -d /dev/video0 --list-formats-ext

# Test camera with a snapshot
ffmpeg -f v4l2 -i /dev/video0 -frames 1 test.jpg

# macOS: list devices
ffmpeg -f avfoundation -list_devices true -i ""
```

### Audio / Microphone

```bash
# List ALSA audio devices
arecord -l

# List PulseAudio / PipeWire sources
pactl list short sources

# Test microphone (record 5 seconds, play back)
arecord -d 5 -f cd test.wav && aplay test.wav

# PipeWire users — check audio sources
pw-cli list-objects | grep -A2 "node.name"
```

### OBS Virtual Camera

```bash
# 1. Start OBS Studio
# 2. Go to Tools → Start Virtual Camera
# 3. Check which device it created:
v4l2-ctl --list-devices
# Usually appears as /dev/video2 or /dev/video4

# 4. Stream it (with PulseAudio for desktop audio):
ffmpeg -f v4l2 -i /dev/video2 -f pulse -i default \
  -f mpegts -codec:v mpeg1video -s 640x480 -b:v 500k -bf 0 \
  -codec:a mp2 -b:a 128k -ar 44100 -ac 1 -muxdelay 0.001 \
  http://SERVER:PORT/KEY/640/480/
```

### Raspberry Pi Camera (libcamera)

```bash
# Test if camera works
libcamera-hello -t 5000

# Stream via pipe to FFmpeg
libcamera-vid -t 0 --inline --codec mjpeg --width 640 --height 480 -o - | \
  ffmpeg -i pipe:0 -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k -bf 0 \
  -muxdelay 0.001 http://SERVER:PORT/KEY/640/480/

# With audio
libcamera-vid -t 0 --inline --codec mjpeg --width 640 --height 480 -o - | \
  ffmpeg -i pipe:0 -f alsa -i default \
  -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k -bf 0 \
  -codec:a mp2 -b:a 128k -ar 44100 -ac 1 -muxdelay 0.001 \
  http://SERVER:PORT/KEY/640/480/
```

## FFmpeg Command Reference

### JSMPEG Constraints

JSMPEG uses canvas-based MPEG1 decoding. You **must** use:
- Video codec: `mpeg1video` (not h264/h265)
- Audio codec: `mp2` (not aac/opus)
- Container: `mpegts`
- No B-frames: `-bf 0`

### Common FFmpeg Flags

| Flag | Description | Example |
|------|-------------|---------|
| `-f v4l2` | Linux camera input | `-f v4l2 -i /dev/video0` |
| `-f avfoundation` | macOS camera input | `-f avfoundation -i "0:0"` |
| `-f x11grab` | Screen capture | `-f x11grab -s 1920x1080 -i :0.0` |
| `-f alsa` | ALSA audio input | `-f alsa -i default` |
| `-f pulse` | PulseAudio input | `-f pulse -i default` |
| `-s WxH` | Output resolution | `-s 640x480` |
| `-b:v` | Video bitrate | `-b:v 800k` |
| `-b:a` | Audio bitrate | `-b:a 128k` |
| `-r` | Frame rate | `-r 30` |
| `-ar` | Audio sample rate | `-ar 44100` |
| `-ac` | Audio channels | `-ac 1` (mono), `-ac 2` (stereo) |
| `-bf 0` | Disable B-frames | Required for JSMPEG |
| `-q:v` | Quality (2=best, 31=worst) | `-q:v 5` |
| `-muxdelay` | Mux delay (lower = less latency) | `-muxdelay 0.001` |
| `-framerate` | Input capture FPS | `-framerate 30` |
| `-video_size` | Input capture resolution | `-video_size 1280x720` |

### Recommended Presets

| Device | Resolution | Video Bitrate | Audio | Notes |
|--------|-----------|---------------|-------|-------|
| Pi Zero | 320x240 | 200k | 64k mono | Use `-r 15` for stability |
| Pi 3/4 | 640x480 | 350–500k | 128k mono | Good balance |
| Desktop | 1280x720 | 800k–1.5M | 128k stereo | Smooth 30fps |
| High Quality | 1920x1080 | 2–4M | 192k stereo | Requires good upload |

## Streamer Script (Python)

Captures video (USB camera / Pi Camera) and audio (ALSA mic), then pushes to OpenVibe.Live via JSMPEG or RTMP.

```bash
# JSMPEG streaming (recommended for low-latency)
python3 streamer.py --key YOUR_STREAM_KEY --server openvibe.live

# RTMP streaming (for OBS compatibility)
python3 streamer.py --key YOUR_STREAM_KEY --server openvibe.live --protocol rtmp

# Custom settings
python3 streamer.py --key YOUR_KEY --server openvibe.live \
  --resolution 1280x720 --fps 30 --bitrate 1500 \
  --video-device /dev/video0 --audio-device default
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--key` | (required) | Stream key from dashboard |
| `--server` | localhost | OpenVibe.Live server |
| `--protocol` | jsmpeg | `jsmpeg` or `rtmp` |
| `--resolution` | 640x480 | Video resolution |
| `--fps` | 24 | Frames per second |
| `--bitrate` | 800 | Video bitrate (kbps) |
| `--no-audio` | false | Disable audio capture |
| `--dry-run` | false | Print command without running |

## Controller Script

Connects to OpenVibe.Live control WebSocket and executes viewer commands on the hardware (motors, servos, LEDs, TTS).

```bash
# Basic (simulation mode — prints commands)
python3 controller.py --key YOUR_STREAM_KEY --server openvibe.live

# With GPIO enabled (Raspberry Pi)
python3 controller.py --key YOUR_KEY --server openvibe.live \
  --enable-gpio --config gpio-config.json
```

### GPIO Config Example

Create `gpio-config.json`:

```json
{
    "gpio": {
        "motor_left": { "forward": 17, "backward": 18 },
        "motor_right": { "forward": 22, "backward": 23 },
        "servos": { "tilt": 12, "pan": 13 },
        "leds": { "main": 25, "status": 24 }
    }
}
```

### Supported Commands

| Command | Action | Hardware |
|---------|--------|----------|
| `forward` | Move forward 0.5s | Motors |
| `backward` | Move backward 0.5s | Motors |
| `left` | Turn left 0.3s | Motors |
| `right` | Turn right 0.3s | Motors |
| `stop` | Stop all motors | Motors |
| `tts` | Text-to-speech | espeak |
| `led_on` | Turn LED on | GPIO |
| `led_off` | Turn LED off | GPIO |
| `horn` | Play horn sound | Speaker |
| `servo_up` | Tilt servo up | Servo |
| `servo_down` | Tilt servo down | Servo |
| `servo_center` | Center servo | Servo |

## Raspberry Pi Setup

```bash
# Install system dependencies
sudo apt update
sudo apt install ffmpeg espeak python3-pip pulseaudio-utils

# Install Python packages
pip3 install websocket-client gpiozero

# Enable camera
sudo raspi-config  # Interface Options → Camera → Enable

# Test camera
ffmpeg -f v4l2 -i /dev/video0 -frames 1 test.jpg

# Run both scripts
python3 streamer.py --key YOUR_KEY --server openvibe.live &
python3 controller.py --key YOUR_KEY --server openvibe.live --enable-gpio
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No video device | Run `ls /dev/video*`. If empty, check camera connection. Try `sudo modprobe uvcvideo`. |
| No audio device | Run `arecord -l`. If empty, plug in a USB mic or check `pulseaudio --check`. |
| Device busy | Close other camera apps (OBS, Cheese, etc.) and retry. |
| Connection refused | Check server is running. Check firewall: `sudo ufw allow 9710`. |
| High latency | Lower resolution, reduce bitrate, ensure `-muxdelay 0.001`. |
| Choppy video | Upload bandwidth too low for bitrate. Reduce `-b:v` or resolution. |
| Permission denied | `sudo usermod -aG video $USER` then log out/in. |
| macOS camera | Use `-f avfoundation -i "0:0"` instead of `-f v4l2 -i /dev/video0`. |
| PipeWire no sound | Use `-f pulse -i default` (PipeWire is PulseAudio-compatible). |
