#!/usr/bin/env python
"""Read Google Antigravity CLI model quota without a human at the terminal.

Why this exists
---------------
`agy` exposes quota only as `/usage` (alias `/quota`), an interactive TUI panel.
There is no `agy usage` subcommand -- version 1.1.7 offers only agent, agents,
changelog, help, install, models, plugin, plugins, update -- and the CLI never
persists quota to disk. Its log shows `quota_manager.go: doRefreshQuota` pulling
the numbers from a backend into memory, and nothing under
`~/.gemini/antigravity-cli/` holds them afterwards.

So the only way to read the numbers is to render the panel and parse it. The CLI
is a full-screen TUI and will not draw into a plain pipe, so it runs under
ConPTY.

This is inherently a screen-scrape of an interface its authors may change
without notice. Everything here fails closed: on any doubt it reports
`ok: false` with a reason rather than guessing a number, because a wrong quota
figure is worse than a missing one.

Output: a single JSON object on stdout. Exit 0 when parsing succeeded, 1
otherwise. Never prints the raw panel unless --debug is passed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

ANSI_RE = re.compile(
    r"\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])"
)

# The panel header. Parsing starts at the LAST occurrence because a TUI redraws
# itself and earlier frames can be partial.
PANEL_MARKER = "Models & Quota"

ACCOUNT_RE = re.compile(r"^\s*Account:\s*(\S+)\s*$")
# A group header is an all-caps line such as "GEMINI MODELS" or
# "CLAUDE AND GPT MODELS". Anchored to avoid matching bar glyphs or help text.
GROUP_RE = re.compile(r"^\s*([A-Z][A-Z0-9 &/+.-]{2,60})\s*$")
MODELS_IN_GROUP_RE = re.compile(r"^\s*Models within this group:\s*(.+?)\s*$")
# "Weekly Limit", "Five Hour Limit", "Monthly Limit", ...
WINDOW_RE = re.compile(r"^\s*([A-Z][A-Za-z ]{2,30}?Limit)\s*$")
PERCENT_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%")
# "Refreshes in 49h 40m", "Refreshes in 12m", "Refreshes in 2d 3h"
REFRESH_RE = re.compile(
    r"Refreshes in\s+(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?",
    re.I,
)
QUOTA_AVAILABLE_RE = re.compile(r"Quota available", re.I)

# Lines that look like group headers but are not.
GROUP_BLOCKLIST = {"MODELS & QUOTA", "ACCOUNT", "GEMINI", "CLAUDE", "GPT"}


def clean(text: str) -> str:
    text = ANSI_RE.sub("", text)
    return text.replace("\r\n", "\n").replace("\r", "\n")


def parse_refresh_seconds(line: str) -> int | None:
    match = REFRESH_RE.search(line)
    if not match:
        return None
    days, hours, minutes = (int(g) if g else 0 for g in match.groups())
    total = days * 86400 + hours * 3600 + minutes * 60
    return total or None


def parse_panel(text: str) -> dict:
    """Turn the rendered panel into structured quota data.

    Percentages in this panel are REMAINING, not used: the CLI prints
    `97.91%` next to `98% remaining`. The caller is responsible for any
    conversion; this function reports exactly what was on screen.
    """
    start = text.rfind(PANEL_MARKER)
    if start == -1:
        return {"ok": False, "reason": "panel-not-rendered"}

    lines = text[start:].split("\n")
    account: str | None = None
    groups: list[dict] = []
    current: dict | None = None
    window: dict | None = None

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue

        if account is None:
            account_match = ACCOUNT_RE.match(line)
            if account_match:
                account = account_match.group(1)
                continue

        models_match = MODELS_IN_GROUP_RE.match(line)
        if models_match and current is not None:
            current["models"] = [
                part.strip() for part in models_match.group(1).split(",") if part.strip()
            ]
            continue

        window_match = WINDOW_RE.match(line)
        if window_match and current is not None:
            window = {
                "label": window_match.group(1).strip(),
                "percentRemaining": None,
                "resetsInSeconds": None,
            }
            current["windows"].append(window)
            continue

        # A percentage belongs to the window most recently opened.
        if window is not None and window["percentRemaining"] is None:
            percent_match = PERCENT_RE.search(line)
            if percent_match:
                window["percentRemaining"] = float(percent_match.group(1))
                continue

        if window is not None:
            seconds = parse_refresh_seconds(line)
            if seconds is not None:
                window["resetsInSeconds"] = seconds
                window = None
                continue
            if QUOTA_AVAILABLE_RE.search(line):
                # No reset shown: the window is not currently constrained.
                window = None
                continue

        group_match = GROUP_RE.match(line)
        if group_match:
            name = group_match.group(1).strip()
            if name.upper() in GROUP_BLOCKLIST or len(name) < 4:
                continue
            current = {"name": name, "models": [], "windows": []}
            window = None
            groups.append(current)

    groups = [group for group in groups if group["windows"]]
    if not groups:
        return {"ok": False, "reason": "no-quota-groups-parsed"}
    # A group whose percentage never parsed means the layout moved. Fail closed
    # rather than silently reporting a group as 0% or 100%.
    for group in groups:
        for entry in group["windows"]:
            if entry["percentRemaining"] is None:
                return {"ok": False, "reason": "window-without-percentage"}

    now = datetime.now(timezone.utc)
    for group in groups:
        for entry in group["windows"]:
            seconds = entry["resetsInSeconds"]
            entry["resetAt"] = (
                (now + timedelta(seconds=seconds)).isoformat() if seconds else None
            )

    return {
        "ok": True,
        "account": account,
        "capturedAt": now.isoformat(),
        "groups": groups,
    }


def capture_panel(agy: str, cwd: str, boot_timeout: float, panel_timeout: float) -> tuple[str, str | None]:
    try:
        from winpty import PtyProcess
    except ImportError:
        return "", "pywinpty-missing"

    try:
        proc = PtyProcess.spawn([agy], cwd=cwd, dimensions=(50, 200))
    except Exception as exc:
        return "", f"spawn-failed: {type(exc).__name__}"

    chunks: list[str] = []

    def reader() -> None:
        while True:
            try:
                chunk = proc.read(4096)
            except (EOFError, Exception):
                break
            if chunk:
                chunks.append(chunk)

    threading.Thread(target=reader, daemon=True).start()

    def wait_for(pattern: str, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if re.search(pattern, clean("".join(chunks)), re.I):
                return True
            time.sleep(0.4)
        return False

    try:
        if not wait_for(r"(?:>|Ask|Type|agy|Antigravity)", boot_timeout):
            return clean("".join(chunks)), "cli-did-not-start"
        # The prompt box accepts input slightly after it first paints.
        time.sleep(3)
        proc.write("/usage\r")
        if not wait_for(re.escape(PANEL_MARKER), panel_timeout):
            return clean("".join(chunks)), "panel-timeout"
        # Let the panel finish painting all groups before reading it.
        time.sleep(5)
        return clean("".join(chunks)), None
    finally:
        try:
            proc.write("\x03")
            time.sleep(0.6)
            proc.terminate()
            time.sleep(0.4)
            if proc.isalive():
                proc.kill()
        except Exception:
            pass


def default_agy() -> str:
    explicit = os.environ.get("OPENCODEX_AGY_PATH")
    if explicit:
        return explicit
    local = os.path.expandvars(r"%LOCALAPPDATA%\agy\bin\agy.exe")
    return local if os.path.isfile(local) else "agy"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agy", default=default_agy())
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--boot-timeout", type=float, default=90.0)
    parser.add_argument("--panel-timeout", type=float, default=60.0)
    parser.add_argument("--debug", action="store_true", help="include the raw panel")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if not os.path.isfile(args.agy) and args.agy != "agy":
        print(json.dumps({"ok": False, "reason": "agy-not-found"}))
        return 1

    panel, failure = capture_panel(
        args.agy, args.cwd, args.boot_timeout, args.panel_timeout
    )
    result = {"ok": False, "reason": failure} if failure else parse_panel(panel)
    if args.debug:
        result["rawPanel"] = panel[-8000:]
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
