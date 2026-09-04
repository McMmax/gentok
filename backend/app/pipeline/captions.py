"""ASS subtitle generation — bold sans-serif, white + black outline, karaoke word pop.

Caption times are remapped onto the OUTPUT timeline across jump-cut segments:
a word at absolute source time t inside segment i appears at
(t - seg_start_i) + sum(durations of segments before i).

Word chunks are split on BOTH a word-count cap AND a silence-gap cap. Splitting
only by count (every N words) lets one caption line span a pause in speech —
e.g. 2 words, a 2s silence, 2 more words — so the on-screen text sits frozen
through the silence. Splitting on gaps too means a caption line only ever
covers a continuously-spoken run of words, and disappears the moment the
speaker stops rather than lingering until the next chunk boundary.

Freeform user-placed text (titles/hooks) live in `textlayers.py` and are
burned in separately via ffmpeg drawtext, not through this ASS file — this
file is only the word-synced karaoke captions.
"""
from __future__ import annotations

from pathlib import Path

from ..config import CAPTION_FONT

HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{FONT},88,&H00FFFFFF,&H0088FF00,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,7,2,2,60,60,560,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

MAX_WORDS_PER_CHUNK = 4
MAX_GAP_SEC = 0.6        # silence longer than this always starts a new caption chunk
LINGER_SEC = 0.12        # tiny hold after the last word so it doesn't blink off mid-breath
MAX_NO_TIMING_SEC = 4.0  # cap for the rare segment with no word-level timestamps at all


def _ts(sec: float) -> str:
    sec = max(sec, 0)
    h = int(sec // 3600)
    m = int(sec % 3600 // 60)
    s = sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _chunk_words(words: list[dict], max_words: int = MAX_WORDS_PER_CHUNK, max_gap: float = MAX_GAP_SEC):
    """Group words for one caption line — split on word-count OR a silence gap."""
    chunk: list[dict] = []
    for w in words:
        if chunk and (w["start"] - chunk[-1]["end"] > max_gap or len(chunk) >= max_words):
            yield chunk
            chunk = []
        chunk.append(w)
    if chunk:
        yield chunk


def build_ass(transcript: list[dict], segments: list[tuple[float, float]],
              out_path: Path, font: str = "") -> Path | None:
    """Karaoke captions for jump-cut segments, times rebased to output timeline."""
    segments = sorted([(float(s), float(e)) for s, e in segments if e > s])
    if not segments:
        return None

    offsets = []
    acc = 0.0
    for s, e in segments:
        offsets.append(acc)
        acc += e - s

    lines = []
    for (seg_s, seg_e), off in zip(segments, offsets):
        def to_out(t: float) -> float:
            return (t - seg_s) + off

        seg_chunks: list[list] = []  # [c_start, c_end, text]
        for seg in transcript:
            if seg["end"] <= seg_s or seg["start"] >= seg_e:
                continue
            words = [w for w in seg.get("words", []) if seg_s <= w["start"] < seg_e]
            if words:
                for chunk in _chunk_words(words):
                    c_start = to_out(chunk[0]["start"])
                    c_end = to_out(min(chunk[-1]["end"], seg_e))
                    parts = []
                    for w in chunk:
                        dur_cs = max(int((w["end"] - w["start"]) * 100), 1)
                        parts.append(f"{{\\k{dur_cs}}}{w['word'].strip().upper()} ")
                    seg_chunks.append([c_start, c_end, "".join(parts).strip()])
            else:
                s0 = to_out(max(seg["start"], seg_s))
                e0 = to_out(min(seg["end"], seg_e))
                e0 = min(e0, s0 + MAX_NO_TIMING_SEC)
                seg_chunks.append([s0, e0, seg["text"].upper()])

        seg_chunks.sort(key=lambda c: c[0])
        seg_end_out = to_out(seg_e)
        for i, c in enumerate(seg_chunks):
            next_start = seg_chunks[i + 1][0] if i + 1 < len(seg_chunks) else seg_end_out
            c[1] = min(c[1] + LINGER_SEC, next_start)
            if c[1] <= c[0]:
                continue
            lines.append(f"Dialogue: 0,{_ts(c[0])},{_ts(c[1])},Cap,,0,0,0,,{c[2]}")

    if not lines:
        return None
    header = HEADER.replace("{FONT}", font or CAPTION_FONT)
    out_path.write_text(header + "\n".join(lines) + "\n", encoding="utf-8")
    return out_path
