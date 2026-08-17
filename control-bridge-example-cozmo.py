#!/usr/bin/env python3
"""
OpenVibe.Live — Generic Hardware Bridge
Auto-generated for: goosely
Control Profile: Cozmo

Connects to OpenVibe.Live and receives control commands from viewers.
Edit the handle_command() function to control your hardware.

Requirements:
    pip install websocket-client

Usage:
    python3 generic-bridge-cozmo.py
"""
import json
import time
import threading

try:
    import websocket
except ImportError:
    print("Missing websocket-client: pip install websocket-client")
    exit(1)

# ── Connection Settings ──────────────────────────────────────
WS_URL = "wss://openvibe.live/ws/control?mode=hardware&stream_key=a959da5f2f6148d4b00e6717b60f2946"
RECONNECT_DELAY = 5

# ── Profile Buttons ──────────────────────────────────────────
# These are the buttons configured in your "Cozmo" profile.
# Each entry has: command, label, type, key_binding
BUTTONS = [
        {
            "command": "forward",
            "label": "Forward",
            "type": "keyboard",
            "key_binding": "w"
        },
        {
            "command": "back",
            "label": "Back",
            "type": "keyboard",
            "key_binding": "s"
        },
        {
            "command": "left",
            "label": "Left",
            "type": "keyboard",
            "key_binding": "a"
        },
        {
            "command": "right",
            "label": "Right",
            "type": "keyboard",
            "key_binding": "d"
        },
        {
            "command": "look_up",
            "label": "Look Up",
            "type": "keyboard",
            "key_binding": "e"
        },
        {
            "command": "look_down",
            "label": "Look Down",
            "type": "keyboard",
            "key_binding": "q"
        },
        {
            "command": "lift_up",
            "label": "Lift Up",
            "type": "keyboard",
            "key_binding": "r"
        },
        {
            "command": "lift_down",
            "label": "Lift Down",
            "type": "keyboard",
            "key_binding": "f"
        },
        {
            "command": "light",
            "label": "Toggle Light",
            "type": "keyboard",
            "key_binding": "c"
        }
    ]

# ══════════════════════════════════════════════════════════════
#  COMMAND HANDLERS — Edit these to control your hardware!
# ══════════════════════════════════════════════════════════════

def handle_command(command, from_user):
    """Called when a viewer presses a button (one-shot)."""
    print(f"[Command] {from_user} -> {command}")
    # ── Add your hardware logic here ──
    # Examples:
    #   if command == "forward":
    #       my_robot.move_forward()
    #   elif command == "fire":
    #       GPIO.output(RELAY_PIN, GPIO.HIGH)
    # forward: Forward (keyboard)
    # back: Back (keyboard)
    # left: Left (keyboard)
    # right: Right (keyboard)
    # look_up: Look Up (keyboard)
    # look_down: Look Down (keyboard)
    # lift_up: Lift Up (keyboard)
    # lift_down: Lift Down (keyboard)
    # light: Toggle Light (keyboard)


def handle_key_down(command, from_user):
    """Called when a viewer holds a keyboard-type key down."""
    print(f"[Key Down] {from_user} -> {command}")
    # Add continuous action start here


def handle_key_up(command, from_user):
    """Called when a viewer releases a keyboard-type key."""
    print(f"[Key Up] {from_user} -> {command}")
    # Add continuous action stop here


def handle_video_click(x, y, from_user):
    """Called when a viewer clicks on the video (if enabled)."""
    print(f"[Click] {from_user} -> ({x:.2f}, {y:.2f})")
    # x and y are 0.0-1.0 coordinates on the video


# ══════════════════════════════════════════════════════════════
#  BRIDGE (no need to edit below unless customizing)
# ══════════════════════════════════════════════════════════════

class HardwareBridge:
    def __init__(self):
        self.running = True
        self.held_keys = set()

    def on_message(self, ws, message):
        try:
            msg = json.loads(message)
            msg_type = msg.get("type", "")
            cmd = msg.get("command", "")
            user = msg.get("from_user", "?")

            if msg_type == "command":
                handle_command(cmd, user)
            elif msg_type == "key_down":
                self.held_keys.add(cmd)
                handle_key_down(cmd, user)
            elif msg_type == "key_up":
                self.held_keys.discard(cmd)
                handle_key_up(cmd, user)
            elif msg_type == "video_click":
                handle_video_click(msg.get("x", 0.5), msg.get("y", 0.5), user)
        except Exception as e:
            print(f"[Error] {e}")

    def on_open(self, ws):
        print("[Connected] Listening for commands...")
        print(f"[Profile] {len(BUTTONS)} buttons loaded from 'Cozmo'")
        ws.send(json.dumps({"type": "status", "connected": True}))

    def on_close(self, ws, code, reason):
        print(f"[Disconnected] code={code}")
        self.held_keys.clear()

    def on_error(self, ws, error):
        print(f"[WS Error] {error}")

    def run(self):
        print(f"Connecting to OpenVibe.Live as hardware bridge...")
        print(f"Profile: Cozmo ({len(BUTTONS)} buttons)")
        print(f"Commands: {', '.join(b['command'] for b in BUTTONS)}")
        print()
        while self.running:
            try:
                ws = websocket.WebSocketApp(WS_URL,
                    on_message=self.on_message,
                    on_open=self.on_open,
                    on_close=self.on_close,
                    on_error=self.on_error)
                ws.run_forever(ping_interval=30)
            except Exception as e:
                print(f"[Error] {e}")
            if self.running:
                print(f"Reconnecting in {RECONNECT_DELAY}s...")
                time.sleep(RECONNECT_DELAY)


if __name__ == "__main__":
    bridge = HardwareBridge()
    try:
        bridge.run()
    except KeyboardInterrupt:
        print("\nBye!")