"""Reuse an installed Chromium browser without downloading a second browser."""

from __future__ import annotations

import os
from pathlib import Path


def chromium_launch_options() -> dict[str, str]:
    """Resolve an explicit executable, a Windows system browser, or Playwright default.

    This only selects the executable; callers retain headless/file-access options
    and all test assertions. A bad explicit override fails loudly rather than
    silently testing another browser.
    """
    override = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "").strip()
    if override:
        path = Path(override).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH does not exist: {path}")
        return {"executable_path": str(path)}

    if os.name == "nt":
        roots = [
            Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")),
            Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")),
        ]
        local = os.environ.get("LOCALAPPDATA")
        if local:
            roots.append(Path(local))
        for relative in ("Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"):
            for root in roots:
                path = root / relative
                if path.is_file():
                    return {"executable_path": str(path)}
    return {}
