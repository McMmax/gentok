"""Voice/music separation via Demucs -- shared by transcription, rendering, and
live preview.

Runs Demucs's 2-stem model (vocals vs "no_vocals" -- everything else: music,
game sound effects, ambient noise all lumped together, since off-the-shelf
separation can tell voice apart from non-voice but can't tell music apart
from sound effects within that non-voice bucket) exactly ONCE per job, on the
whole source video's audio -- not per render, and not just on whatever
segment happens to be rendered. That one pass feeds three consumers:

  - Transcription: Whisper transcribes the vocals-only stem instead of the
    raw mixed audio.wav, since background music bleeding into its input is a
    real, measurable source of transcription errors. Speaker diarization
    reuses the same clean stem for the same reason.
  - Render: every segment in a multi-segment clip slices its own [start, end)
    range out of the cached stems and gain-mixes it per the user's slider
    settings -- no repeated Demucs calls at render time.
  - Live preview: because slicing + gain-mixing a couple seconds out of an
    already-separated wav is just array math (no ML inference), it's cheap
    enough to redo on every slider drag, which is what actually makes an
    accurate "hear it before you render it" preview possible. Re-running full
    Demucs separation per slider tweak would not be.

Two controls, one mix formula, applied per output sample:

    output(t) = vocals(t) * vocal_gain + no_vocals(t) * (1 - music_strength)

- music_strength (0..1): how much background music/SFX to remove. 0 leaves
  the mix untouched; 1 removes it entirely, leaving vocals only.
- vocal_boost (0..1): how much extra gain to put on the vocals on top of
  that, linearly mapped to a 1.0x-2.0x (+0dB to +6dB) multiplier.

Best-effort like every other optional pipeline stage in this codebase
(diarize.py, reference.py, scenes.py): any failure here (Demucs not
installed, ffmpeg hiccup, model download blocked, etc.) degrades to "skip
the effect" -- every caller falls back to the original, unprocessed audio
rather than failing the whole job/render.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

DEMUCS_MODEL = "htdemucs"
VOCAL_BOOST_MAX_GAIN = 2.0  # vocal_boost=1.0 -> +6dB (~2x linear gain) on the vocal stem


def demucs_available() -> bool:
    return shutil.which("demucs") is not None


def _sep_dir(job_dir: Path) -> Path:
    return job_dir / "audio_sep"


def separate_full(source: Path, job_dir: Path) -> tuple[Path, Path] | None:
    """Runs Demucs once on the whole source video's audio and caches the two
    stems at job_dir/audio_sep/{vocals,no_vocals}_full.wav. Safe to call from
    every one of transcription/render/preview -- it's an instant cache hit
    after the first success on a given job. Returns None (never raises) if
    Demucs isn't installed or separation fails for any reason; callers must
    treat that as "feature unavailable, fall back to original audio", not
    as an error."""
    out_dir = _sep_dir(job_dir)
    vocals_p = out_dir / "vocals_full.wav"
    novoc_p = out_dir / "no_vocals_full.wav"
    if vocals_p.exists() and novoc_p.exists():
        return vocals_p, novoc_p
    if not demucs_available():
        return None

    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            full_wav = tdp / "full.wav"
            proc = subprocess.run(
                ["ffmpeg", "-y", "-i", str(source), "-vn", "-ac", "2", "-ar", "44100", str(full_wav)],
                capture_output=True, text=True,
            )
            if proc.returncode != 0 or not full_wav.exists():
                return None

            sep_out = tdp / "sep"
            proc = subprocess.run(
                ["demucs", "--two-stems=vocals", "-n", DEMUCS_MODEL, "-o", str(sep_out), str(full_wav)],
                capture_output=True, text=True,
            )
            if proc.returncode != 0:
                return None

            found_vocals = next(sep_out.rglob("vocals.wav"), None)
            found_novoc = next(sep_out.rglob("no_vocals.wav"), None)
            if not found_vocals or not found_novoc:
                return None
            shutil.copy(found_vocals, vocals_p)
            shutil.copy(found_novoc, novoc_p)
    except OSError:
        return None

    return vocals_p, novoc_p


def transcription_audio(source: Path, job_dir: Path) -> Path | None:
    """Best-effort vocals-only wav for Whisper/diarization to read instead of
    the raw mixed audio.wav. Returns None if separation isn't available --
    callers should fall back to the original mixed audio in that case."""
    sep = separate_full(source, job_dir)
    return sep[0] if sep else None


def _mix(vocals: np.ndarray, novoc: np.ndarray, music_strength: float, vocal_boost: float) -> np.ndarray:
    vocal_gain = 1.0 + max(0.0, min(1.0, vocal_boost)) * (VOCAL_BOOST_MAX_GAIN - 1.0)
    instrumental_gain = 1.0 - max(0.0, min(1.0, music_strength))
    mixed = vocals * vocal_gain + novoc * instrumental_gain
    np.clip(mixed, -1.0, 1.0, out=mixed)
    return mixed


def slice_and_mix(
    source: Path,
    job_dir: Path,
    start: float,
    end: float,
    music_strength: float,
    vocal_boost: float,
) -> Path | None:
    """Slices [start, end) out of the cached full-source vocals/no_vocals
    stems (triggering the one-time separation pass if it hasn't run yet for
    this job) and gain-mixes per music_strength/vocal_boost. Reads only the
    needed slice off disk (soundfile's start/frames), not the whole file, so
    this stays cheap even on a 15+ minute source. Cached per exact
    (start, end, music_strength, vocal_boost) so repeat requests -- e.g. a
    live preview re-fetching the same segment/slider combo -- are instant.
    Returns None if separation is unavailable/fails, or if both controls are
    effectively off; callers fall back to the original, unprocessed audio."""
    music_strength = max(0.0, min(1.0, music_strength))
    vocal_boost = max(0.0, min(1.0, vocal_boost))
    if music_strength <= 0 and vocal_boost <= 0:
        return None
    if end <= start:
        return None

    sep = separate_full(source, job_dir)
    if sep is None:
        return None
    vocals_p, novoc_p = sep

    cache_dir = _sep_dir(job_dir) / "mixes"
    cache_dir.mkdir(parents=True, exist_ok=True)
    mix_path = cache_dir / f"{start:.2f}_{end:.2f}_{music_strength:.2f}_{vocal_boost:.2f}.wav"
    if mix_path.exists():
        return mix_path

    try:
        info = sf.info(str(vocals_p))
        sr = info.samplerate
        start_frame = max(0, int(start * sr))
        n_frames = max(0, int((end - start) * sr))
        if n_frames <= 0:
            return None

        vocals, _ = sf.read(str(vocals_p), start=start_frame, frames=n_frames, dtype="float32", always_2d=True)
        novoc, _ = sf.read(str(novoc_p), start=start_frame, frames=n_frames, dtype="float32", always_2d=True)
        n = min(len(vocals), len(novoc))
        if n <= 0:
            return None
        vocals, novoc = vocals[:n], novoc[:n]

        mixed = _mix(vocals, novoc, music_strength, vocal_boost)
        sf.write(str(mix_path), mixed, sr)
    except OSError:
        return None

    return mix_path


def build_segment_audio(
    source: Path,
    segments: list[tuple[float, float]],
    music_strength: float,
    vocal_boost: float,
    job_dir: Path,
) -> list[Path] | None:
    """Returns one standalone wav per segment (same order as `segments`),
    each already trimmed to [0, end-start) and gain-mixed per
    music_strength/vocal_boost. Returns None if separation isn't available
    or fails for any segment -- callers should fall back to the original,
    unprocessed audio path in that case (never partially apply the effect
    across only some segments of one clip)."""
    if music_strength <= 0 and vocal_boost <= 0:
        return None
    out_paths = []
    for start, end in segments:
        p = slice_and_mix(source, job_dir, start, end, music_strength, vocal_boost)
        if p is None:
            return None
        out_paths.append(p)
    return out_paths
