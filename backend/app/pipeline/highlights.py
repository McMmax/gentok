"""Clip candidate selection.

Signal priority:
1. yt-dlp native heatmap peaks (Most Replayed)
2. Claude scoring over transcript (biased by heatmap + user like/dislike history
   + the creative brief + reference style + detected compilation cut points)
3. Audio-energy peaks (no heatmap, no LLM/transcript)

more_candidates() finds additional moments excluding already-suggested ranges.

Dedup: the LLM is only told to avoid ranges from a PREVIOUS call (`exclude`).
Nothing stopped it from returning two overlapping/near-duplicate moments in
the SAME batch (e.g. a tight cut and a looser cut of the same beat) -- that's
exactly the "these two clips are the same moment" bug. `_dedupe` runs a
non-max-suppression pass (like object-detection box dedup, applied to time
ranges) over every batch before it goes out, keeping the higher-scoring clip
whenever two candidates overlap too much.
"""
from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np

from ..config import DEDUPE_IOU, MAX_CLIP_SEC, MIN_CLIP_SEC, NUM_CANDIDATES
from . import feedback, llm, scenes


def heatmap_series(heatmap: list[dict], duration: float, step: float = 1.0):
    if not heatmap or not duration:
        return None
    n = int(duration / step) + 1
    arr = np.zeros(n)
    for h in heatmap:
        a = int(h.get("start_time", 0) / step)
        b = int(h.get("end_time", 0) / step)
        arr[a:max(b, a + 1)] = h.get("value", 0.0)
    return arr


def audio_energy_series(wav_path: Path, step: float = 1.0):
    with wave.open(str(wav_path), "rb") as w:
        rate = w.getframerate()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64)
    win = int(rate * step)
    n = len(data) // win
    if n == 0:
        return None
    rms = np.sqrt((data[: n * win].reshape(n, win) ** 2).mean(axis=1))
    peak = rms.max()
    return rms / peak if peak > 0 else rms


def top_windows(series, duration: float, clip_len: int, count: int,
                step: float = 1.0, exclude: list[tuple[float, float]] | None = None):
    n = len(series)
    w = min(int(clip_len / step), n)
    if w < 1:
        return []
    cumsum = np.concatenate([[0], np.cumsum(series)])
    means = (cumsum[w:] - cumsum[:-w]) / w
    taken = np.zeros(n, dtype=bool)
    for a, b in exclude or []:
        taken[int(a / step): int(b / step) + 1] = True
    out = []
    for idx in np.argsort(means)[::-1]:
        if len(out) >= count:
            break
        if taken[idx: idx + w].any():
            continue
        taken[max(0, idx - w // 2): idx + w + w // 2] = True
        start = float(idx * step)
        out.append({
            "start": round(start, 1),
            "end": round(min(start + clip_len, float(duration)), 1),
            "score": round(float(means[idx]), 3),
        })
    return sorted(out, key=lambda c: -c["score"])


def _overlap_ratio(a: tuple[float, float], b: tuple[float, float]) -> float:
    inter = min(a[1], b[1]) - max(a[0], b[0])
    if inter <= 0:
        return 0.0
    shorter = min(a[1] - a[0], b[1] - b[0])
    return inter / shorter if shorter > 0 else 0.0


def dedupe(candidates: list[dict], iou_thresh: float = DEDUPE_IOU) -> list[dict]:
    ordered = sorted(candidates, key=lambda c: -float(c.get("score", 0)))
    kept: list[dict] = []
    for c in ordered:
        rng = (float(c["start"]), float(c["end"]))
        if any(_overlap_ratio(rng, (float(k["start"]), float(k["end"]))) > iou_thresh for k in kept):
            continue
        kept.append(c)
    return sorted(kept, key=lambda c: c["start"])


def _brief_context(brief: dict | None) -> str:
    if not brief:
        return ""
    goals = brief.get("goals") or []
    vibe = (brief.get("vibe") or "").strip()
    titles = (brief.get("titleIdeas") or "").strip()
    if not goals and not vibe and not titles:
        return ""
    parts = ["CREATOR'S BRIEF FOR THIS VIDEO (steer moment choice + hook/title wording to match):"]
    if goals:
        parts.append(f"- Looking for: {', '.join(goals)}")
    if vibe:
        parts.append(f"- Vibe/tone: {vibe}")
    if titles:
        parts.append(f"- Title ideas to draw inspiration from: {titles}")
    return "\n".join(parts)


def _style_context(style: dict | None) -> str:
    if not style:
        return ""
    bits = []
    if style.get("tone"):
        bits.append(f"tone: {style['tone']}")
    if style.get("text_pattern"):
        bits.append(f"caption pattern: {style['text_pattern']}")
    if style.get("lingo"):
        bits.append(f"favor these words/phrases: {', '.join(style['lingo'][:12])}")
    # bpm/beat_confidence come from real beat-tracking (librosa or a numpy DSP
    # fallback -- see pipeline/reference.py); only mention pacing when the
    # detector was actually confident, so a silent/noisy reference clip
    # doesn't inject a made-up tempo into the prompt.
    if style.get("bpm") and (style.get("beat_confidence") or 0) >= 0.4:
        bpm = style["bpm"]
        pace = "fast, high-energy" if bpm >= 130 else "moderate" if bpm >= 95 else "slow, deliberate"
        bits.append(f"soundtrack tempo: ~{bpm:.0f} BPM ({pace} pacing) -- bias cut timing/hook rhythm to match")
    if not bits:
        return ""
    return "REFERENCE STYLE TO MATCH (from a saved reference clip):\n- " + "\n- ".join(bits)


def _boundary_context(boundaries: list[dict] | None) -> str:
    if not boundaries or len(boundaries) < 2:
        return ""
    ranges = "; ".join(f"{b['start']:.0f}-{b['end']:.0f}s" for b in boundaries[:40])
    return (
        "This source looks like a COMPILATION with hard cuts between sub-clips at "
        f"these boundaries: {ranges}. Prefer picking within a single sub-clip and "
        "starting/ending exactly at a boundary rather than mid-sentence."
    )


def _llm_candidates(transcript, heatmap_arr, duration, count=NUM_CANDIDATES,
                    exclude: list[tuple[float, float]] | None = None,
                    brief: dict | None = None, style: dict | None = None,
                    boundaries: list[dict] | None = None):
    seg_lines = []
    for seg in transcript:
        hm = ""
        if heatmap_arr is not None:
            a, b = int(seg["start"]), min(int(seg["end"]) + 1, len(heatmap_arr))
            if b > a:
                hm = f" [replay={heatmap_arr[a:b].mean():.2f}]"
        seg_lines.append(f"{seg['start']:.0f}-{seg['end']:.0f}s{hm}: {seg['text']}")
    text = "\n".join(seg_lines)
    if len(text) > 60000:
        text = text[:60000]

    pref = feedback.preference_context()
    excl = ""
    if exclude:
        ranges = ", ".join(f"{a:.0f}-{b:.0f}s" for a, b in exclude)
        excl = f"\nALREADY SUGGESTED (pick DIFFERENT moments, no overlap): {ranges}"

    extra_ctx = "\n\n".join(c for c in (_brief_context(brief), _style_context(style), _boundary_context(boundaries)) if c)

    prompt = f"""You select viral TikTok clips from gaming/YouTube videos.
Video duration: {duration:.0f}s. Transcript segments below{' include [replay=x] Most-Replayed intensity (0-1); strongly prefer high-replay moments' if heatmap_arr is not None else ''}.{excl}

{pref}

{extra_ctx}

Pick the {count} best self-contained clips of {MIN_CLIP_SEC}-{MAX_CLIP_SEC} seconds. Prioritize: strong hook in first 2 seconds, high-energy or high-replay moments, complete micro-narratives (setup + payoff), quotable lines.
Each of the {count} clips MUST be a DIFFERENT moment -- do not return the same beat twice at slightly different start/end times (e.g. a tight cut and a looser cut of the same line). If two moments would overlap in time, only include the better one.
For each clip, propose 2-3 DISTINCT short punchy hook/title options (different angles/wording -- not near-duplicates of each other) so the creator can pick the one that lands best.

Reply with ONLY a JSON array:
[{{"start": <sec>, "end": <sec>, "score": <0-1>, "hook_variants": ["<overlay hook text, max 8 words>", "<alternate hook, max 8 words>"], "title": "<clip title>", "reason": "<why viral, one sentence>"}}]

TRANSCRIPT:
{text}"""
    result = llm.complete_json(prompt)
    if not isinstance(result, list):
        return None

    def overlaps_excluded(s, e):
        return any(not (e <= a or s >= b) for a, b in (exclude or []))

    out = []
    for c in result:
        try:
            s, e = float(c["start"]), float(c["end"])
            if e - s < 5 or s < 0 or e > duration + 5 or overlaps_excluded(s, e):
                continue
            variants = [str(v)[:80] for v in (c.get("hook_variants") or []) if str(v).strip()][:3]
            if not variants:
                # legacy/degenerate reply shape -- fall back to a single `hook` string if present
                legacy = str(c.get("hook", "")).strip()
                variants = [legacy[:80]] if legacy else []
            out.append({
                "start": round(s, 1), "end": round(min(e, duration), 1),
                "score": round(float(c.get("score", 0.5)), 3),
                "hook": variants[0] if variants else "",
                "hook_variants": variants,
                "title": str(c.get("title", ""))[:120],
                "reason": str(c.get("reason", ""))[:300],
            })
        except (KeyError, TypeError, ValueError):
            continue

    out = dedupe(out)

    if boundaries:
        for c in out:
            snapped_s = scenes.nearest_boundary(c["start"], boundaries)
            snapped_e = scenes.nearest_boundary(c["end"], boundaries)
            if snapped_s is not None and snapped_s < c["end"]:
                c["start"] = round(snapped_s, 1)
            if snapped_e is not None and snapped_e > c["start"]:
                c["end"] = round(snapped_e, 1)

    return out or None


def _clip_len(duration: float) -> int:
    return int(min(45, max(10, duration / 3)))


def _with_hook_shape(candidates: list[dict]) -> list[dict]:
    """No-LLM signal paths don't propose hook text -- make sure every candidate
    still carries `hook`/`hook_variants` keys (empty-but-present) so downstream
    code (frontend included) can treat the shape uniformly regardless of which
    path produced the candidate."""
    for c in candidates:
        c.setdefault("hook", "")
        c.setdefault("hook_variants", [c["hook"]])
    return candidates


def _signal_candidates(meta, wav_path, duration, count, exclude=None):
    cl = _clip_len(duration)
    heatmap_arr = heatmap_series(meta.get("heatmap") or [], duration)
    if heatmap_arr is not None:
        c = top_windows(heatmap_arr, duration, cl, count, exclude=exclude)
        if c:
            return _with_hook_shape(dedupe(c)), "heatmap"
    if wav_path and Path(wav_path).exists():
        energy = audio_energy_series(Path(wav_path))
        if energy is not None:
            c = top_windows(energy, duration, cl, count, exclude=exclude)
            if c:
                return _with_hook_shape(dedupe(c)), "audio-energy"
    return None, None


def find_candidates(meta: dict, transcript: list[dict], wav_path: Path, job_dir: Path,
                    brief: dict | None = None, style: dict | None = None,
                    boundaries: list[dict] | None = None) -> dict:
    duration = float(meta.get("duration") or 0)
    heatmap_arr = heatmap_series(meta.get("heatmap") or [], duration)

    source = None
    candidates = None

    if transcript and llm.available():
        candidates = _llm_candidates(transcript, heatmap_arr, duration, brief=brief,
                                     style=style, boundaries=boundaries)
        if candidates:
            source = "claude" + ("+heatmap" if heatmap_arr is not None else "")

    if candidates is None:
        candidates, source = _signal_candidates(meta, wav_path, duration, NUM_CANDIDATES)

    if not candidates:
        candidates = [
            {"start": round(float(t), 1), "end": round(min(float(t) + 45, duration), 1), "score": 0.0}
            for t in np.linspace(0, max(duration - 45, 1), NUM_CANDIDATES)
        ]
        source = "uniform"

    result = {"source": source, "candidates": candidates}
    (job_dir / "candidates.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def more_candidates(meta: dict, transcript: list[dict], wav_path: Path,
                    existing: list[dict], count: int = 5,
                    brief: dict | None = None, style: dict | None = None,
                    boundaries: list[dict] | None = None) -> list[dict]:
    duration = float(meta.get("duration") or 0)
    exclude = [(float(c["start"]), float(c["end"])) for c in existing]
    heatmap_arr = heatmap_series(meta.get("heatmap") or [], duration)

    if transcript and llm.available():
        c = _llm_candidates(transcript, heatmap_arr, duration, count=count, exclude=exclude,
                                                    brief=brief, style=style, boundaries=boundaries)
        if c:
            return c

    c, _src = _signal_candidates(meta, wav_path, duration, count, exclude=exclude)
    if c:
        return c

    gaps = []
    marks = sorted(exclude) + [(duration, duration)]
    prev = 0.0
    for a, b in marks:
        if a - prev >= 10:
            gaps.append((prev, a))
        prev = max(prev, b)
    out = []
    for a, b in sorted(gaps, key=lambda g: -(g[1] - g[0]))[:count]:
        out.append({
            "start": round(a, 1), "end": round(min(a + _clip_len(duration), b), 1),
            "score": 0.0,
        })
    return out
