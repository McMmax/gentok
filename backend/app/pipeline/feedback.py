"""Preference + outcome tracking for content-automation fine-tuning.

feedback.jsonl  — like/dislike on suggested moments (trains candidate selection)
renders.jsonl   — every rendered clip with full params (segments, layout,
                  regions, hook) so outcomes can be joined to choices later.
"""
from __future__ import annotations

import json
import time
from ..config import DATA_DIR

FEEDBACK_FILE = DATA_DIR / "feedback.jsonl"
RENDERS_FILE = DATA_DIR / "renders.jsonl"


def _append(path, entry: dict):
    entry["ts"] = int(time.time())
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _read(path, limit=500) -> list[dict]:
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    out = []
    for line in lines[-limit:]:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def add_feedback(job_id: str, video_id: str, title: str, candidate: dict, rating: int):
    _append(FEEDBACK_FILE, {
        "job_id": job_id, "video_id": video_id, "video_title": title,
        "start": candidate.get("start"), "end": candidate.get("end"),
        "hook": candidate.get("hook", ""), "reason": candidate.get("reason", ""),
        "score": candidate.get("score"), "rating": rating,
    })


def log_render(entry: dict):
    _append(RENDERS_FILE, entry)


def preference_context(max_each: int = 8) -> str:
    """Prompt block describing what the user liked/disliked. '' if no data."""
    entries = _read(FEEDBACK_FILE)
    latest: dict[tuple, dict] = {}
    for e in entries:  # last rating per moment wins
        latest[(e.get("video_id"), e.get("start"), e.get("end"))] = e
    liked = [e for e in latest.values() if e.get("rating", 0) > 0][-max_each:]
    disliked = [e for e in latest.values() if e.get("rating", 0) < 0][-max_each:]
    if not liked and not disliked:
        return ""

    def fmt(e):
        bits = []
        if e.get("hook"):
            bits.append(f'hook="{e["hook"]}"')
        if e.get("reason"):
            bits.append(e["reason"])
        return f'- [{e.get("video_title", "?")}] ' + ("; ".join(bits) or "(no notes)")

    parts = ["USER PREFERENCE HISTORY (learn from this):"]
    if liked:
        parts.append("Moments the user LIKED:")
        parts += [fmt(e) for e in liked]
    if disliked:
        parts.append("Moments the user DISLIKED (avoid similar):")
        parts += [fmt(e) for e in disliked]
    return "\n".join(parts)


def all_feedback() -> list[dict]:
    return _read(FEEDBACK_FILE)


def all_renders() -> list[dict]:
    return _read(RENDERS_FILE)
