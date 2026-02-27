#!/usr/bin/env python3
"""Sync Pi settings (Windows canonical -> Linux variant) for chezmoi source.

Usage:
  python dot_pi/agent/scripts/sync-settings.py
  python dot_pi/agent/scripts/sync-settings.py --from "C:/Users/<user>/.pi/agent/settings.json"
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
AGENT_DIR = SCRIPT_DIR.parent
WINDOWS_OUT = AGENT_DIR / "settings.windows.json"
LINUX_OUT = AGENT_DIR / "settings.linux.json"


def _norm_path_string(value: str) -> str:
    if "://" in value:
        return value
    value = value.replace("\\", "/")
    while "//" in value:
        value = value.replace("//", "/")
    return value


def _to_linux_variant(data: dict) -> dict:
    cloned = json.loads(json.dumps(data))

    for key in ("skills", "extensions", "themes"):
        if isinstance(cloned.get(key), list):
            cloned[key] = [
                _norm_path_string(v) if isinstance(v, str) else v
                for v in cloned[key]
            ]

    packages = cloned.get("packages")
    if isinstance(packages, list):
        for pkg in packages:
            if not isinstance(pkg, dict):
                continue
            for key in ("extensions", "skills", "themes", "prompts"):
                if isinstance(pkg.get(key), list):
                    pkg[key] = [
                        _norm_path_string(v) if isinstance(v, str) else v
                        for v in pkg[key]
                    ]

    return cloned


def _default_live_windows_settings() -> Path:
    userprofile = os.environ.get("USERPROFILE")
    if not userprofile:
        raise SystemExit("USERPROFILE is not set. Pass --from explicitly.")
    return Path(userprofile) / ".pi" / "agent" / "settings.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--from", dest="source", help="Path to live windows settings.json")
    args = parser.parse_args()

    source = Path(args.source) if args.source else _default_live_windows_settings()
    if not source.exists():
        raise SystemExit(f"Source file not found: {source}")

    raw = source.read_text(encoding="utf-8")
    data = json.loads(raw)

    WINDOWS_OUT.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

    linux = _to_linux_variant(data)
    LINUX_OUT.write_text(json.dumps(linux, indent=2) + "\n", encoding="utf-8")

    print(f"Wrote: {WINDOWS_OUT}")
    print(f"Wrote: {LINUX_OUT}")


if __name__ == "__main__":
    main()
