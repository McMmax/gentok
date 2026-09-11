"""LLM wrapper for highlight scoring.

Providers, tried in this order (configurable via LLM_PROVIDER=auto|cli|api|off):
  cli  Claude Code CLI (`claude -p`) — uses your Claude Pro/Max SUBSCRIPTION
       (login once with `claude` or generate a token with `claude setup-token`).
  api  Direct Anthropic API — needs ANTHROPIC_API_KEY (pay-per-token).

With no provider available, the pipeline falls back to heatmap/audio ranking.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess

from ..config import ANTHROPIC_API_KEY, ANTHROPIC_MODEL, LLM_PROVIDER

_cli_path = False  # False = not probed yet


def _find_cli():
    global _cli_path
    if _cli_path is False:
        _cli_path = shutil.which("claude")
    return _cli_path


def available() -> bool:
    if LLM_PROVIDER == "off":
        return False
    if LLM_PROVIDER == "api":
        return bool(ANTHROPIC_API_KEY)
    if LLM_PROVIDER == "cli":
        return _find_cli() is not None
    return _find_cli() is not None or bool(ANTHROPIC_API_KEY)


def _parse_json(text: str):
    m = re.search(r"\[.*\]|\{.*\}", text, re.DOTALL)
    try:
        return json.loads(m.group(0)) if m else None
    except json.JSONDecodeError:
        return None


# public alias — used by reference.py's vision-analysis pass too
parse_json = _parse_json


def _via_cli(prompt: str):
    cli = _find_cli()
    if not cli:
        return None
    cmd = [cli, "-p", "--output-format", "text"]
    if cli.lower().endswith((".cmd", ".bat")):  # Windows npm shim
        cmd = ["cmd", "/c"] + cmd
    try:
        # Prompt via stdin (transcripts exceed Windows arg-length limits)
        proc = subprocess.run(
            cmd, input=prompt, capture_output=True, text=True,
            encoding="utf-8", timeout=300,
        )
        if proc.returncode != 0:
            return None
        return _parse_json(proc.stdout)
    except (subprocess.TimeoutExpired, OSError):
        return None


def _via_api(prompt: str, max_tokens: int):
    if not ANTHROPIC_API_KEY:
        return None
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        msg = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return _parse_json("".join(b.text for b in msg.content if b.type == "text"))
    except Exception:
        return None


def complete_json(prompt: str, max_tokens: int = 2000):
    """Send prompt, parse first JSON array/object in reply. None on failure."""
    if LLM_PROVIDER == "off":
        return None
    if LLM_PROVIDER == "cli":
        return _via_cli(prompt)
    if LLM_PROVIDER == "api":
        return _via_api(prompt, max_tokens)
    # auto: subscription first (free with your plan), API key as fallback
    return _via_cli(prompt) or _via_api(prompt, max_tokens)
