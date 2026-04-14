"""
Plexa MuJoCo Cart-Pole adapter -- two-mode SCP muscle.

standalone (default): behaves exactly like the SCP repo cartpole.
managed:              Plexa owns the brain.
                      Local LLM bridge disabled.
                      Pattern store decisions disabled (still logs).
                      Reflexes and physics still local.
                      Events emitted via HTTP POST to Plexa.
                      Commands received via HTTP POST from Plexa.

Run standalone:   python muscle.py
Run with viewer:  python muscle.py --view
Run managed:      python muscle.py --managed
Run both:         python muscle.py --managed --view
"""

import mujoco
import mujoco.viewer
import numpy as np
import json
import time
import sys
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import http.client
from urllib.parse import urlparse

MODEL_PATH = os.path.join(os.path.dirname(__file__), "cartpole.xml")
PATTERN_FILE = os.path.join(os.path.dirname(__file__), "patterns.json")

# Config
MUSCLE_PORT = int(os.environ.get("SCP_PORT", "8002"))
SPACE_URL = os.environ.get("SPACE_URL", "http://localhost:3000")
BODY_NAME = os.environ.get("BODY_NAME", "cartpole")


# -- Pattern Store (same logic as SCP repo, but does NOT drive decisions in managed mode) --

class PatternStore:
    def __init__(self, exploration_rate=0.02):
        self.patterns = {}
        self.confidence_threshold = 0.15
        self.exploration_rate = exploration_rate
        self.hits = 0
        self.misses = 0
        self.explorations = 0

    def features(self, state):
        return {
            "angle_bucket": round(state["pole_angle"] * 4) / 4,
            "tilting": "right" if state["pole_vel"] > 0.3 else "left" if state["pole_vel"] < -0.3 else "steady",
            "off_center": "right" if state["cart_pos"] > 0.5 else "left" if state["cart_pos"] < -0.5 else "center",
        }

    def _hash(self, feat):
        return "|".join(f"{k}:{feat[k]}" for k in sorted(feat))

    def lookup(self, state):
        h = self._hash(self.features(state))
        p = self.patterns.get(h)
        if p and p["count"] / 20.0 >= self.confidence_threshold:
            if self.exploration_rate > 0 and np.random.random() < self.exploration_rate:
                self.explorations += 1
                return None
            self.hits += 1
            return p["decision"]
        self.misses += 1
        return None

    def learn(self, state, decision):
        h = self._hash(self.features(state))
        p = self.patterns.get(h)
        if not p:
            self.patterns[h] = {"decision": decision, "count": 1}
            return
        if p["decision"] == decision:
            p["count"] = min(p["count"] + 1, 20)
        else:
            p["count"] = 1
            p["decision"] = decision

    def save(self):
        with open(PATTERN_FILE, "w") as f:
            json.dump(self.patterns, f)

    def load(self):
        if os.path.exists(PATTERN_FILE):
            with open(PATTERN_FILE) as f:
                self.patterns = json.load(f)


# -- Physics helpers --

def read_state(data):
    return {
        "cart_pos": float(data.qpos[0]),
        "cart_vel": float(data.qvel[0]),
        "pole_angle": float(data.qpos[1]),
        "pole_vel": float(data.qvel[1]),
    }


def brain_decide_local(state):
    """Local PD controller used only in standalone mode."""
    angle = state["pole_angle"]
    vel = state["pole_vel"]
    cart = state["cart_pos"]
    force = -1.5 * angle - 0.5 * vel - 0.8 * cart - 0.3 * state["cart_vel"]
    return max(-0.5, min(0.5, force))


def reflex_check(state):
    """Emergency push. Always runs, regardless of mode."""
    if state["pole_angle"] > 0.45 and state["pole_vel"] > 0.5:
        return -0.5
    if state["pole_angle"] < -0.45 and state["pole_vel"] < -0.5:
        return 0.5
    return None


def discretize_force(force):
    if force > 0.6: return "strong_right"
    if force > 0.2: return "light_right"
    if force < -0.6: return "strong_left"
    if force < -0.2: return "light_left"
    return "hold"


def force_from_decision(decision):
    return {
        "strong_right": 0.4,
        "light_right": 0.2,
        "hold": 0.0,
        "light_left": -0.2,
        "strong_left": -0.4,
    }.get(decision, 0.0)


def force_from_command(cmd):
    """Convert Plexa command into force applied to cart."""
    action = cmd.get("method") or cmd.get("action") or ""
    args = cmd.get("args") or cmd.get("parameters") or {}

    if action == "apply_force":
        direction = args.get("direction", "right")
        mag = float(args.get("magnitude", 0.4))
        mag = max(0.0, min(1.0, mag))
        return -mag if direction == "left" else mag
    if action == "reset":
        return ("reset", None)
    if action == "hold":
        return 0.0
    return None  # unknown -> ignore


# -- Shared runtime state --

class Runtime:
    def __init__(self):
        self.mode = "standalone"  # flips via POST /set_mode
        self.pending_command = None
        self.lock = threading.Lock()
        self.last_state_update_emit = 0.0
        self.stats = {
            "ticks": 0,
            "reflexes": 0,
            "brain_local_calls": 0,
            "cache_hits": 0,
            "commands_received": 0,
            "events_emitted": 0,
            "events_dropped": 0,
        }


# -- HTTP server: accept mode + commands from Plexa --

def make_handler(rt):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # quiet

        def _read_body(self):
            try:
                n = int(self.headers.get("Content-Length", "0"))
                return self.rfile.read(n).decode("utf-8") if n else ""
            except Exception:
                return ""

        def _reply(self, code, body):
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(body).encode("utf-8"))

        def do_GET(self):
            if self.path == "/mode":
                return self._reply(200, {"mode": rt.mode, "body": BODY_NAME})
            if self.path == "/health":
                return self._reply(200, {"status": "ok", "body": BODY_NAME, "mode": rt.mode})
            self._reply(404, {"error": "not found"})

        def do_POST(self):
            body = self._read_body()
            try:
                msg = json.loads(body) if body else {}
            except Exception:
                return self._reply(400, {"error": "invalid json"})

            t = msg.get("type", "")

            if self.path == "/set_mode" or t == "set_mode":
                new_mode = msg.get("mode", "standalone")
                if new_mode not in ("standalone", "managed"):
                    return self._reply(400, {"error": "invalid mode"})
                with rt.lock:
                    rt.mode = new_mode
                print(f"[cartpole] mode -> {rt.mode}")
                return self._reply(200, {"ok": True, "mode": rt.mode})

            if t == "command":
                with rt.lock:
                    rt.pending_command = msg
                    rt.stats["commands_received"] += 1
                return self._reply(200, {"ok": True})

            self._reply(404, {"error": "unknown"})

    return Handler


def start_http_server(rt):
    server = HTTPServer(("0.0.0.0", MUSCLE_PORT), make_handler(rt))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"[cartpole] HTTP listening on :{MUSCLE_PORT}")
    return server


# -- Outbound: POST events to Plexa --

def post_json(space_url, path, payload):
    try:
        url = urlparse(space_url)
        conn = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=0.5)
        body = json.dumps(payload)
        conn.request("POST", path, body=body, headers={"Content-Type": "application/json"})
        conn.getresponse().read()
        conn.close()
        return True
    except Exception:
        return False


def emit(rt, event_type, payload, priority, state):
    if rt.mode != "managed":
        return  # standalone mode does not talk to Plexa
    ok = post_json(SPACE_URL, "/emit", {
        "type": event_type,
        "body": BODY_NAME,
        "priority": priority,
        "payload": payload,
        "state": {
            "mode": rt.mode,
            "cart_pos": round(state["cart_pos"], 3),
            "cart_vel": round(state["cart_vel"], 3),
            "pole_angle": round(state["pole_angle"], 3),
            "pole_vel": round(state["pole_vel"], 3),
        },
        "ts": time.time(),
    })
    if ok:
        rt.stats["events_emitted"] += 1
    else:
        rt.stats["events_dropped"] += 1


# -- Main loop --

def main():
    use_viewer = "--view" in sys.argv
    start_managed = "--managed" in sys.argv

    print("[cartpole] Loading model...")
    model = mujoco.MjModel.from_xml_path(MODEL_PATH)
    data = mujoco.MjData(model)
    data.qvel[1] = 0.5

    store = PatternStore()
    store.load()

    rt = Runtime()
    if start_managed:
        rt.mode = "managed"
        print("[cartpole] starting in managed mode")
    start_http_server(rt)

    episodes = 0
    loop_brain = 0
    loop_cache = 0
    loop_reflex = 0
    loop_cmd = 0
    loop_num = 0

    def reset_pole():
        nonlocal episodes
        mujoco.mj_resetData(model, data)
        data.qvel[1] = np.random.uniform(-0.5, 0.5)
        data.qpos[0] = np.random.uniform(-0.3, 0.3)
        episodes += 1

    def step():
        nonlocal loop_brain, loop_cache, loop_reflex, loop_cmd
        rt.stats["ticks"] += 1
        state = read_state(data)

        # Auto-reset if past recovery
        if abs(state["pole_angle"]) > 1.0 or abs(state["cart_pos"]) > 1.8:
            reset_pole()
            if rt.mode == "managed":
                emit(rt, "cart_boundary", {"reason": "reset"}, "HIGH", state)
            return

        # 1. Reflex always runs
        rfx = reflex_check(state)
        if rfx is not None:
            data.ctrl[0] = rfx
            rt.stats["reflexes"] += 1
            loop_reflex += 1
            if rt.mode == "managed":
                emit(rt, "pole_critical", {"angle": state["pole_angle"]}, "CRITICAL", state)
            return

        # 2. Priority events in managed mode
        if rt.mode == "managed":
            ang = state["pole_angle"]
            if abs(ang) > 0.8:
                emit(rt, "pole_critical", {"angle": ang}, "CRITICAL", state)
            elif abs(ang) > 0.4:
                emit(rt, "pole_warning", {"angle": ang}, "HIGH", state)
            if abs(state["cart_pos"]) > 1.4:
                emit(rt, "cart_boundary", {"cart_pos": state["cart_pos"]}, "HIGH", state)
            # Throttled state update every 2s
            now = time.time()
            if now - rt.last_state_update_emit >= 2.0:
                emit(rt, "state_update", {}, "NORMAL", state)
                rt.last_state_update_emit = now

        # 3. Command handling (managed mode only)
        if rt.mode == "managed":
            with rt.lock:
                cmd = rt.pending_command
                rt.pending_command = None
            if cmd is not None:
                loop_cmd += 1
                force = force_from_command(cmd)
                if isinstance(force, tuple) and force[0] == "reset":
                    reset_pole()
                elif force is not None:
                    data.ctrl[0] = force
                    # still log the decision for future learning
                    store.learn(state, discretize_force(force))
                return
            # No command pending -- hold steady
            data.ctrl[0] = 0.0
            return

        # 4. Standalone mode: original behavior (cache -> local brain)
        cached = store.lookup(state)
        if cached is not None:
            data.ctrl[0] = force_from_decision(cached)
            loop_cache += 1
            return

        force = brain_decide_local(state)
        data.ctrl[0] = force
        store.learn(state, discretize_force(force))
        rt.stats["brain_local_calls"] += 1
        loop_brain += 1

    def print_loop():
        nonlocal loop_brain, loop_cache, loop_reflex, loop_cmd, loop_num
        loop_num += 1
        s = read_state(data)
        print(
            f"  Loop {loop_num:2d} [{rt.mode}]: "
            f"cmd={loop_cmd:3d} reflex={loop_reflex:3d} cache={loop_cache:3d} brain={loop_brain:3d}  "
            f"angle={s['pole_angle']:+.2f}  cart={s['cart_pos']:+.2f}"
        )
        loop_brain = 0; loop_cache = 0; loop_reflex = 0; loop_cmd = 0

    # Run loop
    try:
        if use_viewer:
            print("[cartpole] Visual mode -- close window to exit\n")
            with mujoco.viewer.launch_passive(model, data) as viewer:
                while viewer.is_running():
                    step()
                    mujoco.mj_step(model, data)
                    viewer.sync()
                    if rt.stats["ticks"] % 200 == 0:
                        print_loop()
                    time.sleep(1.0 / 60)
        else:
            print("[cartpole] Headless mode -- running until Ctrl+C\n")
            while True:
                step()
                mujoco.mj_step(model, data)
                if rt.stats["ticks"] % 200 == 0:
                    print_loop()
                time.sleep(1.0 / 60)
    except KeyboardInterrupt:
        print("\n[cartpole] shutting down")

    store.save()
    print(f"[cartpole] stats: {rt.stats}")


if __name__ == "__main__":
    main()
