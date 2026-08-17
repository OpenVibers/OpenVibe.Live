#!/usr/bin/env python3
"""
OpenVibe.Live — Hardware Controller Script
Connects to OpenVibe.Live control WebSocket and executes commands
on Raspberry Pi GPIO, servos, motors, TTS, etc.

Usage:
    python3 controller.py --key YOUR_STREAM_KEY --server openvibe.live

Requirements:
    - websocket-client: pip3 install websocket-client
    - For TTS: espeak or pico2wave (apt install espeak)
    - For GPIO: RPi.GPIO or gpiozero (pip3 install gpiozero)
"""

import argparse
import json
import subprocess
import sys
import signal
import time
import threading

try:
    import websocket
except ImportError:
    print("[ERROR] websocket-client not installed. Run: pip3 install websocket-client")
    sys.exit(1)

# Try to import GPIO (Raspberry Pi only)
GPIO_AVAILABLE = False
try:
    from gpiozero import Motor, Servo, LED
    GPIO_AVAILABLE = True
except ImportError:
    pass

DEFAULT_SERVER = "localhost"
DEFAULT_PORT = 3000

# ═══════════════════════════════════════════════════════════════
# Command Handlers
# ═══════════════════════════════════════════════════════════════

class HardwareController:
    """Handles incoming commands and maps them to hardware actions."""

    def __init__(self, config=None):
        self.config = config or {}
        self.motors = {}
        self.servos = {}
        self.leds = {}

        if GPIO_AVAILABLE and self.config.get("enable_gpio"):
            self._init_gpio()

    def _init_gpio(self):
        """Initialize GPIO devices based on config."""
        gpio = self.config.get("gpio", {})

        # Motors (L298N or similar H-bridge)
        if "motor_left" in gpio:
            pins = gpio["motor_left"]
            self.motors["left"] = Motor(pins["forward"], pins["backward"])
        if "motor_right" in gpio:
            pins = gpio["motor_right"]
            self.motors["right"] = Motor(pins["forward"], pins["backward"])

        # Servos
        for name, pin in gpio.get("servos", {}).items():
            self.servos[name] = Servo(pin)

        # LEDs
        for name, pin in gpio.get("leds", {}).items():
            self.leds[name] = LED(pin)

        print(f"[GPIO] Motors: {list(self.motors.keys())}, Servos: {list(self.servos.keys())}, LEDs: {list(self.leds.keys())}")

    def handle_command(self, command, data=None):
        """Route a command to the appropriate handler."""
        handlers = {
            "forward": self.cmd_forward,
            "backward": self.cmd_backward,
            "left": self.cmd_left,
            "right": self.cmd_right,
            "stop": self.cmd_stop,
            "tts": self.cmd_tts,
            "led_on": self.cmd_led_on,
            "led_off": self.cmd_led_off,
            "horn": self.cmd_horn,
            "servo_up": self.cmd_servo_up,
            "servo_down": self.cmd_servo_down,
            "servo_center": self.cmd_servo_center,
        }

        handler = handlers.get(command)
        if handler:
            print(f"[CMD] {command} {data or ''}")
            handler(data)
        else:
            print(f"[CMD] Unknown command: {command}")

    # Movement commands
    def cmd_forward(self, data=None):
        duration = (data or {}).get("duration", 0.5)
        if self.motors:
            for m in self.motors.values():
                m.forward()
            threading.Timer(duration, self.cmd_stop).start()
        else:
            print("  → [SIM] Moving forward")

    def cmd_backward(self, data=None):
        duration = (data or {}).get("duration", 0.5)
        if self.motors:
            for m in self.motors.values():
                m.backward()
            threading.Timer(duration, self.cmd_stop).start()
        else:
            print("  → [SIM] Moving backward")

    def cmd_left(self, data=None):
        duration = (data or {}).get("duration", 0.3)
        if "left" in self.motors and "right" in self.motors:
            self.motors["left"].backward()
            self.motors["right"].forward()
            threading.Timer(duration, self.cmd_stop).start()
        else:
            print("  → [SIM] Turning left")

    def cmd_right(self, data=None):
        duration = (data or {}).get("duration", 0.3)
        if "left" in self.motors and "right" in self.motors:
            self.motors["left"].forward()
            self.motors["right"].backward()
            threading.Timer(duration, self.cmd_stop).start()
        else:
            print("  → [SIM] Turning right")

    def cmd_stop(self, data=None):
        for m in self.motors.values():
            m.stop()
        print("  → [SIM] Stopped" if not self.motors else "  → Motors stopped")

    # TTS
    def cmd_tts(self, data=None):
        text = (data or {}).get("text", "hello from openvibe streamer")
        try:
            subprocess.Popen(["espeak", "-s", "150", text],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print(f"  → TTS: {text}")
        except FileNotFoundError:
            print(f"  → [SIM] TTS (espeak not installed): {text}")

    # LED
    def cmd_led_on(self, data=None):
        name = (data or {}).get("name", "main")
        if name in self.leds:
            self.leds[name].on()
        print(f"  → LED {name} ON")

    def cmd_led_off(self, data=None):
        name = (data or {}).get("name", "main")
        if name in self.leds:
            self.leds[name].off()
        print(f"  → LED {name} OFF")

    # Horn/buzzer
    def cmd_horn(self, data=None):
        duration = (data or {}).get("duration", 0.5)
        try:
            subprocess.Popen(["aplay", "-d", str(duration), "/usr/share/sounds/alsa/Front_Center.wav"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            print("  → [SIM] Horn!")

    # Servo
    def cmd_servo_up(self, data=None):
        name = (data or {}).get("name", "tilt")
        if name in self.servos:
            self.servos[name].value = min(1, self.servos[name].value + 0.2)
        print(f"  → Servo {name} UP")

    def cmd_servo_down(self, data=None):
        name = (data or {}).get("name", "tilt")
        if name in self.servos:
            self.servos[name].value = max(-1, self.servos[name].value - 0.2)
        print(f"  → Servo {name} DOWN")

    def cmd_servo_center(self, data=None):
        name = (data or {}).get("name", "tilt")
        if name in self.servos:
            self.servos[name].mid()
        print(f"  → Servo {name} CENTER")


# ═══════════════════════════════════════════════════════════════
# WebSocket Client
# ═══════════════════════════════════════════════════════════════

def connect(args, controller):
    """Connect to OpenVibe.Live control WebSocket."""
    protocol = "wss" if args.ssl else "ws"
    url = f"{protocol}://{args.server}:{args.port}/ws/control"
    reconnect_delay = 5

    def on_open(ws):
        print(f"[WS] Connected to {url}")
        ws.send(json.dumps({
            "type": "join",
            "role": "hardware",
            "streamKey": args.key,
        }))

    def on_message(ws, message):
        try:
            msg = json.loads(message)
            if msg.get("type") == "command":
                controller.handle_command(msg["command"], msg.get("data"))
            elif msg.get("type") == "error":
                print(f"[WS ERROR] {msg.get('message')}")
            elif msg.get("type") == "ping":
                ws.send(json.dumps({"type": "pong"}))
        except json.JSONDecodeError:
            print(f"[WS] Invalid message: {message}")

    def on_error(ws, error):
        print(f"[WS ERROR] {error}")

    def on_close(ws, code, reason):
        print(f"[WS] Disconnected (code={code}, reason={reason})")
        if not args.no_reconnect:
            print(f"[WS] Reconnecting in {reconnect_delay}s...")
            time.sleep(reconnect_delay)
            connect(args, controller)

    ws = websocket.WebSocketApp(url,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close)

    ws.run_forever()

def main():
    parser = argparse.ArgumentParser(description="OpenVibe.Live — Hardware Controller")
    parser.add_argument("--key", required=True, help="Your OpenVibe.Live stream key")
    parser.add_argument("--server", default=DEFAULT_SERVER, help=f"Server hostname (default: {DEFAULT_SERVER})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Server port (default: {DEFAULT_PORT})")
    parser.add_argument("--ssl", action="store_true", help="Use WSS")
    parser.add_argument("--no-reconnect", action="store_true", help="Disable auto-reconnect")
    parser.add_argument("--enable-gpio", action="store_true", help="Enable GPIO (Raspberry Pi only)")
    parser.add_argument("--config", help="Path to GPIO config JSON file")
    args = parser.parse_args()

    config = {"enable_gpio": args.enable_gpio}
    if args.config:
        try:
            with open(args.config) as f:
                config = json.load(f)
                config["enable_gpio"] = args.enable_gpio
        except (FileNotFoundError, json.JSONDecodeError) as e:
            print(f"[WARN] Failed to load config: {e}")

    controller = HardwareController(config)

    print(f"\n🏕️  OpenVibe.Live — Hardware Controller")
    print(f"   Server: {args.server}:{args.port}")
    print(f"   GPIO  : {'enabled' if args.enable_gpio and GPIO_AVAILABLE else 'simulation mode'}")
    print(f"   Press Ctrl+C to stop.\n")

    signal.signal(signal.SIGINT, lambda s, f: sys.exit(0))
    signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))

    connect(args, controller)

if __name__ == "__main__":
    main()
