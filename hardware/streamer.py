#!/usr/bin/env python3
"""
OpenVibe.Live — FFmpeg Streamer Script
Captures video/audio from Raspberry Pi camera + mic and streams
to OpenVibe.Live via JSMPEG (HTTP POST of MPEG-TS) or RTMP.

Usage:
    python3 streamer.py --key YOUR_STREAM_KEY --server openvibe.live
    python3 streamer.py --key YOUR_STREAM_KEY --protocol rtmp --server openvibe.live

Requirements:
    - FFmpeg installed (apt install ffmpeg)
    - Camera: USB cam or Pi Camera (v4l2)
    - Microphone: USB mic or built-in (ALSA)
"""

import argparse
import subprocess
import sys
import signal
import os

DEFAULT_SERVER = "localhost"
DEFAULT_VIDEO_PORT = 9710
DEFAULT_RTMP_PORT = 1935

def get_video_device():
    """Find available video device."""
    for dev in ["/dev/video0", "/dev/video1"]:
        if os.path.exists(dev):
            return dev
    return None

def get_audio_device():
    """Find available ALSA audio device."""
    try:
        result = subprocess.run(["arecord", "-l"], capture_output=True, text=True)
        if "card" in result.stdout.lower():
            return "default"
    except FileNotFoundError:
        pass
    return None

def build_jsmpeg_command(args):
    """Build FFmpeg command for JSMPEG streaming (MPEG-TS over HTTP POST)."""
    video_dev = args.video_device or get_video_device()
    audio_dev = args.audio_device or get_audio_device()

    if not video_dev:
        print("[ERROR] No video device found. Specify with --video-device")
        sys.exit(1)

    cmd = ["ffmpeg"]

    # Input: video
    cmd += ["-f", "v4l2", "-framerate", str(args.fps), "-video_size", args.resolution, "-i", video_dev]

    # Input: audio (if available)
    if audio_dev and not args.no_audio:
        cmd += ["-f", "alsa", "-i", audio_dev]

    # Video encoding: MPEG1 for JSMPEG
    cmd += [
        "-c:v", "mpeg1video",
        "-b:v", f"{args.bitrate}k",
        "-r", str(args.fps),
        "-bf", "0",
    ]

    # Audio encoding
    if audio_dev and not args.no_audio:
        cmd += ["-c:a", "mp2", "-ar", "44100", "-ac", "1", "-b:a", "64k"]
    else:
        cmd += ["-an"]

    # Output: HTTP POST to JSMPEG relay
    url = f"http://{args.server}:{args.video_port}/{args.key}"
    cmd += ["-f", "mpegts", url]

    return cmd

def build_rtmp_command(args):
    """Build FFmpeg command for RTMP streaming."""
    video_dev = args.video_device or get_video_device()
    audio_dev = args.audio_device or get_audio_device()

    if not video_dev:
        print("[ERROR] No video device found. Specify with --video-device")
        sys.exit(1)

    cmd = ["ffmpeg"]

    # Input: video
    cmd += ["-f", "v4l2", "-framerate", str(args.fps), "-video_size", args.resolution, "-i", video_dev]

    # Input: audio
    if audio_dev and not args.no_audio:
        cmd += ["-f", "alsa", "-i", audio_dev]

    # Video encoding: H.264
    cmd += [
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-b:v", f"{args.bitrate}k",
        "-maxrate", f"{args.bitrate}k",
        "-bufsize", f"{args.bitrate * 2}k",
        "-g", str(args.fps * 2),
    ]

    # Audio encoding: AAC
    if audio_dev and not args.no_audio:
        cmd += ["-c:a", "aac", "-ar", "44100", "-ac", "1", "-b:a", "96k"]
    else:
        cmd += ["-an"]

    # Output: RTMP
    url = f"rtmp://{args.server}:{args.rtmp_port}/live/{args.key}"
    cmd += ["-f", "flv", url]

    return cmd

def main():
    parser = argparse.ArgumentParser(description="OpenVibe.Live — Stream from Raspberry Pi / Linux")
    parser.add_argument("--key", required=True, help="Your OpenVibe.Live stream key")
    parser.add_argument("--server", default=DEFAULT_SERVER, help=f"Server hostname (default: {DEFAULT_SERVER})")
    parser.add_argument("--protocol", choices=["jsmpeg", "rtmp"], default="jsmpeg", help="Streaming protocol")
    parser.add_argument("--video-device", help="Video device path (e.g. /dev/video0)")
    parser.add_argument("--audio-device", help="ALSA audio device (e.g. default, hw:1,0)")
    parser.add_argument("--resolution", default="640x480", help="Video resolution (default: 640x480)")
    parser.add_argument("--fps", type=int, default=24, help="Frames per second (default: 24)")
    parser.add_argument("--bitrate", type=int, default=800, help="Video bitrate in kbps (default: 800)")
    parser.add_argument("--video-port", type=int, default=DEFAULT_VIDEO_PORT, help=f"JSMPEG video port (default: {DEFAULT_VIDEO_PORT})")
    parser.add_argument("--rtmp-port", type=int, default=DEFAULT_RTMP_PORT, help=f"RTMP port (default: {DEFAULT_RTMP_PORT})")
    parser.add_argument("--no-audio", action="store_true", help="Disable audio")
    parser.add_argument("--dry-run", action="store_true", help="Print FFmpeg command without running")
    args = parser.parse_args()

    if args.protocol == "jsmpeg":
        cmd = build_jsmpeg_command(args)
    else:
        cmd = build_rtmp_command(args)

    print(f"\n🏕️  OpenVibe.Live — {args.protocol.upper()} Streaming")
    print(f"   Server : {args.server}")
    print(f"   Video  : {args.resolution} @ {args.fps}fps, {args.bitrate}kbps")
    print(f"   Audio  : {'disabled' if args.no_audio else 'enabled'}")
    print(f"   Command: {' '.join(cmd)}\n")

    if args.dry_run:
        print("[DRY RUN] Command not executed.")
        return

    # Run FFmpeg
    proc = None
    def signal_handler(sig, frame):
        print("\n[INFO] Stopping stream...")
        if proc:
            proc.terminate()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    print("[INFO] Starting stream... Press Ctrl+C to stop.")
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        _, stderr = proc.communicate()
        if proc.returncode != 0:
            print(f"[ERROR] FFmpeg exited with code {proc.returncode}")
            print(stderr.decode()[-500:] if stderr else "")
    except FileNotFoundError:
        print("[ERROR] FFmpeg not found. Install with: sudo apt install ffmpeg")
        sys.exit(1)

if __name__ == "__main__":
    main()
