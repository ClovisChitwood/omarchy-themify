#!/usr/bin/python3
"""Omarchy Themify native messaging host.

Two ways it learns the theme changed:

  1. EVENT (primary): omarchy's own `theme-set` hook runs our hook script, which
     signals every running host with SIGUSR1. Instant, and costs nothing between
     changes.
  2. POLL (fallback): a slow mtime check of colors.toml, so it still follows if
     the hook isn't installed (e.g. a hand-loaded checkout).

Protocol: 4-byte little-endian length + JSON, each direction. Pushes
{"type":"palette", ...} on connect and on every change, and answers
{"cmd":"ping"} with the current palette (the popup's refresh button).

Registers a pidfile under $XDG_RUNTIME_DIR/omarchy-themify/ so the theme-set hook
can find and signal it. Multiple browsers => multiple hosts => the hook signals
all of them.
"""

import json
import os
import select
import signal
import struct
import sys
import tomllib

CURRENT_DIR = os.path.expanduser("~/.local/state/omarchy/current")
COLORS_TOML = os.path.join(CURRENT_DIR, "theme", "colors.toml")
NAME_FILE = os.path.join(CURRENT_DIR, "theme.name")

RUNTIME_DIR = os.path.join(
    os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "omarchy-themify"
)
PIDFILE = os.path.join(RUNTIME_DIR, f"host.{os.getpid()}")

POLL_SECONDS = 5.0  # fallback only; the hook is the fast path

# Named semantic colors (canonical Omarchy palette) plus the color0..color15
# ansi slots — some themes ship only the latter (retro PC palettes do), so both
# are forwarded and the extension resolves either form.
DESIRED_KEYS = (
    "mode", "accent", "selection", "muted",
    "background", "dark_background", "darker_background", "lighter_background",
    "foreground", "dark_foreground", "light_foreground", "bright_foreground",
    "red", "yellow", "orange", "green", "cyan", "blue", "magenta", "brown",
    "bright_red", "bright_yellow", "bright_green", "bright_cyan",
    "bright_blue", "bright_magenta",
) + tuple(f"color{i}" for i in range(16))


class _Terminate(Exception):
    """Raised from the SIGTERM/SIGINT handler to unwind cleanly."""


_wake_w = -1


def _on_signal(_signum, _frame):
    # SIGUSR1: write a byte to the self-pipe so select() unblocks. os.write on a
    # non-blocking fd is async-signal-safe; set_wakeup_fd proved unreliable here
    # (the byte never reached the pipe), so the handler does it directly.
    try:
        os.write(_wake_w, b"\x01")
    except OSError:
        pass


def _on_terminate(_signum, _frame):
    # Tell the loop to exit so the pidfile is removed. SIGTERM would otherwise
    # kill us instantly and leave a stale pidfile behind.
    try:
        os.write(_wake_w, b"\x01")
    except OSError:
        pass
    raise _Terminate()


def read_exact(fd, n):
    buf = b""
    while len(buf) < n:
        chunk = os.read(fd, n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def read_frame():
    raw = read_exact(0, 4)
    if raw is None:
        return None
    (length,) = struct.unpack("<I", raw)
    body = read_exact(0, length)
    if body is None:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {}


def write_frame(obj):
    body = json.dumps(obj).encode("utf-8")
    os.write(1, struct.pack("<I", len(body)) + body)
    sys.stdout.flush()


def current_palette():
    theme_name = "unknown"
    try:
        with open(NAME_FILE, encoding="utf-8") as f:
            theme_name = f.read().strip() or "unknown"
    except OSError:
        pass

    if not os.path.exists(COLORS_TOML):
        return {"name": theme_name, "found": False, "error": "no colors.toml"}

    try:
        with open(COLORS_TOML, "rb") as f:
            raw = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        return {"name": theme_name, "found": False, "error": str(exc)}

    return {"name": theme_name, "found": True,
            **{k: raw[k] for k in DESIRED_KEYS if k in raw}}


def mtime():
    try:
        return os.stat(COLORS_TOML).st_mtime_ns
    except OSError:
        return None


def register_pidfile():
    try:
        os.makedirs(RUNTIME_DIR, mode=0o700, exist_ok=True)
        with open(PIDFILE, "w", encoding="utf-8") as f:
            f.write(f"{os.getpid()}\n")
    except OSError:
        pass


def unregister_pidfile():
    try:
        os.unlink(PIDFILE)
    except OSError:
        pass


def main():
    global _wake_w

    register_pidfile()

    # Self-pipe: the SIGUSR1 handler writes a byte so select() unblocks promptly
    # instead of waiting out the poll timeout. BOTH ends must be non-blocking:
    # the drain loop calls os.read until it returns empty, and with a blocking
    # read end that second read hangs forever.
    wake_r, wake_w = os.pipe()
    os.set_blocking(wake_r, False)
    os.set_blocking(wake_w, False)
    _wake_w = wake_w
    signal.signal(signal.SIGUSR1, _on_signal)
    signal.signal(signal.SIGTERM, _on_terminate)
    signal.signal(signal.SIGINT, _on_terminate)

    last = current_palette()
    write_frame({"type": "palette", "palette": last})
    last_sig = json.dumps(last, sort_keys=True)
    last_mtime = mtime()

    try:
        while True:
            try:
                ready, _, _ = select.select([0, wake_r], [], [], POLL_SECONDS)
            except InterruptedError:
                ready = [wake_r]

            pushed = False

            # A signal (theme-set hook) told us to re-read.
            if wake_r in ready:
                try:
                    while os.read(wake_r, 4096):
                        pass
                except (BlockingIOError, OSError):
                    pass
                pal = current_palette()
                sig = json.dumps(pal, sort_keys=True)
                if sig != last_sig:
                    write_frame({"type": "palette", "palette": pal})
                    last_sig = sig
                last_mtime = mtime()
                pushed = True

            # Inbound message from the browser.
            if 0 in ready:
                frame = read_frame()
                if frame is None:
                    break  # browser closed the pipe
                if frame.get("cmd") == "ping":
                    write_frame({"type": "palette", "palette": current_palette()})
                    last_mtime = mtime()
                continue

            # Fallback: notice a theme change even without the hook.
            m = mtime()
            if not pushed and m is not None and m != last_mtime:
                pal = current_palette()
                sig = json.dumps(pal, sort_keys=True)
                if sig != last_sig:
                    write_frame({"type": "palette", "palette": pal})
                    last_sig = sig
                last_mtime = m
    except _Terminate:
        pass
    finally:
        unregister_pidfile()


if __name__ == "__main__":
    main()
