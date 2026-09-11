"""Job store with disk persistence (survives restarts) + pipeline runner."""
from __future__ import annotations

import json
import os
import threading
import time
import traceback
import uuid
from pathlib import Path

from .config import DATA_DIR
from .pipeline import audio_separate, captions, diarize, feedback, highlights, ingest, render, scenes, transcribe
from . import refs

JOBS: dict[str, dict] = {}
_lock = threading.Lock()


def _save(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        return
    try:
        job_dir = DATA_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        # Write to a temp file and rename over the real one, rather than writing
        # job.json in place -- a plain write_text() that gets interrupted partway
        # (e.g. a hiccup on a synced/networked folder) leaves a truncated,
        # unparseable job.json on disk, which silently drops that job's whole
        # history (candidates, clips, brief) on the next backend restart, since
        # load_history() can't parse it and just skips it. os.replace() is atomic
        # on both Windows and POSIX, so a reader always sees either the complete
        # old file or the complete new one, never a half-written one.
        tmp = job_dir / f"job.json.tmp{uuid.uuid4().hex[:8]}"
        tmp.write_text(json.dumps(job, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, job_dir / "job.json")
    except OSError:
        pass


def _set(job_id: str, **kw):
    with _lock:
        JOBS[job_id].update(kw)
    _save(job_id)


def load_history():
    for jf in DATA_DIR.glob("*/job.json"):
        try:
            job = json.loads(jf.read_text(encoding="utf-8"))
            if job.get("status") not in ("ready", "error"):
                job["status"] = "error"
                job["error"] = "Interrupted by restart -- resubmit the URL"
            job["video_ready"] = bool(source_path(job["id"]))
            JOBS[job["id"]] = job
        except (json.JSONDecodeError, KeyError, OSError):
            continue


def history_summary() -> list[dict]:
    items = []
    for job in JOBS.values():
        m = job.get("meta") or {}
        items.append({
            "id": job["id"],
            "status": job["status"],
            "created": job.get("created", 0),
            "url": job.get("url"),
            "title": m.get("title"),
            "channel": m.get("channel"),
            "duration": m.get("duration"),
            "thumbnail": m.get("thumbnail"),
            "n_candidates": len(job.get("candidates") or []),
            "n_clips": len(job.get("clips") or []),
            "video_ready": job.get("video_ready", False),
        })
    return sorted(items, key=lambda x: -(x["created"] or 0))


def create_job(url: str) -> dict:
    job_id = uuid.uuid4().hex[:12]
    job = {
        "id": job_id,
        "url": url,
        "created": int(time.time()),
        "status": "queued",
        "progress": 0.0,
        "video_ready": False,
        "meta": None,
        "candidates": None,
        "source": None,
        "clips": [],
        "error": None,
        "loading_more": False,
        "brief": None,
        "style_ref_id": None,
    }
    JOBS[job_id] = job
    _save(job_id)
    threading.Thread(target=_run_pipeline, args=(job_id,), daemon=True).start()
    return job


def _run_pipeline(job_id: str):
    job = JOBS[job_id]
    job_dir = DATA_DIR / job_id
    try:
        _set(job_id, status="downloading")
        meta = ingest.download(job["url"], job_dir,
                               progress_cb=lambda p: _set(job_id, progress=round(p, 3)))
        meta_pub = {k: meta.get(k) for k in
                    ("id", "title", "duration", "channel", "view_count",
                     "thumbnail", "width", "height", "fps", "heatmap")}
        _set(job_id, meta=meta_pub, video_ready=True, progress=1.0)

        wav = ingest.extract_audio(Path(meta["video_path"]), job_dir)

        _set(job_id, status="transcribing")
        # Splice background music/SFX out before transcribing -- best-effort, like every
        # other optional stage in this pipeline. Runs Demucs ONCE on the whole source
        # (see audio_separate.py), not per segment, so a clean vocals-only track is ready
        # in time for both transcription and diarization below. If Demucs isn't installed
        # or separation fails for any reason, transcribe_wav just falls back to the raw
        # mixed audio.wav, exactly as before this feature existed -- never blocks the job.
        transcribe_wav = wav
        try:
            vocals_wav = audio_separate.transcription_audio(Path(meta["video_path"]), job_dir)
            if vocals_wav:
                transcribe_wav = vocals_wav
        except Exception:
            traceback.print_exc()
        transcript = transcribe.transcribe(transcribe_wav, job_dir)

        # Speaker diarization -- optional, best-effort "who's talking when" tagging
        # for multi-person compilations. Mirrors the OCR/vision "degrade to no-op
        # on any failure" pattern used elsewhere (scenes.py, reference.py): if this
        # throws for any reason, we log it and continue with the plain transcript
        # exactly as before -- diarization must never fail the whole job. Reuses the
        # same vocals-only track as transcription, when available, for the same
        # cleaner-signal-in reason.
        if transcript:
            try:
                turns = diarize.diarize(transcribe_wav, transcript, job_dir)
                if turns:
                    transcript = diarize.label_transcript(transcript, turns)
                    (job_dir / "transcript.json").write_text(
                        json.dumps(transcript, indent=2), encoding="utf-8")
            except Exception as e:
                traceback.print_exc()
                (job_dir / "diarize_error.txt").write_text(str(e), encoding="utf-8")

        _set(job_id, status="detecting_cuts")
        boundaries = scenes.find_boundaries(Path(meta["video_path"]), float(meta.get("duration") or 0), job_dir)
        meta_pub["clip_boundaries"] = boundaries
        _set(job_id, meta=meta_pub)

        _set(job_id, status="scoring")
        style = refs.style_for(job.get("style_ref_id")) if job.get("style_ref_id") else None
        result = highlights.find_candidates(meta, transcript, wav, job_dir,
                                            brief=job.get("brief"), style=style, boundaries=boundaries)

        _set(job_id, status="ready", candidates=result["candidates"], source=result["source"])
    except Exception as e:
        traceback.print_exc()
        _set(job_id, status="error", error=str(e))


def _load_disk(job_id: str):
    job_dir = DATA_DIR / job_id
    meta = json.loads((job_dir / "meta.json").read_text(encoding="utf-8"))
    tf = job_dir / "transcript.json"
    transcript = json.loads(tf.read_text(encoding="utf-8")) if tf.exists() else []
    return job_dir, meta, transcript


def source_path(job_id: str) -> Path | None:
    mf = DATA_DIR / job_id / "meta.json"
    if not mf.exists():
        return None
    meta = json.loads(mf.read_text(encoding="utf-8"))
    p = Path(meta["video_path"])
    return p if p.exists() else None


def set_brief(job_id: str, brief: dict) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise ValueError("Job not found")
    _set(job_id, brief=brief)
    return job


def set_style_ref(job_id: str, style_ref_id: str | None) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise ValueError("Job not found")
    _set(job_id, style_ref_id=style_ref_id)
    return job


def get_transcript(job_id: str) -> list[dict]:
    if not JOBS.get(job_id):
        raise ValueError("Job not found")
    tf = DATA_DIR / job_id / "transcript.json"
    if not tf.exists():
        return []
    return json.loads(tf.read_text(encoding="utf-8"))


def update_transcript(job_id: str, segments: list[dict]) -> list[dict]:
    """Persist user-corrected transcript text. The frontend fetches the transcript,
    lets the user fix mis-transcribed word/segment text, then echoes the whole thing
    back here with only the text changed -- timestamps are never edited client-side,
    so caption sync can't drift out from under a correction. Overwrites transcript.json,
    so the next render (which re-reads that file) picks up the correction automatically."""
    if not JOBS.get(job_id):
        raise ValueError("Job not found")
    job_dir = DATA_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    cleaned = []
    for seg in segments:
        words = [{"start": float(w["start"]), "end": float(w["end"]), "word": str(w.get("word", ""))}
                 for w in (seg.get("words") or [])]
        entry = {"start": float(seg["start"]), "end": float(seg["end"]),
                 "text": str(seg.get("text", "")).strip(), "words": words}
        if seg.get("speaker") is not None:
            entry["speaker"] = seg["speaker"]
        cleaned.append(entry)
    (job_dir / "transcript.json").write_text(json.dumps(cleaned, indent=2), encoding="utf-8")
    return cleaned


def save_upload(job_id: str, filename: str, data: bytes) -> str:
    job_dir = DATA_DIR / job_id / "uploads"
    job_dir.mkdir(parents=True, exist_ok=True)
    ext = Path(filename).suffix.lower()
    safe_ext = ext if ext in (".png", ".jpg", ".jpeg", ".webp", ".gif") else ".png"
    name = f"{uuid.uuid4().hex[:10]}{safe_ext}"
    (job_dir / name).write_bytes(data)
    return name


def upload_path(job_id: str, filename: str) -> Path | None:
    p = (DATA_DIR / job_id / "uploads" / filename).resolve()
    base = (DATA_DIR / job_id / "uploads").resolve()
    if not str(p).startswith(str(base)) or not p.exists():
        return None
    return p


def rate_candidate(job_id: str, index: int, rating: int) -> dict:
    job = JOBS.get(job_id)
    if not job or not job.get("candidates"):
        raise ValueError("Job or candidates not found")
    if not (0 <= index < len(job["candidates"])):
        raise IndexError("Bad candidate index")
    cand = job["candidates"][index]
    cand["rating"] = rating
    m = job.get("meta") or {}
    feedback.add_feedback(job_id, m.get("id", ""), m.get("title", ""), cand, rating)
    _save(job_id)
    return cand


def load_more(job_id: str, count: int = 5) -> list[dict]:
    job = JOBS.get(job_id)
    if not job or job["status"] != "ready":
        raise ValueError("Job not ready")
    _set(job_id, loading_more=True)
    try:
        job_dir, meta, transcript = _load_disk(job_id)
        style = refs.style_for(job.get("style_ref_id")) if job.get("style_ref_id") else None
        boundaries = (job.get("meta") or {}).get("clip_boundaries")
        new = highlights.more_candidates(meta, transcript, job_dir / "audio.wav",
                                         job["candidates"], count=count,
                                         brief=job.get("brief"), style=style, boundaries=boundaries)
        with _lock:
            job["candidates"] = job["candidates"] + new
        return new
    finally:
        _set(job_id, loading_more=False)


def render_clip_request(job_id: str, segments: list[dict], layout: str,
                        with_captions: bool = True, regions: dict | None = None,
                        hook: str = "", index: int | None = None,
                        boxes: dict | None = None, text_layers: list[dict] | None = None,
                        image_layers: list[dict] | None = None, transition: str = "cut",
                        font: str = "", music_strength: float = 0.0,
                        vocal_boost: float = 0.0,
                        seg_regions: dict | None = None) -> dict:
    job = JOBS.get(job_id)
    if not job or not job.get("video_ready"):
        raise ValueError("Video not downloaded yet")

    job_dir = DATA_DIR / job_id
    source = source_path(job_id)
    if source is None:
        raise ValueError("Source video missing")

    meta = json.loads((job_dir / "meta.json").read_text(encoding="utf-8"))
    src_dims = (meta.get("width") or 1920, meta.get("height") or 1080)

    # Clamp against the source's actual duration -- without this, a segment entirely
    # or partially past the end of a (possibly stale, e.g. re-fetched-shorter) source
    # silently seeks past EOF: ffmpeg doesn't error on that, it just emits whatever
    # trailing frames exist, so the caller previously got back an HTTP 200 "success"
    # whose returned segments/duration didn't match the actual rendered content at all.
    duration = float(meta.get("duration") or 0) or None
    # Carry each segment's id through filtering/clamping/sorting so a per-segment
    # regions override (seg_regions, keyed by id) stays attached to the right
    # segment even as segments get dropped/reordered below -- a plain sort of
    # (start, end) tuples would lose that association.
    triples = sorted(
        [(float(s["start"]), float(s["end"]), s.get("id")) for s in segments
         if float(s.get("end", 0)) > float(s.get("start", 0))],
        key=lambda t: (t[0], t[1]),
    )
    if duration:
        clamped = []
        for s, e, sid in triples:
            if s >= duration:
                continue  # entirely past the end of the source -- drop it
            clamped.append((max(s, 0.0), min(e, duration), sid))
        triples = [(s, e, sid) for s, e, sid in clamped if e > s]
    if not triples:
        raise ValueError("No valid segments")
    segs = [(s, e) for s, e, _ in triples]
    seg_regions_list = [seg_regions.get(sid) for _, _, sid in triples] if seg_regions else None
    total = sum(e - s for s, e in segs)
    if total > 180:
        raise ValueError("Clip too long (max 180s total)")

    layers = list(text_layers or [])
    if hook and not text_layers:
        layers = [{"text": hook, "x": 0.5, "y": 0.14, "fontSize": 84, "color": "#FFE600",
                   "font": font or "Anton", "glow": False}] + layers

    resolved_images = []
    for im in (image_layers or []):
        fname = im.get("file")
        p = upload_path(job_id, fname) if fname else None
        if p:
            resolved_images.append({**im, "src": str(p)})

    # A short uuid suffix (not just int(time.time())) guarantees each render gets its
    # own output path even when requests race within the same wall-clock second --
    # without it, concurrent renders on one job silently clobber each other's .mp4/.ass
    # on disk while every caller still gets back an HTTP 200 pointing at a URL, so most
    # of the "successful" clips are actually just copies of whichever render finished last.
    render_id = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"

    music_strength = max(0.0, min(1.0, float(music_strength or 0)))
    vocal_boost = max(0.0, min(1.0, float(vocal_boost or 0)))

    ass_path = None
    transcript = None
    if with_captions:
        tf = job_dir / "transcript.json"
        if tf.exists():
            transcript = json.loads(tf.read_text(encoding="utf-8"))
    if with_captions and transcript:
        ass_path = captions.build_ass(
            transcript, segs, job_dir / f"clip_{render_id}.ass", font=font,
        )

    out_name = f"clip_{render_id}_{layout}.mp4"
    out_path = job_dir / out_name
    render.render_clip(source, out_path, segs, layout=layout, regions=regions,
                       seg_regions=seg_regions_list,
                       src_dims=src_dims, ass_path=ass_path, boxes=boxes,
                       text_layers=layers, image_layers=resolved_images,
                       job_dir=job_dir, transition=transition,
                       music_strength=music_strength, vocal_boost=vocal_boost)

    clip = {
        "index": index, "layout": layout, "file": out_name,
        "url": f"/api/jobs/{job_id}/clips/{out_name}",
        "segments": [{"start": s, "end": e} for s, e in segs],
        "regions": regions, "boxes": boxes, "seg_regions": seg_regions, "hook": hook,
        "text_layers": layers, "transition": transition,
        "duration": round(total, 1),
        "captions": ass_path is not None,
        "music_strength": music_strength,
        "vocal_boost": vocal_boost,
        "created": int(time.time()),
    }
    with _lock:
        job["clips"].append(clip)
    _save(job_id)
    # Analytics logging (feeds the like/dislike + render-outcome dataset) --
    # best-effort like every other optional side-effect in this pipeline. The
    # render itself already succeeded and is already on disk at this point;
    # a hiccup writing to renders.jsonl (e.g. a transient I/O error on a
    # synced/networked folder) must never turn a successful render into a
    # request-failing 500 for the user.
    try:
        feedback.log_render({
            "job_id": job_id, "video_id": meta.get("id"), "video_title": meta.get("title"),
            **{k: clip[k] for k in ("layout", "segments", "regions", "hook", "duration", "file", "captions")},
        })
    except OSError:
        traceback.print_exc()
    return clip


def preview_audio_path(job_id: str, start: float, end: float,
                       music_strength: float, vocal_boost: float) -> Path | None:
    """Backs the live "preview in final state" audio: slices+gain-mixes
    [start, end) of this job's source per the current Music/Vocal slider
    values, reusing whatever full-source Demucs separation is already
    cached (or running it now, on first request, if this job predates the
    feature or its ingest-time pass hasn't completed/failed yet). Returns
    None if separation is unavailable -- the frontend falls back to the
    video's native audio in that case, same as everywhere else this
    best-effort pattern is used."""
    job = JOBS.get(job_id)
    if not job or not job.get("video_ready"):
        raise ValueError("Video not downloaded yet")
    source = source_path(job_id)
    if source is None:
        raise ValueError("Source video missing")
    job_dir = DATA_DIR / job_id
    return audio_separate.slice_and_mix(
        source, job_dir, float(start), float(end),
        max(0.0, min(1.0, float(music_strength or 0))),
        max(0.0, min(1.0, float(vocal_boost or 0))),
    )
