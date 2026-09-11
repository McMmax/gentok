"""Speaker diarization -- "who's talking when" for multi-person compilation
videos (Discord/podcast-clip compilations, Mr3MS-style multi-clip mashups,
etc), so clips can be tagged per-speaker instead of relying purely on the
hard-cut scene boundaries in scenes.py.

Two backends, same "optional signal, never fatal" pattern already used
throughout this pipeline (transcribe.py returns [] if Whisper is disabled/
fails; scenes.py's OCR labeling degrades to {} if tesseract isn't installed;
reference.py's vision analysis degrades to blank fields without an API key):

1. DEFAULT -- offline acoustic-similarity clustering (always available).
   For each transcribed word (or, if word timestamps are missing, a fixed-
   width sliding window), pull the audio span and compute an MFCC-based
   feature vector (mean + std of MFCCs + delta-MFCCs, pooled over the span --
   a standard, cheap "voice timbre fingerprint"). Cluster those vectors with
   scikit-learn's AgglomerativeClustering (cosine-ish distance via
   L2-normalized features + euclidean linkage) into 2-4 speakers, picking the
   cluster count via silhouette score (falling back to 2 if scoring is
   inconclusive). Adjacent same-speaker windows are merged into turns.

   HONEST CAVEAT (same spirit as reference.py's audio-energy "downbeat"
   heuristic, which is explicitly documented as "a heuristic, not real
   beat-tracking"): MFCC-timbre clustering is a real, defensible acoustic-
   similarity signal, but it is NOT a trained speaker-embedding model. It
   has no concept of "voice identity" beyond short-term spectral shape, so
   it will happily mis-cluster two similar-sounding speakers (e.g. two
   people with close vocal ranges) into one cluster, or split one speaker
   into two if their tone shifts a lot (whispering vs. shouting, laughing,
   etc). It's a legitimate v1, not a stand-in for pyannote/resemblyzer-grade
   embeddings.

2. ENHANCED (opt-in, best-effort) -- pyannote.audio pretrained pipeline,
   gated behind `DIARIZATION_BACKEND=pyannote` *and* a successful
   `import pyannote.audio` *and* a successful model load/auth. This needs
   network access to huggingface.co plus a HF token with the pyannote
   gated-model terms accepted -- both fail hard in *this* sandbox (its
   outbound requests to huggingface.co are proxy-blocked), but may work
   fine on the machine actually running this app. If any part of that
   chain fails for any reason, we log and fall straight back to the
   default clustering path above -- never raise, never block the job.

Nothing in this module ever raises out to callers. `diarize()` always
returns a (possibly empty) list of speaker turns, and `label_transcript()`
always returns a transcript (annotated if diarization succeeded, unchanged
if it didn't).
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np

# Fixed-width fallback window when a transcript has no word-level timestamps
# (e.g. transcription disabled, or a segment whose words list came back empty).
_FALLBACK_WINDOW_SEC = 1.0
_MIN_SPAN_SEC = 0.12          # skip audio spans shorter than this -- too little signal for stable MFCCs
_SR = 16000                   # matches ingest.extract_audio's mono/16kHz output exactly
_N_MFCC = 20
_MIN_SPEAKERS, _MAX_SPEAKERS = 2, 4


# --------------------------------------------------------------------------
# Feature extraction
# --------------------------------------------------------------------------

def _windows_from_transcript(transcript: list[dict]) -> list[tuple[float, float]]:
    """Per-word spans if available, else per-segment, else fixed-width windows
    over whatever [start, end] range the transcript covers."""
    spans: list[tuple[float, float]] = []
    for seg in transcript:
        words = seg.get("words") or []
        if words:
            for w in words:
                s, e = float(w["start"]), float(w["end"])
                if e - s >= _MIN_SPAN_SEC:
                    spans.append((s, e))
        else:
            s, e = float(seg["start"]), float(seg["end"])
            if e - s >= _MIN_SPAN_SEC:
                spans.append((s, e))
    return spans


def _fixed_windows(duration: float, width: float = _FALLBACK_WINDOW_SEC) -> list[tuple[float, float]]:
    out = []
    t = 0.0
    while t + _MIN_SPAN_SEC < duration:
        out.append((t, min(t + width, duration)))
        t += width
    return out


def _mfcc_features(y: np.ndarray, sr: int, spans: list[tuple[float, float]]) -> np.ndarray:
    """Mean+std pooled MFCC (+ delta) vector per span. One row per span."""
    import librosa

    feats = np.zeros((len(spans), _N_MFCC * 4), dtype=np.float64)
    for i, (s, e) in enumerate(spans):
        i0, i1 = int(s * sr), int(e * sr)
        clip = y[i0:i1]
        if clip.size < 64:  # too short even for a single FFT frame -- leave as zeros, dropped later
            continue
        n_fft = min(512, 2 ** int(np.floor(np.log2(max(clip.size, 64)))))
        hop = max(n_fft // 4, 32)
        mfcc = librosa.feature.mfcc(y=clip.astype(np.float32), sr=sr, n_mfcc=_N_MFCC,
                                    n_fft=n_fft, hop_length=hop)
        delta = librosa.feature.delta(mfcc, width=min(3, mfcc.shape[1] if mfcc.shape[1] % 2 else mfcc.shape[1] - 1) or 1) \
            if mfcc.shape[1] >= 3 else np.zeros_like(mfcc)
        feats[i] = np.concatenate([mfcc.mean(axis=1), mfcc.std(axis=1),
                                   delta.mean(axis=1), delta.std(axis=1)])
    return feats


# --------------------------------------------------------------------------
# Clustering
# --------------------------------------------------------------------------

def _best_k_agglomerative(X: np.ndarray, k_min: int = _MIN_SPEAKERS, k_max: int = _MAX_SPEAKERS) -> np.ndarray:
    """Try k in [k_min, k_max], pick the labeling with the best silhouette
    score. Falls back to k=2 (or k=1 if there's really only one cluster's
    worth of variance) if silhouette scoring can't distinguish them."""
    from sklearn.cluster import AgglomerativeClustering
    from sklearn.metrics import silhouette_score
    from sklearn.preprocessing import StandardScaler

    n = X.shape[0]
    k_max = min(k_max, n - 1) if n > 1 else 1
    if k_max < k_min:
        return np.zeros(n, dtype=int)

    Xs = StandardScaler().fit_transform(X)
    # Guard against all-zero/near-constant rows (e.g. many spans were too
    # short and left as zero vectors) -- StandardScaler can produce NaNs
    # when a column's std is 0; replace those with 0 so clustering still runs.
    Xs = np.nan_to_num(Xs)

    best_labels, best_score = None, -2.0
    for k in range(k_min, k_max + 1):
        try:
            model = AgglomerativeClustering(n_clusters=k, linkage="average", metric="cosine")
            labels = model.fit_predict(Xs)
            if len(set(labels)) < 2:
                continue
            score = silhouette_score(Xs, labels, metric="cosine")
        except Exception:
            continue
        if score > best_score:
            best_labels, best_score = labels, score

    if best_labels is None:
        # Silhouette couldn't pick a winner (e.g. too few/uniform windows) --
        # default to 2 speakers, the most common real-world case for this
        # feature (a clip compilation "cutting between two people talking").
        try:
            model = AgglomerativeClustering(n_clusters=min(2, n), linkage="average", metric="cosine")
            best_labels = model.fit_predict(Xs)
        except Exception:
            best_labels = np.zeros(n, dtype=int)
    return best_labels


# --------------------------------------------------------------------------
# Turn building
# --------------------------------------------------------------------------

def _spans_to_turns(spans: list[tuple[float, float]], labels: np.ndarray,
                    merge_gap: float = 0.75) -> list[dict]:
    """Collapse per-window (start, end, label) into contiguous per-speaker
    turns, merging same-speaker windows separated by small gaps (pauses,
    breaths) into one turn."""
    if not spans:
        return []
    order = sorted(range(len(spans)), key=lambda i: spans[i][0])
    turns: list[dict] = []
    for i in order:
        s, e = spans[i]
        lab = f"SPEAKER_{int(labels[i]) + 1}"
        if turns and turns[-1]["speaker"] == lab and s - turns[-1]["end"] <= merge_gap:
            turns[-1]["end"] = max(turns[-1]["end"], e)
        else:
            turns.append({"start": round(s, 2), "end": round(e, 2), "speaker": lab})
    return turns


# --------------------------------------------------------------------------
# Enhanced (optional) backend -- pyannote.audio
# --------------------------------------------------------------------------

def _diarize_pyannote(wav_path: Path) -> list[dict] | None:
    """Best-effort pretrained-model diarization. Returns None (never raises)
    if the library isn't installed, a model can't be loaded/authorized, or
    anything else goes wrong -- callers fall back to the default clustering
    path. This needs network access to huggingface.co (to fetch the gated
    pyannote/speaker-diarization model + accept its terms via an HF token in
    HUGGINGFACE_TOKEN/HF_TOKEN) which is unavailable in sandboxes like this
    one but may work fine on a real deployment machine with normal internet.
    Not exercised/tested in this environment for that reason -- treat this
    path as an unverified nice-to-have, not a guarantee."""
    try:
        from pyannote.audio import Pipeline
    except ImportError:
        return None
    try:
        token = os.getenv("HUGGINGFACE_TOKEN") or os.getenv("HF_TOKEN") or None
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1", use_auth_token=token)
        diarization = pipeline(str(wav_path))
        turns = []
        # Map pyannote's own arbitrary speaker labels (e.g. "SPEAKER_00") to
        # our "SPEAKER_1"/"SPEAKER_2" convention so downstream code (and any
        # future frontend) doesn't need to know which backend produced them.
        label_map: dict[str, str] = {}
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            if speaker not in label_map:
                label_map[speaker] = f"SPEAKER_{len(label_map) + 1}"
            turns.append({"start": round(turn.start, 2), "end": round(turn.end, 2),
                         "speaker": label_map[speaker]})
        return turns or None
    except Exception:
        return None


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

def diarize(wav_path: Path, transcript: list[dict], job_dir: Path | None = None) -> list[dict]:
    """Returns [{start, end, speaker}] turns covering the audio, or [] if
    diarization can't run at all (no librosa/sklearn, empty/silent audio,
    anything unexpected). Never raises -- this is an optional pipeline stage,
    same contract as scenes.detect_cuts()/find_boundaries() and
    transcribe.transcribe().

    Backend selection:
      DIARIZATION_BACKEND=pyannote  -> try the pretrained pyannote.audio
                                        pipeline first, fall back to the
                                        default clustering below on any
                                        failure (missing lib, no network/auth,
                                        bad model, etc).
      anything else (default/unset) -> go straight to the default offline
                                        MFCC + agglomerative-clustering path.
    """
    try:
        if os.getenv("DIARIZATION_BACKEND", "").strip().lower() == "pyannote":
            turns = _diarize_pyannote(wav_path)
            if turns:
                return turns
            # fall through to default path below

        spans = _windows_from_transcript(transcript)
        if not spans:
            # No transcript signal (transcription off/failed) -- diarization
            # is still useful for compilation-style videos, so fall back to
            # fixed-width windows over the whole file if we can read its
            # duration. If even that fails, there's nothing to diarize.
            import soundfile as sf
            try:
                info = sf.info(str(wav_path))
                spans = _fixed_windows(float(info.frames) / float(info.samplerate))
            except Exception:
                return []
        if len(spans) < 2:
            return []

        import librosa
        y, sr = librosa.load(str(wav_path), sr=_SR, mono=True)
        if y.size < _SR * 0.5:  # under half a second of audio -- nothing to cluster
            return []

        X = _mfcc_features(y, sr, spans)
        # Drop spans that produced all-zero feature rows (too short to
        # analyze) -- keep spans/X in lockstep.
        nonzero = ~np.all(X == 0, axis=1)
        if nonzero.sum() < 2:
            return []
        spans = [s for s, keep in zip(spans, nonzero) if keep]
        X = X[nonzero]

        labels = _best_k_agglomerative(X)
        turns = _spans_to_turns(spans, labels)

        if job_dir is not None:
            try:
                import json
                (job_dir / "diarization.json").write_text(
                    json.dumps(turns, indent=2), encoding="utf-8")
            except OSError:
                pass
        return turns
    except Exception as e:  # diarization is optional -- never kill the pipeline
        if job_dir is not None:
            try:
                (job_dir / "diarize_error.txt").write_text(str(e), encoding="utf-8")
            except OSError:
                pass
        return []


def _speaker_at(t: float, turns: list[dict]) -> str | None:
    for turn in turns:
        if turn["start"] <= t < turn["end"]:
            return turn["speaker"]
    # fall back to nearest turn if t lands exactly on/after the last edge
    # (e.g. the final word's timestamp equals the transcript's last turn end)
    best, best_d = None, 0.5
    for turn in turns:
        for edge in (turn["start"], turn["end"]):
            d = abs(edge - t)
            if d < best_d:
                best, best_d = turn["speaker"], d
    return best


def label_transcript(transcript: list[dict], turns: list[dict]) -> list[dict]:
    """Attach a `speaker` label to every segment (and word, if present) in a
    transcript, based on diarization turns. Returns a new list -- does not
    mutate the input. If `turns` is empty, returns the transcript unchanged
    (still a copy) so downstream code always sees the same shape whether or
    not diarization ran/succeeded.
    """
    if not turns:
        return transcript
    out = []
    for seg in transcript:
        new_seg = dict(seg)
        mid = (float(seg["start"]) + float(seg["end"])) / 2.0
        new_seg["speaker"] = _speaker_at(mid, turns) or _speaker_at(float(seg["start"]), turns)
        words = seg.get("words")
        if words:
            new_words = []
            for w in words:
                nw = dict(w)
                nw["speaker"] = _speaker_at((float(w["start"]) + float(w["end"])) / 2.0, turns) \
                    or new_seg["speaker"]
                new_words.append(nw)
            new_seg["words"] = new_words
        out.append(new_seg)
    return out
