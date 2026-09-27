#!/usr/bin/python3
"""Tests the native host + theme-set hook together.

Proves the event path works and is what delivers the push (not the fallback
poll): the host's poll interval is 5s, so a palette arriving well under that
after the hook signals can only be the SIGUSR1 path.

Run: /usr/bin/python3 test-host.py
"""

import json
import os
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(ROOT, "native", "themify-host.py")
HOOK = os.path.join(ROOT, "hooks", "themify-theme-set")
COLORS = os.path.expanduser("~/.local/state/omarchy/current/theme/colors.toml")

# Isolate this test's pidfiles from any live browser-spawned host. Both the host
# and the hook read $XDG_RUNTIME_DIR, so spawning them with a private value keeps
# the test from clobbering the real hosts' pidfiles (rmtree'ing the shared dir
# deletes a live host's pidfile and silently breaks theme-switch signalling).
ISOLATED_RUNTIME = tempfile.mkdtemp(prefix="themify-test-runtime-")
RUNDIR = os.path.join(ISOLATED_RUNTIME, "omarchy-themify")
HOST_ENV = {**os.environ, "XDG_RUNTIME_DIR": ISOLATED_RUNTIME}

POLL_SECONDS = 5.0  # must match the host

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS - {name}")
    else:
        failed += 1
        print(f"FAIL - {name}" + (f"  ({detail})" if detail else ""))


def read_frame(fd, timeout):
    r, _, _ = select.select([fd], [], [], timeout)
    if not r:
        return None
    hdr = os.read(fd, 4)
    if len(hdr) < 4:
        return None
    (n,) = struct.unpack("<I", hdr)
    buf = b""
    while len(buf) < n:
        chunk = os.read(fd, n - len(buf))
        if not chunk:
            break
        buf += chunk
    return json.loads(buf)


def main():
    if not os.path.exists(COLORS):
        print(f"SKIP: no theme file at {COLORS}")
        return 0

    original = open(COLORS, "rb").read()
    shutil.rmtree(RUNDIR, ignore_errors=True)  # isolated: safe to wipe

    proc = subprocess.Popen([sys.executable, HOST], env=HOST_ENV,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    fd = proc.stdout.fileno()

    try:
        # 1. initial push on connect
        init = read_frame(fd, 5)
        check("host pushes palette on connect",
              init is not None and init.get("type") == "palette",
              str(init)[:120])
        first_sig = json.dumps(init["palette"], sort_keys=True)
        check("initial palette has theme name", init["palette"].get("name") not in (None, "", "unknown"),
              str(init["palette"].get("name")))

        # 2. pidfile registered so the hook can find it
        time.sleep(0.3)
        pidfile = os.path.join(RUNDIR, f"host.{proc.pid}")
        check("host registers pidfile", os.path.exists(pidfile), pidfile)

        # 3. hook with NO theme change -> must not spam a frame
        subprocess.run(["/bin/bash", HOOK, "same-theme"], check=True, env=HOST_ENV)
        quiet = read_frame(fd, 1.5)
        check("hook w/o change pushes nothing", quiet is None, str(quiet)[:80])

        # 4. change the theme, run the hook, expect a fast push. Mutate via TOML
        #    so this works whatever palette style the current theme uses.
        import tomllib
        data = tomllib.loads(original.decode("utf-8"))
        key = "accent" if "accent" in data else next(iter(data), None)
        if key:
            # flip to a deliberately different valid color
            new_val = "#123456" if str(data[key]).lower() != "#123456" else "#654321"
            data[key] = new_val
            alt = "".join(f'{k} = "{v}"\n' for k, v in data.items()).encode()
        else:
            alt = original + b'\naccent = "#123456"\n'
        check("test mutation actually changes the file", alt != original)
        with open(COLORS, "wb") as f:
            f.write(alt)

        t0 = time.time()
        subprocess.run(["/bin/bash", HOOK, "test-theme"], check=True, env=HOST_ENV)
        pushed = read_frame(fd, 3.0)
        dt = time.time() - t0

        check("hook delivers a fresh palette",
              pushed is not None and pushed.get("type") == "palette",
              str(pushed)[:80])
        check(f"push was event-driven, well under the {POLL_SECONDS:.0f}s poll",
              pushed is not None and dt < POLL_SECONDS - 1.5, f"{dt:.2f}s")
        if pushed:
            new_sig = json.dumps(pushed["palette"], sort_keys=True)
            check("palette content actually changed", new_sig != first_sig,
                  f"{key}={new_val}")

        # 5. ping still answered (popup refresh)
        body = json.dumps({"cmd": "ping"}).encode()
        proc.stdin.write(struct.pack("<I", len(body)) + body)
        proc.stdin.flush()
        pong = read_frame(fd, 5)
        check("ping answered with palette",
              pong is not None and pong.get("type") == "palette")

        # 6. stale pidfile cleanup by the hook
        ghost = os.path.join(RUNDIR, "host.999999")
        open(ghost, "w").write("999999\n")
        subprocess.run(["/bin/bash", HOOK, "cleanup"], check=True, env=HOST_ENV)
        check("hook prunes stale pidfile", not os.path.exists(ghost))

    finally:
        open(COLORS, "wb").write(original)
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(0.3)
        check("pidfile removed on exit",
              not os.path.exists(os.path.join(RUNDIR, f"host.{proc.pid}")))

    print(f"\n{passed} passed, {failed} failed")
    shutil.rmtree(ISOLATED_RUNTIME, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
