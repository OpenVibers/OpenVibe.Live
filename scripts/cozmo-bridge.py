#!/usr/bin/env python3
"""
OpenVibe.Live — Cozmo Hardware Bridge

Connects to the OpenVibe.Live Control WebSocket as a hardware client,
translates incoming commands into pycozmo actions on a physical Cozmo robot.

HOW BUTTON TYPES WORK
======================
  [HOLD / keyboard type]:
    key_down  →  start driving continuously (smooth mode) OR burst once (jumpy mode)
    key_up    →  stop driving

  [TAP / button type]:
    command   →  one-shot action (face animation, machine gun, toggle, etc.)

DRIVE MODES
===========
  SMOOTH (default): holding a drive button drives continuously.
                    Releasing → Cozmo stops. Best for precise control.
  JUMPY:            every tap sends a short burst (JUMPY_BURST_DURATION seconds).
                    Good when smooth control is hard to achieve.
  Send the "toggle_mode" command (or press the Toggle Mode button) to switch.

Requirements:
    pip install pycozmo websocket-client Pillow

Usage:
    python3 cozmo-bridge.py --url wss://openvibe.live/ws/control --stream-key YOUR_STREAM_KEY

Environment Variables (alternative to CLI args):
    OV_WS_URL        WebSocket URL  (e.g. wss://openvibe.live/ws/control)
    OV_STREAM_KEY    Stream key for authentication

Commands:
    Drive (HOLD type):   forward, backward, turn_left, turn_right
    Stop (TAP):          stop, emergency_stop
    Lift (TAP):          lift_up, lift_down, say:<text>, anim:<trigger>
    Cozmo face (TAP):    otter, dual_otter, mechaMG, armcat, nflag, random_glance, toggle_eyes
    Action (TAP):        machine_gun, toggle_mode
"""

import argparse
import json
import os
import random
import sys
import threading
import time
import traceback

try:
    import pycozmo
    from pycozmo import MIN_LIFT_HEIGHT, MAX_LIFT_HEIGHT, MIN_HEAD_ANGLE, MAX_HEAD_ANGLE
    PYCOZMO_AVAILABLE = True
except ImportError:
    PYCOZMO_AVAILABLE = False
    class _MinMax:
        def __init__(self, mm=0, radians=0): self.mm = mm; self.radians = radians
    MIN_LIFT_HEIGHT = _MinMax(mm=32)
    MAX_LIFT_HEIGHT = _MinMax(mm=92)
    MIN_HEAD_ANGLE  = _MinMax(radians=-0.25)
    MAX_HEAD_ANGLE  = _MinMax(radians=0.785)

try:
    import websocket
    WEBSOCKET_AVAILABLE = True
except ImportError:
    WEBSOCKET_AVAILABLE = False

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False


# ── Tunable Settings ─────────────────────────────────────────
DRIVE_SPEED          = 100    # mm/s  forward / backward
TURN_SPEED           = 80     # mm/s  per-side for turns
JUMPY_BURST_DURATION = 0.07   # sec   single burst in jumpy mode
JUMPY_PAUSE_TIME     = 0.03   # sec   pause after burst
MG_PULSES            = 12     # machine gun vibration pulses
MG_INTERVAL          = 0.06   # sec between pulses
MG_VIBRATE           = 18     # lift amplitude (mm)
LIFT_STEP            = 20     # mm per lift_up/lift_down command
SMOOTH_DRIVE_WINDOW  = 0.15   # sec between drive_wheels calls in smooth mode

CONTINUOUS_COMMANDS = {
    "forward":    ( DRIVE_SPEED,  DRIVE_SPEED),
    "backward":   (-DRIVE_SPEED, -DRIVE_SPEED),
    "turn_left":  (-TURN_SPEED,   TURN_SPEED),
    "turn_right": ( TURN_SPEED,  -TURN_SPEED),
}

# Asset directories for face animations
CUSTOM_FACES_DIR = os.path.expanduser("~/Desktop/custom_faces")
MECHA_MG_DIR     = os.path.expanduser("~/Desktop/mechaMG")
OTTER_GIF_DIR    = os.path.expanduser("~/Desktop/otterGIF")


# ── Face Asset Loader ─────────────────────────────────────────
def _load_face_assets():
    assets = {"static": [], "mechaMG_frames": [], "mechaMG_delays": [], "otter": [],
              "armcat_up": None, "armcat_down": None, "hit_left": None, "hit_right": None,
              "jL": None, "jR": None, "nflag_frames": []}

    if not PIL_AVAILABLE:
        return assets

    def _bmp(path, size=(128, 32)):
        try:
            return Image.open(path).resize(size, Image.NEAREST).convert("1")
        except Exception as e:
            print(f"[Face] {path}: {e}")
            return None

    if os.path.exists(CUSTOM_FACES_DIR):
        for f in sorted(os.listdir(CUSTOM_FACES_DIR)):
            if not f.lower().endswith(".bmp"):
                continue
            im = _bmp(os.path.join(CUSTOM_FACES_DIR, f))
            if im is None:
                continue
            fl = f.lower()
            if fl == "armcatup.bmp":    assets["armcat_up"]   = im
            elif fl == "armcatdown.bmp": assets["armcat_down"] = im
            elif fl in ("hitl.bmp", "hit1.bmp", "left.bmp"):  assets["hit_left"]  = im
            elif fl in ("hitr.bmp", "hit2.bmp", "right.bmp"): assets["hit_right"] = im
            elif fl == "jl.bmp": assets["jL"] = im
            elif fl == "jr.bmp": assets["jR"] = im
            elif fl == "nflag1.1.bmp":
                for angle in range(0, 360, 45):
                    assets["nflag_frames"].append(im.rotate(angle, expand=False, fillcolor=0))
            else:
                assets["static"].append((im, f))

    if os.path.exists(MECHA_MG_DIR):
        for fname in sorted(f for f in os.listdir(MECHA_MG_DIR)
                            if f.lower().startswith("frame_") and f.lower().endswith(".png")):
            try:
                im = Image.open(os.path.join(MECHA_MG_DIR, fname)).convert("1")
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
                print(f"[Face] otter {i}: {e}")

    print(f"[Face] static={len(assets['static'])} mechaMG={len(assets['mechaMG_frames'])} otter={len(assets['otter'])}")
    return assets


# ── Bridge ────────────────────────────────────────────────────

class CozmoHardwareBridge:
    """Bridges OpenVibe.Live control WebSocket ↔ physical Cozmo robot."""

    def __init__(self, ws_url, stream_key):
        self.ws_url         = ws_url
        self.stream_key     = stream_key
        self.ws             = None
        self.cli            = None
        self.running        = False
        self._reconnect_delay = 2
        self.driving_mode   = "smooth"   # "smooth" | "jumpy"
        self.held_keys      = set()
        self._drive_lock    = threading.Lock()
        self.lift_height_mm = MIN_LIFT_HEIGHT.mm
        self.animation_mode = None
        self._anim_frame    = 0
        self._last_frame_t  = 0.0
        self.assets         = _load_face_assets()

    # ── Cozmo ──────────────────────────────────────────────────
    def connect_cozmo(self):
        if not PYCOZMO_AVAILABLE:
            print('[Cozmo] pycozmo not installed — running in DRY RUN mode')
            return None
        try:
            cli = pycozmo.Client()
            cli.start()
            cli.connect()
            cli.wait_for_robot()
            cli.enable_procedural_face(False)
            print('[Cozmo] Robot connected!')
            return cli
        except Exception as e:
            print(f'[Cozmo] Connection failed: {e} — DRY RUN mode')
            return None

    # ── Drive helpers ──────────────────────────────────────────
    def _drive(self, left, right):
        if self.cli:
            try:
                if self.driving_mode == "smooth":
                    self.cli.drive_wheels(left, right, duration=SMOOTH_DRIVE_WINDOW * 2)
                else:
                    self.cli.drive_wheels(left, right, duration=JUMPY_BURST_DURATION)
                    time.sleep(JUMPY_PAUSE_TIME)
            except Exception as e:
                print(f'[Drive] {e}')
        else:
            print(f'[DRY RUN] drive L={left} R={right}')

    def _stop(self):
        if self.cli:
            try: self.cli.drive_wheels(0, 0)
            except Exception: pass
        else:
            print('[DRY RUN] stop')

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
            time.sleep(SMOOTH_DRIVE_WINDOW if drove else 0.05)

    # ── Machine gun ────────────────────────────────────────────
    def _machine_gun(self):
        if not self.cli:
            print('[DRY RUN] machine gun!')
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
            print(f'[MG] {e}')

    # ── Face display ───────────────────────────────────────────
    def _display_face(self, im):
        if self.cli and im is not None:
            try: self.cli.display_image(im)
            except Exception: pass

    def _tick_animations(self):
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
                combined = Image.new("1", (128, 32), color=0)
                L = self._anim_frame % len(a["otter"])
                R = (self._anim_frame + 3) % len(a["otter"])
                combined.paste(a["otter"][L].crop((32, 0, 96, 32)), (0, 0))
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

    # ── Command dispatcher ─────────────────────────────────────
    def handle_command(self, cmd, user='?'):
        """Execute a one-shot TAP command."""
        print(f'[CMD] {user} -> {cmd}')
        if cmd in ("forward", "backward", "turn_left", "turn_right") and cmd in CONTINUOUS_COMMANDS:
            left, right = CONTINUOUS_COMMANDS[cmd]
            self._drive(left, right)
        elif cmd in ("stop", "emergency_stop"):
            self._stop()
        elif cmd == "machine_gun":
            self._machine_gun()
        elif cmd == "toggle_mode":
            self.driving_mode = "jumpy" if self.driving_mode == "smooth" else "smooth"
            print(f'[Mode] -> {self.driving_mode.upper()}')
        elif cmd in ("otter", "g"):
            self.animation_mode = "otter" if self.animation_mode != "otter" else None
            self._anim_frame = 0
        elif cmd in ("dual_otter", "y"):
            self.animation_mode = "dual_otter" if self.animation_mode != "dual_otter" else None
            self._anim_frame = 0
        elif cmd in ("mechaMG", "mecha_mg", "p"):
            if self.animation_mode == "mechaMG":
                self.animation_mode = None
            elif self.assets["mechaMG_frames"]:
                self.animation_mode = "mechaMG"
                self._anim_frame = 0
                self._last_frame_t = time.time()
        elif cmd in ("armcat", "k"):
            self.animation_mode = "armcat" if self.animation_mode != "armcat" else None
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
        elif cmd == "lift_up":
            self.lift_height_mm = min(MAX_LIFT_HEIGHT.mm, self.lift_height_mm + LIFT_STEP)
            if self.cli:
                try: self.cli.set_lift_height(self.lift_height_mm)
                except Exception: pass
        elif cmd == "lift_down":
            self.lift_height_mm = max(MIN_LIFT_HEIGHT.mm, self.lift_height_mm - LIFT_STEP)
            if self.cli:
                try: self.cli.set_lift_height(self.lift_height_mm)
                except Exception: pass
        elif cmd.startswith('say:'):
            text = cmd[4:].strip()[:200]
            if text and self.cli:
                try: self.cli.say(text)
                except Exception: pass
        elif cmd.startswith('anim:'):
            trigger = cmd[5:].strip()
            if self.cli and PYCOZMO_AVAILABLE:
                try: self.cli.play_anim_trigger(getattr(pycozmo.anim.Triggers, trigger))
                except AttributeError: print(f'[Cozmo] Unknown anim: {trigger}')
        else:
            print(f'[Unknown] {cmd} — add handling to handle_command()')

    # ── WS message handler ─────────────────────────────────────
    def on_ws_message(self, ws, raw):
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return

        msg_type = msg.get('type', '')
        cmd  = msg.get('command', '')
        user = msg.get('from_user', '?')

        if msg_type == 'connected':
            print(f'[WS] Registered as hardware client ({user})')
            self.send_status({'cozmo': 'connected' if self.cli else 'dry_run',
                              'mode': self.driving_mode})
            return

        if msg_type == 'command':
            # TAP — one-shot action
            self.handle_command(cmd, user)

        elif msg_type == 'key_down':
            # HOLD pressed — begin continuous drive (smooth) or burst (jumpy)
            print(f'[Hold] {user} -> {cmd}')
            with self._drive_lock:
                self.held_keys.add(cmd)
            if self.driving_mode == "jumpy" and cmd in CONTINUOUS_COMMANDS:
                # Jumpy mode: burst immediately on press
                left, right = CONTINUOUS_COMMANDS[cmd]
                self._drive(left, right)
            elif cmd not in CONTINUOUS_COMMANDS:
                # Non-drive keyboard button: treat as one-shot on press
                self.handle_command(cmd, user)
            # Smooth mode drive: handled by _continuous_drive_loop

        elif msg_type == 'key_up':
            # HOLD released — stop if no more drive keys held
            print(f'[Release] {user} -> {cmd}')
            with self._drive_lock:
                self.held_keys.discard(cmd)
            with self._drive_lock:
                remaining = set(self.held_keys)
            if not any(k in CONTINUOUS_COMMANDS for k in remaining):
                self._stop()

        elif msg_type == 'video_click':
            x = float(msg.get('x', 0.5))
            y = float(msg.get('y', 0.5))
            print(f'[Click] {user} -> ({x:.2f}, {y:.2f})')
            if x < 0.35:
                self._drive(-TURN_SPEED, TURN_SPEED)
            elif x > 0.65:
                self._drive(TURN_SPEED, -TURN_SPEED)
            else:
                if self.cli:
                    try: self.cli.drive_wheels(DRIVE_SPEED, DRIVE_SPEED, duration=max(0.2, (1.0 - y) * 0.6))
                    except Exception: pass

    def send_status(self, status_data):
        if self.ws:
            try: self.ws.send(json.dumps({'type': 'status', **status_data}))
            except Exception: pass

    def on_ws_error(self, ws, error):
        print(f'[WS] Error: {error}')

    def on_ws_close(self, ws, code, reason):
        print(f'[WS] Disconnected (code={code}) — Cozmo will stop')
        with self._drive_lock:
            self.held_keys.clear()
        self._stop()

    def on_ws_open(self, ws):
        print(f'[WS] Connected!')

    def run(self):
        if not WEBSOCKET_AVAILABLE:
            print('[ERROR] websocket-client not installed. Run: pip install websocket-client')
            sys.exit(1)

        self.running = True

        # Connect to Cozmo
        try:
            self.cli = self.connect_cozmo()
        except Exception as e:
            print(f'[Cozmo] {e} — continuing in DRY RUN mode')
            self.cli = None

        # Start continuous-drive thread
        drive_t = threading.Thread(target=self._continuous_drive_loop, daemon=True)
        drive_t.start()

        print(f'\n{"="*60}')
        print(f'  OpenVibe.Live Cozmo Bridge')
        print(f'  Drive speed: {DRIVE_SPEED} mm/s | Mode: SMOOTH')
        print(f'  Send "toggle_mode" to switch SMOOTH ↔ JUMPY')
        print(f'{"="*60}\n')

        while self.running:
            try:
                url = f'{self.ws_url}?mode=hardware&stream_key={self.stream_key}'
                self.ws = websocket.WebSocketApp(
                    url,
                    on_open=self.on_ws_open,
                    on_message=self.on_ws_message,
                    on_error=self.on_ws_error,
                    on_close=self.on_ws_close,
                )
                # Run WS in a thread so animation ticking runs in main thread
                ws_thread = threading.Thread(target=lambda: self.ws.run_forever(ping_interval=30, ping_timeout=10), daemon=True)
                ws_thread.start()

                while ws_thread.is_alive() and self.running:
                    self._tick_animations()
                    time.sleep(0.04)

            except Exception as e:
                print(f'[WS] Connection failed: {e}')

            if self.running:
                print(f'[WS] Reconnecting in {self._reconnect_delay}s...')
                time.sleep(self._reconnect_delay)
                self._reconnect_delay = min(self._reconnect_delay * 2, 30)

    def stop(self):
        self.running = False
        with self._drive_lock:
            self.held_keys.clear()
        self._stop()
        if self.ws:
            self.ws.close()
        if self.cli:
            try:
                self.cli.disconnect()
                self.cli.stop()
            except Exception:
                pass


# ── CLI Entry Point ───────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='OpenVibe.Live Cozmo Hardware Bridge')
    parser.add_argument('--url', default=os.environ.get('OV_WS_URL', 'wss://openvibe.live/ws/control'),
                        help='OpenVibe.Live control WebSocket URL')
    parser.add_argument('--stream-key', default=os.environ.get('OV_STREAM_KEY', ''),
                        help='Stream key for authentication')
    args = parser.parse_args()

    if not args.stream_key:
        print('[ERROR] Stream key required. Use --stream-key or set OV_STREAM_KEY env var')
        sys.exit(1)

    bridge = CozmoHardwareBridge(args.url, args.stream_key)

    try:
        bridge.run()
    except KeyboardInterrupt:
        print('\n[Bridge] Shutting down...')
        bridge.stop()


if __name__ == '__main__':
    main()


Connects to the OpenVibe.Live Control WebSocket as a hardware client,
translates incoming commands into pycozmo actions on a physical Cozmo robot.

Requirements:
    pip install pycozmo websocket-client

Usage:
    python3 cozmo-bridge.py --url ws://localhost:3000/ws/control --stream-key YOUR_STREAM_KEY

Environment Variables (alternative to CLI args):
    OV_WS_URL        WebSocket URL  (default: ws://localhost:3000/ws/control)
    OV_STREAM_KEY    Stream key for authentication

Supported commands (sent from OpenVibe.Live control panel):
    forward, backward, turn_left, turn_right,
    lift_up, lift_down, head_up, head_down,
    say:<text>, anim:<trigger>
"""

import argparse
import json
import os
import sys
import threading
import time
import traceback

try:
    import pycozmo
except ImportError:
    pycozmo = None

try:
    import websocket
except ImportError:
    websocket = None


# ── Command → Cozmo Action Mapping ───────────────────────────

DRIVE_SPEED = 100       # mm/s
TURN_SPEED = 80         # mm/s differential
DRIVE_DURATION = 0.4    # seconds
LIFT_SPEED = 3.0        # rad/s
HEAD_SPEED = 1.0        # rad/s
MOVE_DURATION = 0.3     # seconds for lift/head


def handle_command(cli, command_str):
    """Translate a OpenVibe.Live control command to a pycozmo action."""
    cmd = command_str.strip().lower()

    if cmd == 'forward':
        cli.drive_wheels(DRIVE_SPEED, DRIVE_SPEED, duration=DRIVE_DURATION)
    elif cmd == 'backward':
        cli.drive_wheels(-DRIVE_SPEED, -DRIVE_SPEED, duration=DRIVE_DURATION)
    elif cmd == 'turn_left':
        cli.drive_wheels(-TURN_SPEED, TURN_SPEED, duration=DRIVE_DURATION)
    elif cmd == 'turn_right':
        cli.drive_wheels(TURN_SPEED, -TURN_SPEED, duration=DRIVE_DURATION)
    elif cmd == 'lift_up':
        cli.move_lift(LIFT_SPEED)
        time.sleep(MOVE_DURATION)
        cli.move_lift(0.0)
    elif cmd == 'lift_down':
        cli.move_lift(-LIFT_SPEED)
        time.sleep(MOVE_DURATION)
        cli.move_lift(0.0)
    elif cmd == 'head_up':
        cli.move_head(HEAD_SPEED)
        time.sleep(MOVE_DURATION)
        cli.move_head(0.0)
    elif cmd == 'head_down':
        cli.move_head(-HEAD_SPEED)
        time.sleep(MOVE_DURATION)
        cli.move_head(0.0)
    elif cmd.startswith('say:'):
        text = command_str[4:].strip()[:200]
        if text:
            cli.say(text)
    elif cmd.startswith('anim:'):
        trigger = command_str[5:].strip()
        try:
            cli.play_anim_trigger(getattr(pycozmo.anim.Triggers, trigger))
        except AttributeError:
            print(f'[Cozmo] Unknown animation trigger: {trigger}')
    else:
        print(f'[Cozmo] Unknown command: {cmd}')
        return False

    return True


# ── WebSocket Client ──────────────────────────────────────────

class CozmoHardwareBridge:
    """Bridges OpenVibe.Live control WebSocket ↔ physical Cozmo robot."""

    def __init__(self, ws_url, stream_key):
        self.ws_url = ws_url
        self.stream_key = stream_key
        self.ws = None
        self.cozmo_cli = None
        self.running = False
        self._reconnect_delay = 2

    def connect_cozmo(self):
        """Connect to Cozmo over BLE via pycozmo."""
        if pycozmo is None:
            print('[Cozmo] pycozmo not installed — running in DRY RUN mode')
            print('[Cozmo] Install with: pip install pycozmo')
            return None

        print('[Cozmo] Connecting to Cozmo robot...')
        cli = pycozmo.Client()
        cli.start()
        cli.connect()
        cli.wait_for_robot()
        print('[Cozmo] Robot connected')
        return cli

    def send_status(self, status_data):
        """Send a status update back to OpenVibe.Live."""
        if self.ws:
            try:
                self.ws.send(json.dumps({'type': 'status', **status_data}))
            except Exception:
                pass

    def on_ws_message(self, ws, raw):
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return

        if msg.get('type') == 'connected':
            print(f'[WS] Registered as hardware client')
            self.send_status({'cozmo': 'connected' if self.cozmo_cli else 'dry_run'})
            return

        if msg.get('type') == 'command':
            cmd = msg.get('command', '')
            user = msg.get('from_user', '?')
            print(f'[CMD] {user} → {cmd}')

            if self.cozmo_cli:
                try:
                    handle_command(self.cozmo_cli, cmd)
                except Exception as e:
                    print(f'[Cozmo] Command error: {e}')
                    self.send_status({'error': str(e)})
            else:
                # Dry-run mode — just log
                print(f'[DRY RUN] Would execute: {cmd}')

    def on_ws_error(self, ws, error):
        print(f'[WS] Error: {error}')

    def on_ws_close(self, ws, code, reason):
        print(f'[WS] Disconnected (code={code})')

    def on_ws_open(self, ws):
        print(f'[WS] Connected to {self.ws_url}')

    def run(self):
        """Main loop: connect to Cozmo, then maintain WS connection."""
        if websocket is None:
            print('[ERROR] websocket-client not installed')
            print('Install with: pip install websocket-client')
            sys.exit(1)

        self.running = True

        # Connect to Cozmo first
        try:
            self.cozmo_cli = self.connect_cozmo()
        except Exception as e:
            print(f'[Cozmo] Connection failed: {e} — continuing in DRY RUN mode')
            self.cozmo_cli = None

        # WebSocket reconnect loop
        while self.running:
            try:
                url = f'{self.ws_url}?mode=hardware&stream_key={self.stream_key}'
                self.ws = websocket.WebSocketApp(
                    url,
                    on_open=self.on_ws_open,
                    on_message=self.on_ws_message,
                    on_error=self.on_ws_error,
                    on_close=self.on_ws_close,
                )
                self.ws.run_forever(ping_interval=30, ping_timeout=10)
            except Exception as e:
                print(f'[WS] Connection failed: {e}')

            if self.running:
                print(f'[WS] Reconnecting in {self._reconnect_delay}s...')
                time.sleep(self._reconnect_delay)
                self._reconnect_delay = min(self._reconnect_delay * 2, 30)

    def stop(self):
        self.running = False
        if self.ws:
            self.ws.close()
        if self.cozmo_cli:
            try:
                self.cozmo_cli.disconnect()
                self.cozmo_cli.stop()
            except Exception:
                pass


# ── CLI Entry Point ───────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='OpenVibe.Live Cozmo Hardware Bridge')
    parser.add_argument('--url', default=os.environ.get('OV_WS_URL', 'ws://localhost:3000/ws/control'),
                        help='OpenVibe.Live control WebSocket URL')
    parser.add_argument('--stream-key', default=os.environ.get('OV_STREAM_KEY', ''),
                        help='Stream key for authentication')
    args = parser.parse_args()

    if not args.stream_key:
        print('[ERROR] Stream key required. Use --stream-key or set OV_STREAM_KEY')
        sys.exit(1)

    bridge = CozmoHardwareBridge(args.url, args.stream_key)

    try:
        bridge.run()
    except KeyboardInterrupt:
        print('\n[Bridge] Shutting down...')
        bridge.stop()


if __name__ == '__main__':
    main()
