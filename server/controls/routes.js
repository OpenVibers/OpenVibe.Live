/**
 * OpenVibe.Live — Controls API Routes
 * 
 * Config Profiles:
 * GET    /api/controls/configs              - List user's control configs
 * POST   /api/controls/configs              - Create a control config
 * GET    /api/controls/configs/:id          - Get config with buttons
 * PUT    /api/controls/configs/:id          - Update config name/description
 * DELETE /api/controls/configs/:id          - Delete config
 * POST   /api/controls/configs/:id/buttons  - Add button to config
 * PUT    /api/controls/configs/:id/buttons/:btnId - Update button
 * DELETE /api/controls/configs/:id/buttons/:btnId - Delete button
 * POST   /api/controls/configs/:id/activate - Activate config on channel
 * POST   /api/controls/configs/:id/apply/:streamId - Copy config to live stream
 * GET    /api/controls/configs/:id/bridge-script    - Generate per-profile Python bridge script
 * 
 * Per-Stream Controls (legacy):
 * GET    /api/controls/:streamId        - Get controls for a stream
 * POST   /api/controls/:streamId        - Add a control button
 * PUT    /api/controls/:streamId/:id    - Update a control
 * DELETE /api/controls/:streamId/:id    - Delete a control
 * POST   /api/controls/api-key          - Generate API key
 * GET    /api/controls/api-keys         - List user's API keys  
 */
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');

const router = express.Router();

// Helper: re-apply this config to live streams that are explicitly bound to it
function syncConfigToBoundLiveStreams(configId) {
    try {
        const liveStreams = db.getLiveStreamsByControlConfigId(configId);
        for (const stream of liveStreams) {
            try {
                db.applyConfigToStream(configId, stream.id);
            } catch (e) {
                console.warn(`[Controls] Failed to sync config ${configId} to stream ${stream.id}:`, e.message);
            }
        }
    } catch (e) {
        console.warn(`[Controls] syncConfigToBoundLiveStreams error:`, e.message);
    }
}

// ── CSS Value Sanitization (prevent injection) ───────────────
const CSS_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)|[a-zA-Z]{1,30}|var\(--[a-zA-Z0-9-]+\)|)$/;
function sanitizeCssColor(val) {
    if (!val || typeof val !== 'string') return '';
    const trimmed = val.trim().slice(0, 60);
    return CSS_COLOR_RE.test(trimmed) ? trimmed : '';
}

function generateCozmoScript(user, protocol, host) {
    return `#!/usr/bin/env python3
"""
OpenVibe.Live — Cozmo Hardware Bridge (v2)
Auto-generated for: ${user.username}

Connects your Cozmo robot to OpenVibe.Live so viewers can control it.
Supports: button commands, keyboard hold (key_down/key_up), video click (x,y).

Requirements:
    pip install pycozmo websocket-client

Usage:
    python3 cozmo-bridge.py
"""
import json
import time
import threading

try:
    import websocket
except ImportError:
    print("Missing websocket-client: pip install websocket-client")
    exit(1)

try:
    import pycozmo
except ImportError:
    pycozmo = None
    print("[Cozmo] pycozmo not installed — running in DRY RUN mode")

WS_URL = "${protocol}://${host}/ws/control?mode=hardware&stream_key=${user.stream_key}"
RECONNECT_DELAY = 5
DRIVE_SPEED = 100
TURN_SPEED = 80

# Commands that support continuous driving (key_down -> drive, key_up -> stop)
CONTINUOUS_COMMANDS = {
    'forward':    (DRIVE_SPEED, DRIVE_SPEED),
    'backward':   (-DRIVE_SPEED, -DRIVE_SPEED),
    'turn_left':  (-TURN_SPEED, TURN_SPEED),
    'turn_right': (TURN_SPEED, -TURN_SPEED),
}

def execute_command(cli, cmd):
    """Execute a one-shot command (button press)."""
    if cli is None:
        print(f"[DRY RUN] {cmd}")
        return
    movements = {
        'forward':    lambda: cli.drive_wheels(DRIVE_SPEED, DRIVE_SPEED, duration=0.5),
        'backward':   lambda: cli.drive_wheels(-DRIVE_SPEED, -DRIVE_SPEED, duration=0.5),
        'turn_left':  lambda: cli.drive_wheels(-TURN_SPEED, TURN_SPEED, duration=0.4),
        'turn_right': lambda: cli.drive_wheels(TURN_SPEED, -TURN_SPEED, duration=0.4),
        'lift_up':    lambda: cli.set_lift_height(1.0),
        'lift_down':  lambda: cli.set_lift_height(0.0),
        'head_up':    lambda: cli.set_head_angle(pycozmo.MAX_HEAD_ANGLE if pycozmo else 0.4),
        'head_down':  lambda: cli.set_head_angle(pycozmo.MIN_HEAD_ANGLE if pycozmo else -0.2),
        'stop':       lambda: cli.drive_wheels(0, 0),
    }
    if cmd in movements:
        try:
            movements[cmd]()
            print(f"[Cozmo] {cmd}")
        except Exception as e:
            print(f"[Cozmo] Error: {e}")
    elif cmd.startswith('anim_'):
        try:
            cli.play_anim_trigger(getattr(pycozmo.anim.Triggers, cmd[5:]))
        except AttributeError:
            print(f"[Cozmo] Unknown anim: {cmd}")
    else:
        print(f"[Cozmo] Unknown: {cmd}")


class CozmoBridge:
    def __init__(self):
        self.cozmo_cli = None
        self.running = True
        self.held_keys = set()  # Currently held commands
        self._drive_thread = None
        self._drive_lock = threading.Lock()

    def connect_cozmo(self):
        if pycozmo is None:
            return
        try:
            self.cozmo_cli = pycozmo.Client()
            self.cozmo_cli.start()
            self.cozmo_cli.wait_for_robot()
            print("[Cozmo] Connected!")
        except Exception as e:
            print(f"[Cozmo] Failed: {e}")

    def _continuous_drive_loop(self):
        """Background loop: while keys are held, keep sending drive commands."""
        while self.running:
            with self._drive_lock:
                keys = set(self.held_keys)
            if not keys:
                time.sleep(0.05)
                continue
            # Pick the most recent held key for driving
            for cmd in keys:
                if cmd in CONTINUOUS_COMMANDS:
                    left, right = CONTINUOUS_COMMANDS[cmd]
                    if self.cozmo_cli:
                        try:
                            self.cozmo_cli.drive_wheels(left, right, duration=0.2)
                        except Exception:
                            pass
                    else:
                        print(f"[DRY RUN] continuous {cmd}")
                    break
            time.sleep(0.15)

    def handle_key_down(self, msg):
        cmd = msg.get('command', '')
        user = msg.get('from_user', '?')
        print(f"[Key Down] {user} -> {cmd}")
        with self._drive_lock:
            self.held_keys.add(cmd)
        # Also handle non-continuous commands as one-shot
        if cmd not in CONTINUOUS_COMMANDS:
            execute_command(self.cozmo_cli, cmd)

    def handle_key_up(self, msg):
        cmd = msg.get('command', '')
        user = msg.get('from_user', '?')
        print(f"[Key Up] {user} -> {cmd}")
        with self._drive_lock:
            self.held_keys.discard(cmd)
        # If no more keys held, stop driving
        with self._drive_lock:
            remaining = set(self.held_keys)
        if not any(k in CONTINUOUS_COMMANDS for k in remaining):
            if self.cozmo_cli:
                try:
                    self.cozmo_cli.drive_wheels(0, 0)
                except Exception:
                    pass
            else:
                print("[DRY RUN] stop")

    def handle_video_click(self, msg):
        x = msg.get('x', 0.5)
        y = msg.get('y', 0.5)
        user = msg.get('from_user', '?')
        print(f"[Click] {user} -> ({x:.2f}, {y:.2f})")
        # Simple click-to-drive: turn toward click then drive forward
        if self.cozmo_cli is None:
            print(f"[DRY RUN] navigate to ({x:.2f}, {y:.2f})")
            return
        try:
            # x < 0.4 = turn left, x > 0.6 = turn right, else straight
            if x < 0.4:
                self.cozmo_cli.drive_wheels(-TURN_SPEED, TURN_SPEED, duration=0.3)
            elif x > 0.6:
                self.cozmo_cli.drive_wheels(TURN_SPEED, -TURN_SPEED, duration=0.3)
            time.sleep(0.1)
            # y < 0.4 = further away (drive more), y > 0.6 = closer (drive less)
            drive_time = 0.3 + (1.0 - y) * 0.7
            self.cozmo_cli.drive_wheels(DRIVE_SPEED, DRIVE_SPEED, duration=drive_time)
        except Exception as e:
            print(f"[Cozmo] Click navigate error: {e}")

    def on_message(self, ws, message):
        try:
            msg = json.loads(message)
            msg_type = msg.get('type', '')
            if msg_type == 'command':
                print(f"[Control] {msg.get('from_user','?')} -> {msg.get('command','')}")
                execute_command(self.cozmo_cli, msg.get('command', ''))
            elif msg_type == 'key_down':
                self.handle_key_down(msg)
            elif msg_type == 'key_up':
                self.handle_key_up(msg)
            elif msg_type == 'video_click':
                self.handle_video_click(msg)
        except Exception as e:
            print(f"[WS] Error: {e}")

    def on_open(self, ws):
        print("[WS] Connected to OpenVibe.Live!")
        # Tell server we're online so viewers get instant green-dot
        ws.send(json.dumps({"type": "status", "connected": True}))

    def on_close(self, ws, code, reason):
        print(f"[WS] Disconnected ({code})")
        # Stop driving on disconnect
        with self._drive_lock:
            self.held_keys.clear()

    def on_error(self, ws, error):
        print(f"[WS] Error: {error}")

    def run(self):
        self.connect_cozmo()
        # Start continuous drive thread
        self._drive_thread = threading.Thread(target=self._continuous_drive_loop, daemon=True)
        self._drive_thread.start()
        while self.running:
            try:
                ws = websocket.WebSocketApp(WS_URL,
                    on_message=self.on_message, on_open=self.on_open,
                    on_close=self.on_close, on_error=self.on_error)
                ws.run_forever(ping_interval=30)
            except Exception as e:
                print(f"[WS] {e}")
            if self.running:
                print(f"Reconnecting in {RECONNECT_DELAY}s...")
                time.sleep(RECONNECT_DELAY)

if __name__ == '__main__':
    bridge = CozmoBridge()
    try:
        bridge.run()
    except KeyboardInterrupt:
        bridge.running = False
        if bridge.cozmo_cli:
            bridge.cozmo_cli.stop()
        print("Bye!")
`;
}

function generateProfileBridgeScript({ user, config, buttons, protocol, host, type }) {
    const enabledButtons = buttons.filter(b => b.is_enabled !== 0);
    const commandList = enabledButtons.map(b => ({
        command: b.command,
        label: b.label,
        type: b.control_type || 'button',
        key_binding: b.key_binding || null,
    }));

    const commandsJson = JSON.stringify(commandList, null, 4).split('\n').map((l, i) => i === 0 ? l : '    ' + l).join('\n');

    if (type === 'cozmo') {
        return _generateCozmoProfileScript({ user, config, commandsJson, enabledButtons, protocol, host });
    }

    // Generic bridge script
    return `#!/usr/bin/env python3
"""
OpenVibe.Live — Generic Hardware Bridge
Auto-generated for: ${user.username}
Control Profile: ${config.name}

Connects to OpenVibe.Live and receives control commands from viewers.
Edit the handle_command() function to control your hardware.

Requirements:
    pip install websocket-client

Usage:
    python3 generic-bridge-${config.name.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.py
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
WS_URL = "${protocol}://${host}/ws/control?mode=hardware&stream_key=${user.stream_key}"
RECONNECT_DELAY = 5

# ── Profile Buttons ──────────────────────────────────────────
# These are the buttons configured in your "${config.name}" profile.
# Each entry has: command, label, type, key_binding
BUTTONS = ${commandsJson}

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
${enabledButtons.map(b => `    # ${b.command}: ${b.label} (${b.control_type || 'button'})`).join('\n')}


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
        print(f"[Profile] {len(BUTTONS)} buttons loaded from '${config.name}'")
        ws.send(json.dumps({"type": "status", "connected": True}))

    def on_close(self, ws, code, reason):
        print(f"[Disconnected] code={code}")
        self.held_keys.clear()

    def on_error(self, ws, error):
        print(f"[WS Error] {error}")

    def run(self):
        print(f"Connecting to OpenVibe.Live as hardware bridge...")
        print(f"Profile: ${config.name} ({enabledButtons.length} buttons)")
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
        print("\\nBye!")
`;
}

function _generateCozmoProfileScript({ user, config, commandsJson, enabledButtons, protocol, host }) {
    const keyboardButtons = enabledButtons.filter(b => b.control_type === 'keyboard');
    const buttonButtons   = enabledButtons.filter(b => b.control_type !== 'keyboard' && b.control_type !== 'onvif');
    const slugName = config.name.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();

    return `#!/usr/bin/env python3
"""
OpenVibe.Live — Cozmo Hardware Bridge
Auto-generated for:  ${user.username}
Control Profile:     ${config.name}
Generated:           ${new Date().toISOString().slice(0, 10)}

HOW IT WORKS
============
This script connects to OpenVibe.Live as a hardware bridge.
Viewer button presses are relayed to your Cozmo robot.

There are TWO button types — you can see them in your profile editor:

  [HOLD]   keyboard type  — sends key_down when pressed, key_up on release.
           Perfect for drive commands: hold the button → Cozmo keeps going.
           Release → Cozmo stops.  (SMOOTH mode only needs this!)

  [TAP]    button type    — sends a single "command" on each press.
           Ideal for face animations, one-shot actions, etc.

MODES
=====
  SMOOTH  (default) — drive commands use key_down/key_up for continuous drive.
                       Holding a button drives continuously; releasing stops.

  JUMPY   — every tap sends a short burst (JUMPY_BURST_DURATION seconds).
             Useful if you want snap-stop control without holding.
             Toggle with the "toggle_mode" command or 'X' button.

BUTTONS IN THIS PROFILE (${enabledButtons.length} total)
${keyboardButtons.length ? '  [HOLD]  ' + keyboardButtons.map(b => b.command + ' (' + b.label + ')').join(', ') : '  [HOLD]  (none)'}
${buttonButtons.length   ? '  [TAP]   ' + buttonButtons.map(b => b.command + ' (' + b.label + ')').join(', ') : '  [TAP]   (none)'}

REQUIREMENTS
============
  pip install pycozmo websocket-client Pillow

USAGE
=====
  python3 cozmo-bridge-${slugName}.py

  Set DRIVE_SPEED, TURN_SPEED, and JUMPY_BURST_DURATION to taste.
  Add your face/animation assets to custom_faces/ and mechaMG/ directories.
"""

import json
import os
import random
import threading
import time

try:
    import websocket
except ImportError:
    print("ERROR: Missing websocket-client. Run: pip install websocket-client")
    exit(1)

try:
    import pycozmo
    from pycozmo import MIN_LIFT_HEIGHT, MAX_LIFT_HEIGHT, MIN_HEAD_ANGLE, MAX_HEAD_ANGLE
    PYCOZMO_AVAILABLE = True
except ImportError:
    PYCOZMO_AVAILABLE = False
    print("[Cozmo] pycozmo not installed — running in DRY RUN mode")
    # Dummy constants for dry-run
    class _MinMax:
        def __init__(self, mm=0, radians=0): self.mm = mm; self.radians = radians
    MIN_LIFT_HEIGHT = _MinMax(mm=32)
    MAX_LIFT_HEIGHT = _MinMax(mm=92)
    MIN_HEAD_ANGLE  = _MinMax(radians=-0.25)
    MAX_HEAD_ANGLE  = _MinMax(radians=0.785)

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

# ════════════════════════════════════════════════════════════════
#  TUNABLE SETTINGS — adjust these to match your robot
# ════════════════════════════════════════════════════════════════
DRIVE_SPEED          = 100    # mm/s  forward/backward
TURN_SPEED           = 80     # mm/s  per-side for turns
JUMPY_BURST_DURATION = 0.07   # sec   drive burst in jumpy mode
JUMPY_PAUSE_TIME     = 0.03   # sec   pause after burst in jumpy mode
MG_PULSES            = 12     # machine gun: number of lift vibrations
MG_INTERVAL          = 0.06   # machine gun: time between pulses (sec)
MG_VIBRATE           = 18     # machine gun: lift amplitude (mm)
RECONNECT_DELAY      = 5      # sec   WebSocket reconnect delay

# Asset directories (place your BMP/PNG face files here)
CUSTOM_FACES_DIR = os.path.expanduser("~/Desktop/custom_faces")
MECHA_MG_DIR     = os.path.expanduser("~/Desktop/mechaMG")
OTTER_GIF_DIR    = os.path.expanduser("~/Desktop/otterGIF")

# ════════════════════════════════════════════════════════════════
#  CONNECTION
# ════════════════════════════════════════════════════════════════
WS_URL = "${protocol}://${host}/ws/control?mode=hardware&stream_key=${user.stream_key}"

# ════════════════════════════════════════════════════════════════
#  PROFILE BUTTONS (from "${config.name}")
# ════════════════════════════════════════════════════════════════
BUTTONS = ${commandsJson}

# Commands that drive continuously when held (keyboard-type buttons)
# key_down → start driving, key_up → stop
CONTINUOUS_COMMANDS = {
    "forward":    ( DRIVE_SPEED,  DRIVE_SPEED),
    "backward":   (-DRIVE_SPEED, -DRIVE_SPEED),
    "turn_left":  (-TURN_SPEED,   TURN_SPEED),
    "turn_right": ( TURN_SPEED,  -TURN_SPEED),
}

# ════════════════════════════════════════════════════════════════
#  FACE / ANIMATION ASSETS
# ════════════════════════════════════════════════════════════════
def _load_bmp(path, size=(128, 32)):
    if not PIL_AVAILABLE:
        return None
    try:
        return Image.open(path).resize(size, Image.NEAREST).convert("1")
    except Exception as e:
        print(f"[Face] Could not load {path}: {e}")
        return None

def _load_face_assets():
    assets = {"static": [], "mechaMG_frames": [], "mechaMG_delays": [], "otter": [],
              "armcat_up": None, "armcat_down": None, "hit_left": None, "hit_right": None,
              "jL": None, "jR": None, "nflag_frames": []}

    if not PIL_AVAILABLE:
        print("[Face] Pillow not installed — face animations disabled. Run: pip install Pillow")
        return assets

    # Custom BMP faces
    if os.path.exists(CUSTOM_FACES_DIR):
        for f in sorted(os.listdir(CUSTOM_FACES_DIR)):
            if not f.lower().endswith(".bmp"):
                continue
            path = os.path.join(CUSTOM_FACES_DIR, f)
            im = _load_bmp(path)
            if im is None:
                continue
            fl = f.lower()
            if fl == "armcatup.bmp":    assets["armcat_up"]   = im
            elif fl == "armcatdown.bmp": assets["armcat_down"] = im
            elif fl in ("hitl.bmp", "hit1.bmp", "left.bmp"): assets["hit_left"]  = im
            elif fl in ("hitr.bmp", "hit2.bmp", "right.bmp"): assets["hit_right"] = im
            elif fl == "jl.bmp": assets["jL"] = im
            elif fl == "jr.bmp": assets["jR"] = im
            elif fl == "nflag1.1.bmp":
                for angle in range(0, 360, 45):
                    rotated = im.rotate(angle, expand=False, fillcolor=0)
                    assets["nflag_frames"].append(rotated)
            else:
                assets["static"].append((im, f))

    # MechaMG GIF frames
    if os.path.exists(MECHA_MG_DIR):
        for fname in sorted(f for f in os.listdir(MECHA_MG_DIR)
                            if f.lower().startswith("frame_") and f.lower().endswith(".png")):
            path = os.path.join(MECHA_MG_DIR, fname)
            try:
                im = Image.open(path).convert("1")
                mg = im.resize((64, 48), Image.NEAREST)
                frame = Image.new("1", (128, 32), color=0)
                frame.paste(mg, ((128-64)//2, (32-48)//2 + 4))
                assets["mechaMG_frames"].append(frame)
                delay = 0.2
                if "_delay-" in fname.lower():
                    try: delay = float(fname.lower().split("_delay-")[1].split("s.")[0])
                    except: pass
                assets["mechaMG_delays"].append(delay)
            except Exception as e:
                print(f"[Face] mechaMG {fname}: {e}")

    # Otter GIF frames
    if os.path.exists(OTTER_GIF_DIR):
        for i in range(30):
            path = os.path.join(OTTER_GIF_DIR, f"frame_{i:02d}_delay-0.04s.png")
            if not os.path.exists(path):
                break
            try:
                im = Image.open(path).convert("1")
                frame = Image.new("1", (128, 32), color=0)
                resized = im.resize((64, 64), Image.NEAREST)
                frame.paste(resized, ((128-64)//2, max(0, (32-64)//2)))
                assets["otter"].append(frame)
            except Exception as e:
                print(f"[Face] otter frame {i}: {e}")

    print(f"[Face] Loaded: {len(assets['static'])} static, {len(assets['mechaMG_frames'])} mechaMG, {len(assets['otter'])} otter frames")
    return assets


# ════════════════════════════════════════════════════════════════
#  MAIN BRIDGE CLASS
# ════════════════════════════════════════════════════════════════
class CozmoBridge:
    def __init__(self):
        self.cli            = None
        self.running        = True
        self.driving_mode   = "smooth"   # "smooth" or "jumpy"
        self.held_keys      = set()
        self._drive_lock    = threading.Lock()
        self.lift_height_mm = MIN_LIFT_HEIGHT.mm
        self.head_angle     = 0.0
        self.animation_mode = None
        self._anim_frame    = 0
        self._last_frame_t  = 0.0
        self._last_anim_t   = 0.0
        self.assets         = _load_face_assets()

    # ── Cozmo Connection ───────────────────────────────────────
    def connect_cozmo(self):
        if not PYCOZMO_AVAILABLE:
            print("[Cozmo] Running in DRY RUN mode (pycozmo not installed)")
            return
        try:
            self.cli = pycozmo.Client()
            self.cli.start()
            self.cli.wait_for_robot()
            self.cli.enable_procedural_face(False)
            print("[Cozmo] Robot connected!")
        except Exception as e:
            print(f"[Cozmo] Connection failed: {e}")
            self.cli = None

    # ── Drive helpers ──────────────────────────────────────────
    def _drive(self, left, right):
        if self.cli:
            try:
                if self.driving_mode == "smooth":
                    self.cli.drive_wheels(left, right, duration=0.2)
                else:
                    self.cli.drive_wheels(left, right, duration=JUMPY_BURST_DURATION)
                    time.sleep(JUMPY_PAUSE_TIME)
            except Exception as e:
                print(f"[Drive] {e}")
        else:
            print(f"[DRY RUN] drive L={left} R={right} mode={self.driving_mode}")

    def _stop(self):
        if self.cli:
            try: self.cli.drive_wheels(0, 0)
            except Exception: pass
        else:
            print("[DRY RUN] stop")

    # ── Continuous drive loop (smooth mode) ───────────────────
    def _continuous_drive_loop(self):
        while self.running:
            with self._drive_lock:
                keys = set(self.held_keys)
            if not keys or self.driving_mode == "jumpy":
                time.sleep(0.05)
                continue
            drove = False
            for cmd in ("forward", "backward", "turn_left", "turn_right"):
                if cmd in keys and cmd in CONTINUOUS_COMMANDS:
                    left, right = CONTINUOUS_COMMANDS[cmd]
                    self._drive(left, right)
                    drove = True
                    break
            if not drove:
                time.sleep(0.05)
            else:
                time.sleep(0.12)

    # ── Command dispatcher ─────────────────────────────────────
    def execute_command(self, cmd, user="?"):
        """Handle a one-shot TAP command."""
        print(f"[CMD] {user} -> {cmd}")

        if cmd in ("forward", "backward", "turn_left", "turn_right"):
            # Burst drive (used in jumpy mode and for single-click configs)
            if cmd in CONTINUOUS_COMMANDS:
                left, right = CONTINUOUS_COMMANDS[cmd]
                self._drive(left, right)

        elif cmd in ("stop", "emergency_stop", "space"):
            self._stop()

        elif cmd in ("machine_gun", "mg"):
            self._machine_gun()

        elif cmd in ("toggle_mode", "x"):
            self.driving_mode = "jumpy" if self.driving_mode == "smooth" else "smooth"
            print(f"[Mode] -> {self.driving_mode.upper()}")

        elif cmd in ("otter", "g"):
            self.animation_mode = "otter" if self.animation_mode != "otter" else None
            self._anim_frame = 0

        elif cmd in ("dual_otter", "y"):
            self.animation_mode = "dual_otter" if self.animation_mode != "dual_otter" else None
            self._anim_frame = 0

        elif cmd in ("mechaMG", "p", "mecha_mg"):
            if self.animation_mode == "mechaMG":
                self.animation_mode = None
            elif self.assets["mechaMG_frames"]:
                self.animation_mode = "mechaMG"
                self._anim_frame = 0
                self._last_frame_t = time.time()

        elif cmd in ("armcat", "k"):
            self.animation_mode = "armcat" if self.animation_mode != "armcat" else None
            self._anim_frame = 0

        elif cmd in ("j_animation", "j"):
            self.animation_mode = "j" if self.animation_mode != "j" else None
            self._anim_frame = 0

        elif cmd in ("nflag", "n"):
            self.animation_mode = "nflag" if self.animation_mode != "nflag" else None
            self._anim_frame = 0

        elif cmd in ("random_glance", "h"):
            self.animation_mode = "hit" if self.animation_mode != "hit" else None
            self._anim_frame = random.randint(0, 1)

        elif cmd in ("toggle_eyes", "o"):
            if self.cli:
                try: self.cli.enable_procedural_face(True)
                except Exception: pass
            self.animation_mode = None

        elif cmd in ("lift_up",):
            self.lift_height_mm = min(MAX_LIFT_HEIGHT.mm, self.lift_height_mm + 20)
            if self.cli:
                try: self.cli.set_lift_height(self.lift_height_mm)
                except Exception: pass

        elif cmd in ("lift_down",):
            self.lift_height_mm = max(MIN_LIFT_HEIGHT.mm, self.lift_height_mm - 20)
            if self.cli:
                try: self.cli.set_lift_height(self.lift_height_mm)
                except Exception: pass

        else:
            print(f"[Unknown] {cmd} — add it to execute_command() to handle it")

    def _machine_gun(self):
        if not self.cli:
            print("[DRY RUN] machine gun!")
            return
        cur = self.lift_height_mm
        try:
            for _ in range(MG_PULSES):
                self.cli.set_lift_height(min(MAX_LIFT_HEIGHT.mm, cur + MG_VIBRATE), accel=3000, duration=0.04)
                time.sleep(MG_INTERVAL)
                self.cli.set_lift_height(max(MIN_LIFT_HEIGHT.mm, cur - MG_VIBRATE), accel=3000, duration=0.04)
                time.sleep(MG_INTERVAL)
            self.cli.set_lift_height(cur, accel=800, duration=0.12)
        except Exception as e:
            print(f"[MG] {e}")

    def _display_face(self, im):
        if self.cli and im is not None:
            try: self.cli.display_image(im)
            except Exception: pass

    def _tick_animations(self):
        """Advance face animations. Call this in the main loop."""
        a = self.assets
        now = time.time()
        if self.animation_mode == "mechaMG" and a["mechaMG_frames"]:
            delays = a["mechaMG_delays"]
            delay = delays[self._anim_frame] if self._anim_frame < len(delays) else 0.2
            if now - self._last_frame_t > delay:
                self._anim_frame = (self._anim_frame + 1) % len(a["mechaMG_frames"])
                self._display_face(a["mechaMG_frames"][self._anim_frame])
                self._last_frame_t = now
        elif self.animation_mode == "otter" and a["otter"]:
            if now - self._last_frame_t > 0.04:
                self._anim_frame = (self._anim_frame + 1) % len(a["otter"])
                self._display_face(a["otter"][self._anim_frame])
                self._last_frame_t = now
        elif self.animation_mode == "dual_otter" and a["otter"]:
            if now - self._last_frame_t > 0.04:
                self._anim_frame = (self._anim_frame + 1) % len(a["otter"])
                L = (self._anim_frame) % len(a["otter"])
                R = (self._anim_frame + 3) % len(a["otter"])
                combined = Image.new("1", (128, 32), color=0)
                combined.paste(a["otter"][L].crop((32, 0, 96, 32)), (0,  0))
                combined.paste(a["otter"][R].crop((32, 0, 96, 32)), (64, 0))
                self._display_face(combined)
                self._last_frame_t = now
        elif self.animation_mode == "armcat" and a["armcat_up"] and a["armcat_down"]:
            if now - self._last_frame_t > 0.2:
                self._anim_frame = 1 - self._anim_frame
                self._display_face(a["armcat_up"] if self._anim_frame == 0 else a["armcat_down"])
                self._last_frame_t = now
        elif self.animation_mode == "hit" and a["hit_left"] and a["hit_right"]:
            delay = random.uniform(0.2, 0.5) if random.random() < 0.05 else random.uniform(2.0, 4.0)
            if now - self._last_frame_t > delay:
                self._anim_frame = 1 - self._anim_frame
                self._display_face(a["hit_left"] if self._anim_frame == 0 else a["hit_right"])
                self._last_frame_t = now
        elif self.animation_mode == "j" and a["jL"] and a["jR"]:
            if now - self._last_frame_t > 1.0:
                self._anim_frame = 1 - self._anim_frame
                self._display_face(a["jL"] if self._anim_frame == 0 else a["jR"])
                self._last_frame_t = now
        elif self.animation_mode == "nflag" and a["nflag_frames"]:
            if now - self._last_frame_t > 0.08:
                self._anim_frame = (self._anim_frame + 1) % len(a["nflag_frames"])
                self._display_face(a["nflag_frames"][self._anim_frame])
                self._last_frame_t = now

    # ── WebSocket handlers ─────────────────────────────────────
    def on_message(self, ws, message):
        try:
            msg = json.loads(message)
            msg_type = msg.get("type", "")
            cmd      = msg.get("command", "")
            user     = msg.get("from_user", "?")

            if msg_type == "command":
                # Single TAP — one-shot action
                self.execute_command(cmd, user)

            elif msg_type == "key_down":
                # HOLD pressed — add to held set, start continuous drive if it's a drive cmd
                print(f"[Hold] {user} holding {cmd}")
                with self._drive_lock:
                    self.held_keys.add(cmd)
                # In jumpy mode, also send a burst immediately
                if self.driving_mode == "jumpy" and cmd in CONTINUOUS_COMMANDS:
                    left, right = CONTINUOUS_COMMANDS[cmd]
                    self._drive(left, right)
                # Non-drive keyboard commands are treated as one-shot on key_down
                elif cmd not in CONTINUOUS_COMMANDS:
                    self.execute_command(cmd, user)

            elif msg_type == "key_up":
                # HOLD released — remove from held set, stop if no more drive keys
                print(f"[Release] {user} released {cmd}")
                with self._drive_lock:
                    self.held_keys.discard(cmd)
                with self._drive_lock:
                    remaining = set(self.held_keys)
                if not any(k in CONTINUOUS_COMMANDS for k in remaining):
                    self._stop()

            elif msg_type == "video_click":
                x = float(msg.get("x", 0.5))
                y = float(msg.get("y", 0.5))
                print(f"[Click] {user} -> ({x:.2f}, {y:.2f})")
                # Click-to-steer: left/right based on x position
                if x < 0.35:
                    self._drive(-TURN_SPEED, TURN_SPEED)
                elif x > 0.65:
                    self._drive(TURN_SPEED, -TURN_SPEED)
                else:
                    drive_dur = max(0.2, (1.0 - y) * 0.6)
                    if self.cli:
                        try: self.cli.drive_wheels(DRIVE_SPEED, DRIVE_SPEED, duration=drive_dur)
                        except Exception: pass

        except Exception as e:
            print(f"[WS Error] {e}")

    def on_open(self, ws):
        print("[WS] Connected to OpenVibe.Live!")
        print(f"[Profile] ${config.name} ({enabledButtons.length} buttons) | Mode: {self.driving_mode}")
        ws.send(json.dumps({"type": "status", "connected": True, "profile": "${config.name}"}))

    def on_close(self, ws, code, reason):
        print(f"[WS] Disconnected (code={code}) — Cozmo will stop")
        with self._drive_lock:
            self.held_keys.clear()
        self._stop()

    def on_error(self, ws, error):
        print(f"[WS Error] {error}")

    # ── Main loop ──────────────────────────────────────────────
    def run(self):
        self.connect_cozmo()

        # Start continuous-drive background thread (smooth mode)
        drive_t = threading.Thread(target=self._continuous_drive_loop, daemon=True)
        drive_t.start()

        print(f"\\n{'='*60}")
        print(f"  OpenVibe.Live Cozmo Bridge — ${config.name}")
        print(f"  Drive speed: {DRIVE_SPEED} mm/s  |  Mode: SMOOTH (toggle with 'toggle_mode')")
        print(f"  Commands: ${enabledButtons.map(b => b.command).join(', ')}")
        print(f"{'='*60}\\n")

        while self.running:
            try:
                ws_app = websocket.WebSocketApp(
                    WS_URL,
                    on_message=self.on_message,
                    on_open=self.on_open,
                    on_close=self.on_close,
                    on_error=self.on_error,
                )
                # Run WS in a thread so we can tick animations in main thread
                ws_thread = threading.Thread(target=lambda: ws_app.run_forever(ping_interval=30), daemon=True)
                ws_thread.start()

                while ws_thread.is_alive() and self.running:
                    self._tick_animations()
                    time.sleep(0.04)

            except Exception as e:
                print(f"[WS] {e}")

            if self.running:
                print(f"[WS] Reconnecting in {RECONNECT_DELAY}s...")
                time.sleep(RECONNECT_DELAY)


if __name__ == "__main__":
    bridge = CozmoBridge()
    try:
        bridge.run()
    except KeyboardInterrupt:
        bridge.running = False
        bridge._stop()
        if bridge.cli:
            try: bridge.cli.stop()
            except Exception: pass
        print("\\n[Bridge] Bye!")
`;
}

// ══════════════════════════════════════════════════════════════
//  CONTROL CONFIGS (Reusable per-channel profiles)
// ══════════════════════════════════════════════════════════════

// ── List configs ─────────────────────────────────────────────
router.get('/configs', requireAuth, (req, res) => {
    try {
        const configs = db.getControlConfigs(req.user.id);
        // Attach button count to each config
        const result = configs.map(c => ({
            ...c,
            button_count: db.getConfigButtons(c.id).length,
        }));
        res.json({ configs: result });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list configs' });
    }
});

// ── Create config ────────────────────────────────────────────
router.post('/configs', requireAuth, (req, res) => {
    try {
        const { name, description } = req.body;
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'Config name is required' });
        }
        const cleanName = String(name).replace(/<[^>]*>/g, '').slice(0, 60);
        const cleanDesc = description ? String(description).replace(/<[^>]*>/g, '').slice(0, 200) : '';

        // Limit to 20 configs per user
        const existing = db.getControlConfigs(req.user.id);
        if (existing.length >= 20) {
            return res.status(400).json({ error: 'Maximum 20 control configs allowed' });
        }

        const result = db.createControlConfig({ user_id: req.user.id, name: cleanName, description: cleanDesc });
        const config = db.getControlConfig(result.lastInsertRowid);
        res.status(201).json({ config });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create config' });
    }
});

// ── Get config with buttons ──────────────────────────────────
router.get('/configs/:id', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const buttons = db.getConfigButtons(config.id);
        res.json({ config, buttons });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get config' });
    }
});

// ── Update config ────────────────────────────────────────────
router.put('/configs/:id', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const { name, description } = req.body;
        const updates = {};
        if (name !== undefined) updates.name = String(name).replace(/<[^>]*>/g, '').slice(0, 60);
        if (description !== undefined) updates.description = String(description).replace(/<[^>]*>/g, '').slice(0, 200);
        db.updateControlConfig(config.id, updates);
        const updated = db.getControlConfig(config.id);
        res.json({ config: updated });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update config' });
    }
});

// ── Delete config ────────────────────────────────────────────
router.delete('/configs/:id', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        // Clear active config reference if it was active
        const channel = db.getChannelByUserId(req.user.id);
        if (channel && channel.active_control_config_id === config.id) {
            db.updateChannel(req.user.id, { active_control_config_id: null });
        }
        db.deleteControlConfig(config.id);
        res.json({ message: 'Config deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete config' });
    }
});

// ── Add button to config ─────────────────────────────────────
router.post('/configs/:id/buttons', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const { label, command, icon, control_type, key_binding, cooldown_ms, btn_color, btn_bg, btn_border_color } = req.body;
        if (!label || !command) {
            return res.status(400).json({ error: 'Label and command required' });
        }

        // Limit to 50 buttons per config
        const existing = db.getConfigButtons(config.id);
        if (existing.length >= 50) {
            return res.status(400).json({ error: 'Maximum 50 buttons per config' });
        }

        const cleanIcon = icon || 'fa-gamepad';
        if (!/^fa-[a-z0-9-]+$/.test(cleanIcon)) {
            return res.status(400).json({ error: 'Invalid icon class' });
        }

        const validTypes = ['button', 'toggle', 'dpad', 'keyboard'];
        const cleanType = validTypes.includes(control_type) ? control_type : 'button';

        db.createConfigButton({
            config_id: config.id,
            label: String(label).replace(/<[^>]*>/g, '').slice(0, 50),
            command: String(command).replace(/[<>"'`\\]/g, '').slice(0, 100),
            icon: cleanIcon,
            control_type: cleanType,
            key_binding: key_binding ? String(key_binding).slice(0, 20) : null,
            cooldown_ms: Math.max(0, Math.min(30000, parseInt(cooldown_ms) || 100)),
            sort_order: existing.length,
            btn_color: sanitizeCssColor(btn_color),
            btn_bg: sanitizeCssColor(btn_bg),
            btn_border_color: sanitizeCssColor(btn_border_color),
        });

        syncConfigToBoundLiveStreams(config.id);
        const buttons = db.getConfigButtons(config.id);
        res.status(201).json({ buttons });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add button' });
    }
});

// ── Update button ────────────────────────────────────────────
router.put('/configs/:id/buttons/:btnId', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const { label, command, icon, control_type, key_binding, cooldown_ms, sort_order, btn_color, btn_bg, btn_border_color, is_enabled } = req.body;
        const updates = {};

        if (label !== undefined) updates.label = String(label).replace(/<[^>]*>/g, '').slice(0, 50);
        if (command !== undefined) updates.command = String(command).replace(/[<>"'`\\]/g, '').slice(0, 100);
        if (icon !== undefined) {
            if (!/^fa-[a-z0-9-]+$/.test(icon)) return res.status(400).json({ error: 'Invalid icon class' });
            updates.icon = icon;
        }
        if (control_type !== undefined) {
            const validTypes = ['button', 'toggle', 'dpad', 'keyboard'];
            updates.control_type = validTypes.includes(control_type) ? control_type : 'button';
        }
        if (key_binding !== undefined) updates.key_binding = key_binding ? String(key_binding).slice(0, 20) : null;
        if (cooldown_ms !== undefined) updates.cooldown_ms = Math.max(0, Math.min(30000, parseInt(cooldown_ms) || 100));
        if (sort_order !== undefined) updates.sort_order = parseInt(sort_order) || 0;
        if (btn_color !== undefined) updates.btn_color = sanitizeCssColor(btn_color);
        if (btn_bg !== undefined) updates.btn_bg = sanitizeCssColor(btn_bg);
        if (btn_border_color !== undefined) updates.btn_border_color = sanitizeCssColor(btn_border_color);
        if (is_enabled !== undefined) updates.is_enabled = is_enabled ? 1 : 0;

        db.updateConfigButton(parseInt(req.params.btnId), updates);
        syncConfigToBoundLiveStreams(config.id);
        const buttons = db.getConfigButtons(config.id);
        res.json({ buttons });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update button' });
    }
});

// ── Delete button ────────────────────────────────────────────
router.delete('/configs/:id/buttons/:btnId', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        db.deleteConfigButton(parseInt(req.params.btnId));
        syncConfigToBoundLiveStreams(config.id);
        const buttons = db.getConfigButtons(config.id);
        res.json({ buttons });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete button' });
    }
});

// ── Activate config on channel ───────────────────────────────
router.post('/configs/:id/activate', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        db.updateChannel(req.user.id, { active_control_config_id: config.id });
        res.json({ message: 'Config activated', config_id: config.id });
    } catch (err) {
        res.status(500).json({ error: 'Failed to activate config' });
    }
});

// ── Deactivate config (clear active) ─────────────────────────
router.post('/configs/deactivate', requireAuth, (req, res) => {
    try {
        db.updateChannel(req.user.id, { active_control_config_id: null });
        res.json({ message: 'Config deactivated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to deactivate config' });
    }
});

// ── Apply config to live stream ──────────────────────────────
router.post('/configs/:id/apply/:streamId', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const stream = db.getStreamById(req.params.streamId);
        if (!stream || (stream.user_id !== req.user.id && req.user.role !== 'admin')) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const applied = db.applyConfigToStream(config.id, stream.id);
        const controls = db.getStreamControls(stream.id);
        res.json({ applied, controls });
    } catch (err) {
        res.status(500).json({ error: 'Failed to apply config' });
    }
});

// ── Generate API Key (must be before :streamId routes) ────────
router.post('/api-key', requireAuth, (req, res) => {
    try {
        const { label, permissions } = req.body;

        // Generate a random API key
        const rawKey = crypto.randomBytes(32).toString('hex');
        const keyHash = bcrypt.hashSync(rawKey, 10);

        db.createApiKey({
            user_id: req.user.id,
            key_hash: keyHash,
            label: label || 'Default',
            permissions: permissions || ['control', 'stream'],
        });

        // Return the raw key ONCE (it's hashed in the DB)
        res.status(201).json({
            api_key: rawKey,
            label: label || 'Default',
            message: 'Save this key — it cannot be retrieved again!',
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate API key' });
    }
});

// ── List API Keys (must be before :streamId routes) ──────────
router.get('/api-keys', requireAuth, (req, res) => {
    try {
        const keys = db.all(
            'SELECT id, label, permissions, last_used, is_active, created_at FROM api_keys WHERE user_id = ?',
            [req.user.id]
        );
        res.json({ api_keys: keys });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list API keys' });
    }
});

// ── Control Settings (MUST be before /:streamId routes) ──────

// Get control settings for the current user's channel
router.get('/settings/channel', requireAuth, (req, res) => {
    try {
        const channel = db.getChannelByUserId(req.user.id);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        res.json({
            control_mode: channel.control_mode || 'open',
            anon_controls_enabled: !!channel.anon_controls_enabled,
            control_rate_limit_ms: channel.control_rate_limit_ms || 100,
            video_click_enabled: !!channel.video_click_enabled,
            video_click_rate_limit_ms: channel.video_click_rate_limit_ms || 0,
            active_control_config_id: channel.active_control_config_id || null,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get control settings' });
    }
});

router.put('/settings/channel', requireAuth, (req, res) => {
    try {
        const { control_mode, anon_controls_enabled, control_rate_limit_ms, video_click_enabled, video_click_rate_limit_ms } = req.body;
        const updates = {};
        if (control_mode !== undefined) {
            if (!['open', 'whitelist', 'disabled'].includes(control_mode)) {
                return res.status(400).json({ error: 'Invalid control_mode' });
            }
            updates.control_mode = control_mode;
        }
        if (anon_controls_enabled !== undefined) {
            updates.anon_controls_enabled = anon_controls_enabled ? 1 : 0;
        }
        if (video_click_enabled !== undefined) {
            updates.video_click_enabled = video_click_enabled ? 1 : 0;
        }
        // control_rate_limit_ms / video_click_rate_limit_ms are no longer configurable —
        // rate limiting is now a fixed anti-flood burst cap plus per-button cooldown_ms.
        // The columns remain (harmless) but we no longer read or write them.
        if (Object.keys(updates).length > 0) {
            db.updateChannel(req.user.id, updates);
        }
        const channel = db.getChannelByUserId(req.user.id);
        res.json({
            control_mode: channel.control_mode || 'open',
            anon_controls_enabled: !!channel.anon_controls_enabled,
            control_rate_limit_ms: channel.control_rate_limit_ms || 100,
            video_click_enabled: !!channel.video_click_enabled,
            video_click_rate_limit_ms: channel.video_click_rate_limit_ms || 0,
            active_control_config_id: channel.active_control_config_id || null,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update control settings' });
    }
});

// ── Control Whitelist ────────────────────────────────────────

router.get('/whitelist', requireAuth, (req, res) => {
    try {
        const channel = db.getChannelByUserId(req.user.id);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        const whitelist = db.all(
            `SELECT cw.id, cw.user_id, u.username, u.display_name, cw.created_at
             FROM control_whitelist cw JOIN users u ON cw.user_id = u.id
             WHERE cw.channel_id = ? ORDER BY cw.created_at DESC`,
            [channel.id]
        );
        res.json({ whitelist });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get whitelist' });
    }
});

router.post('/whitelist', requireAuth, (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'Username required' });
        const channel = db.getChannelByUserId(req.user.id);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        const targetUser = db.getUserByUsername(username);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        db.run(
            'INSERT OR IGNORE INTO control_whitelist (channel_id, user_id, added_by) VALUES (?, ?, ?)',
            [channel.id, targetUser.id, req.user.id]
        );
        res.json({ message: `${username} added to control whitelist` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add to whitelist' });
    }
});

router.delete('/whitelist/:id', requireAuth, (req, res) => {
    try {
        const channel = db.getChannelByUserId(req.user.id);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        db.run('DELETE FROM control_whitelist WHERE id = ? AND channel_id = ?',
            [req.params.id, channel.id]);
        res.json({ message: 'Removed from whitelist' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove from whitelist' });
    }
});

// ── Cozmo Script Generator ──────────────────────────────────

router.get('/cozmo-script', requireAuth, (req, res) => {
    try {
        const user = req.user;
        const host = req.get('host') || 'openvibe.live';
        const protocol = req.secure || req.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';

        const script = generateCozmoScript(user, protocol, host);

        res.set('Content-Type', 'text/x-python');
        res.set('Content-Disposition', `attachment; filename="cozmo-bridge-${user.username}.py"`);
        res.send(script);
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate script' });
    }
});

// ── Per-Profile Bridge Script Generator ──────────────────────

router.get('/configs/:id/bridge-script', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const buttons = db.getConfigButtons(config.id);
        const user = req.user;
        const host = req.get('host') || 'openvibe.live';
        const protocol = req.secure || req.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
        const type = req.query.type === 'cozmo' ? 'cozmo' : 'generic';

        const script = generateProfileBridgeScript({ user, config, buttons, protocol, host, type });

        const slug = config.name.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().slice(0, 30);
        res.set('Content-Type', 'text/x-python');
        res.set('Content-Disposition', `attachment; filename="${type}-bridge-${slug}.py"`);
        res.send(script);
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate bridge script' });
    }
});

// ── Get bound control profile for a stream ───────────────────
router.get('/:streamId/config', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.streamId);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        res.json({ control_config_id: stream.control_config_id || null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get stream config' });
    }
});

// ── Bind or rebind a stream to a control profile ──────────────
router.put('/:streamId/config', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.streamId);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const configId = req.body.control_config_id === null ? null : parseInt(req.body.control_config_id);
        if (configId) {
            const config = db.getControlConfig(configId);
            if (!config) return res.status(404).json({ error: 'Config not found' });
            if (config.user_id !== req.user.id && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Not authorized' });
            }
            const applied = db.applyConfigToStream(config.id, stream.id);
            const controls = db.getStreamControls(stream.id);
            return res.json({ message: 'Config applied to stream', control_config_id: config.id, applied, controls });
        }

        db.bindStreamToControlConfig(stream.id, null);
        const controls = db.getStreamControls(stream.id);
        res.json({ message: 'Stream unbound from control profile', control_config_id: null, controls });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update stream config' });
    }
});

// ── Get Controls for a Stream ────────────────────────────────
router.get('/:streamId', (req, res) => {
    try {
        const controls = db.getStreamControls(req.params.streamId);
        // Attach channel settings for the controls UI
        const stream = db.getStreamById(req.params.streamId);
        let settings = {};
        if (stream) {
            const channel = db.getChannelByUserId(stream.user_id);
            if (channel) {
                settings = {
                    video_click_enabled: !!channel.video_click_enabled,
                    control_mode: channel.control_mode || 'open',
                    anon_controls_enabled: !!channel.anon_controls_enabled,
                    control_rate_limit_ms: channel.control_rate_limit_ms || 100,
                    video_click_rate_limit_ms: channel.video_click_rate_limit_ms || 0,
                };
            }
        }
        res.json({ controls, settings });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get controls' });
    }
});

// ── Ad-hoc per-stream control editing removed ────────────────
// Controls are now defined only in Control Profiles (control_configs) and
// materialized onto a live stream by applyConfigToStream. The old direct
// editor endpoints (POST /:streamId, PUT/DELETE /:streamId/:id) that hand-authored
// rows in stream_controls have been removed so every control has a profile source.

// ── Cozmo Presets ────────────────────────────────────────────
const { applyCozmoPresets, removeCozmoPresets } = require('../integrations/cozmo-presets');

router.post('/:streamId/presets/cozmo', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.streamId);
        if (!stream || (stream.user_id !== req.user.id && req.user.role !== 'admin')) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const result = applyCozmoPresets(parseInt(req.params.streamId));
        const controls = db.getStreamControls(req.params.streamId);
        res.json({ ...result, controls });
    } catch (err) {
        res.status(500).json({ error: 'Failed to apply Cozmo presets' });
    }
});

router.delete('/:streamId/presets/cozmo', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.streamId);
        if (!stream || (stream.user_id !== req.user.id && req.user.role !== 'admin')) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const removed = removeCozmoPresets(parseInt(req.params.streamId));
        const controls = db.getStreamControls(req.params.streamId);
        res.json({ removed, controls });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove Cozmo presets' });
    }
});

module.exports = router;
