#!/bin/bash
# OpenVibe.Live — Quick Start Script
# Streams from local camera to OpenVibe.Live via JSMPEG (MPEG-TS)
#
# Usage:
#   ./start-stream.sh YOUR_STREAM_KEY [SERVER] [PORT]
#
# Examples:
#   ./start-stream.sh abc123def456
#   ./start-stream.sh abc123def456 openvibe.live 9710
#   MODE=screen ./start-stream.sh abc123def456              # Screen capture
#   MODE=obs ./start-stream.sh abc123def456                 # OBS virtual camera
#   MODE=audioonly ./start-stream.sh abc123def456            # Audio only
#   AUDIO=pulse ./start-stream.sh abc123def456              # Use PulseAudio
#   NOAUDIO=1 ./start-stream.sh abc123def456                # Disable audio
#   VIDEO_DEV=/dev/video2 ./start-stream.sh abc123def456    # Custom camera
#
# Environment variables:
#   MODE         - camera (default), screen, obs, audioonly
#   RESOLUTION   - e.g. 640x480, 1280x720 (default: 640x480)
#   FPS          - Frames per second (default: 24)
#   BITRATE      - Video bitrate (default: 800k)
#   AUDIO_BITRATE- Audio bitrate (default: 128k)
#   AUDIO        - alsa (default) or pulse
#   NOAUDIO      - Set to 1 to disable audio
#   VIDEO_DEV    - Camera device path (auto-detected if unset)

set -e

KEY="${1:?Usage: $0 STREAM_KEY [SERVER] [PORT]}"
SERVER="${2:-localhost}"
PORT="${3:-9710}"
RESOLUTION="${RESOLUTION:-640x480}"
FPS="${FPS:-24}"
BITRATE="${BITRATE:-800k}"
AUDIO_BITRATE="${AUDIO_BITRATE:-128k}"
AUDIO="${AUDIO:-alsa}"
MODE="${MODE:-camera}"

echo ""
echo "🏕️  OpenVibe.Live — JSMPEG Stream"
echo "   Server : $SERVER:$PORT"
echo "   Mode   : $MODE"
echo ""

# ── Helper: find video device ─────────────────────────────────
find_video_device() {
    if [ -n "$VIDEO_DEV" ] && [ -e "$VIDEO_DEV" ]; then
        echo "$VIDEO_DEV"
        return
    fi
    for dev in /dev/video0 /dev/video1 /dev/video2 /dev/video3; do
        if [ -e "$dev" ]; then
            # Check it's actually a capture device (not metadata)
            if v4l2-ctl -d "$dev" --all 2>/dev/null | grep -q "Video Capture"; then
                echo "$dev"
                return
            fi
        fi
    done
    # Fallback
    if [ -e /dev/video0 ]; then echo "/dev/video0"; return; fi
    echo ""
}

# ── Helper: find audio source ─────────────────────────────────
get_audio_args() {
    if [ "${NOAUDIO}" = "1" ]; then
        echo "-an"
        return
    fi
    if [ "$AUDIO" = "pulse" ]; then
        echo "-f pulse -i default -codec:a mp2 -b:a ${AUDIO_BITRATE} -ar 44100 -ac 1"
        return
    fi
    # ALSA
    if arecord -l 2>/dev/null | grep -q "card"; then
        echo "-f alsa -i default -codec:a mp2 -b:a ${AUDIO_BITRATE} -ar 44100 -ac 1"
    elif pactl list short sources 2>/dev/null | grep -q ""; then
        echo "-f pulse -i default -codec:a mp2 -b:a ${AUDIO_BITRATE} -ar 44100 -ac 1"
    else
        echo "   ⚠  No audio device found — streaming video only" >&2
        echo "-an"
    fi
}

AUDIO_ARGS=$(get_audio_args)

case "$MODE" in
    camera)
        VIDEO_DEVICE=$(find_video_device)
        if [ -z "$VIDEO_DEVICE" ]; then
            echo "[ERROR] No video device found. Run: v4l2-ctl --list-devices"
            echo "        Or set VIDEO_DEV=/dev/videoX"
            exit 1
        fi
        echo "   Video  : $VIDEO_DEVICE ($RESOLUTION @ ${FPS}fps)"
        echo "   Bitrate: $BITRATE"
        [ "${NOAUDIO}" != "1" ] && echo "   Audio  : ${AUDIO} (${AUDIO_BITRATE})"
        echo "   Press Ctrl+C to stop."
        echo ""
        exec ffmpeg \
            -f v4l2 -framerate "$FPS" -video_size "$RESOLUTION" -i "$VIDEO_DEVICE" \
            $AUDIO_ARGS \
            -f mpegts -codec:v mpeg1video -s "$RESOLUTION" -b:v "$BITRATE" -r "$FPS" -bf 0 \
            -muxdelay 0.001 \
            "http://${SERVER}:${PORT}/${KEY}/${RESOLUTION/x//}/"
        ;;
    screen)
        SCREEN_RES="${SCREEN_RES:-1920x1080}"
        DISPLAY_ID="${DISPLAY_ID:-:0.0}"
        echo "   Screen : $DISPLAY_ID ($SCREEN_RES)"
        echo "   Output : $RESOLUTION @ ${FPS}fps"
        echo "   Bitrate: $BITRATE"
        [ "${NOAUDIO}" != "1" ] && echo "   Audio  : pulse (${AUDIO_BITRATE})"
        echo "   Press Ctrl+C to stop."
        echo ""
        SCREEN_AUDIO="-f pulse -i default -codec:a mp2 -b:a ${AUDIO_BITRATE} -ar 44100 -ac 1"
        [ "${NOAUDIO}" = "1" ] && SCREEN_AUDIO="-an"
        exec ffmpeg \
            -f x11grab -s "$SCREEN_RES" -r "$FPS" -i "$DISPLAY_ID" \
            $SCREEN_AUDIO \
            -f mpegts -codec:v mpeg1video -s "$RESOLUTION" -b:v "$BITRATE" -r "$FPS" -bf 0 \
            -muxdelay 0.001 \
            "http://${SERVER}:${PORT}/${KEY}/${RESOLUTION/x//}/"
        ;;
    obs)
        OBS_DEVICE="${VIDEO_DEV:-/dev/video2}"
        if [ ! -e "$OBS_DEVICE" ]; then
            echo "[ERROR] OBS virtual camera not found at $OBS_DEVICE"
            echo "        Start OBS → Tools → Start Virtual Camera"
            echo "        Then check: v4l2-ctl --list-devices"
            exit 1
        fi
        echo "   OBS    : $OBS_DEVICE ($RESOLUTION @ ${FPS}fps)"
        echo "   Bitrate: $BITRATE"
        [ "${NOAUDIO}" != "1" ] && echo "   Audio  : pulse (${AUDIO_BITRATE})"
        echo "   Press Ctrl+C to stop."
        echo ""
        OBS_AUDIO="-f pulse -i default -codec:a mp2 -b:a ${AUDIO_BITRATE} -ar 44100 -ac 1"
        [ "${NOAUDIO}" = "1" ] && OBS_AUDIO="-an"
        exec ffmpeg \
            -f v4l2 -framerate "$FPS" -video_size "$RESOLUTION" -i "$OBS_DEVICE" \
            $OBS_AUDIO \
            -f mpegts -codec:v mpeg1video -s "$RESOLUTION" -b:v "$BITRATE" -r "$FPS" -bf 0 \
            -muxdelay 0.001 \
            "http://${SERVER}:${PORT}/${KEY}/${RESOLUTION/x//}/"
        ;;
    audioonly)
        AUDIO_PORT="${4:-9711}"
        echo "   Audio  : ${AUDIO} (${AUDIO_BITRATE})"
        echo "   Port   : $AUDIO_PORT"
        echo "   Press Ctrl+C to stop."
        echo ""
        if [ "$AUDIO" = "pulse" ]; then
            exec ffmpeg -f pulse -i default \
                -f mpegts -codec:a mp2 -b:a "$AUDIO_BITRATE" -ar 44100 -ac 1 \
                "http://${SERVER}:${AUDIO_PORT}/${KEY}/"
        else
            exec ffmpeg -f alsa -i default \
                -f mpegts -codec:a mp2 -b:a "$AUDIO_BITRATE" -ar 44100 -ac 1 \
                "http://${SERVER}:${AUDIO_PORT}/${KEY}/"
        fi
        ;;
    *)
        echo "[ERROR] Unknown mode: $MODE"
        echo "        Supported: camera, screen, obs, audioonly"
        exit 1
        ;;
esac
