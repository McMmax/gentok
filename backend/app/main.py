from __future__ import annotations

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import jobs, refs
from .config import BUNDLED_FONTS, DATA_DIR
from .pipeline import feedback
from .pipeline.render import LAYOUT_REGIONS, LAYOUTS, BOX_EDITABLE_LAYOUTS, default_boxes

app = FastAPI(title="GenTok API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

jobs.load_history()
refs.load_all()


class JobRequest(BaseModel):
    url: str


class Segment(BaseModel):
    start: float
    end: float
    id: str | None = None


class TextLayer(BaseModel):
    text: str
    x: float = 0.5
    y: float = 0.14
    fontSize: int = 72
    color: str = "#FFFFFF"
    font: str = "Montserrat"
    glow: bool = False


class ImageLayer(BaseModel):
    file: str
    x: float = 0.5
    y: float = 0.5
    w: float = 0.3
    h: float = 0.3


class RenderRequest(BaseModel):
    segments: list[Segment]
    layout: str = "center_crop"
    captions: bool = True
    hook: str = ""
    font: str = ""
    regions: dict | None = None
    boxes: dict | None = None
    seg_regions: dict | None = None
    text_layers: list[TextLayer] | None = None
    image_layers: list[ImageLayer] | None = None
    transition: str = "cut"
    index: int | None = None
    music_strength: float = 0.0
    vocal_boost: float = 0.0


class FeedbackRequest(BaseModel):
    index: int
    rating: int


class BriefRequest(BaseModel):
    goals: list[str] = []
    vibe: str = ""
    titleIdeas: str = ""


class StyleRefRequest(BaseModel):
    ref_id: str | None = None


class RefRequest(BaseModel):
    url: str


class TranscriptWord(BaseModel):
    start: float
    end: float
    word: str = ""


class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str = ""
    words: list[TranscriptWord] = []
    speaker: str | None = None


class TranscriptRequest(BaseModel):
    segments: list[TranscriptSegment]


@app.get("/api/health")
def health():
    return {"ok": True, "layouts": LAYOUTS,
            "layout_regions": {k: [[key, list(d)] for key, d in v]
                               for k, v in LAYOUT_REGIONS.items()},
            "box_editable_layouts": list(BOX_EDITABLE_LAYOUTS),
            "fonts": list(BUNDLED_FONTS.keys())}


@app.get("/api/history")
def history():
    return jobs.history_summary()


@app.get("/api/analytics")
def analytics():
    return {"feedback": feedback.all_feedback(), "renders": feedback.all_renders()}


@app.post("/api/jobs")
def create_job(req: JobRequest):
    if not req.url.strip():
        raise HTTPException(400, "URL required")
    return jobs.create_job(req.url.strip())


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = jobs.JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@app.post("/api/jobs/{job_id}/brief")
def set_brief(job_id: str, req: BriefRequest):
    try:
        return jobs.set_brief(job_id, req.model_dump())
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.post("/api/jobs/{job_id}/style-ref")
def set_style_ref(job_id: str, req: StyleRefRequest):
    try:
        return jobs.set_style_ref(job_id, req.ref_id)
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.get("/api/jobs/{job_id}/transcript")
def get_transcript(job_id: str):
    if not jobs.JOBS.get(job_id):
        raise HTTPException(404, "Job not found")
    try:
        return jobs.get_transcript(job_id)
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.post("/api/jobs/{job_id}/transcript")
def save_transcript(job_id: str, req: TranscriptRequest):
    try:
        return jobs.update_transcript(job_id, [s.model_dump() for s in req.segments])
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.post("/api/jobs/{job_id}/upload-image")
async def upload_image(job_id: str, file: UploadFile = File(...)):
    if not jobs.JOBS.get(job_id):
        raise HTTPException(404, "Job not found")
    data = await file.read()
    if len(data) > 12 * 1024 * 1024:
        raise HTTPException(400, "Image too large (max 12MB)")
    name = jobs.save_upload(job_id, file.filename or "img.png", data)
    return {"file": name, "url": f"/api/jobs/{job_id}/uploads/{name}"}


@app.get("/api/jobs/{job_id}/uploads/{filename}")
def get_upload(job_id: str, filename: str):
    path = jobs.upload_path(job_id, filename)
    if path is None:
        raise HTTPException(404, "Upload not found")
    return FileResponse(path)


@app.post("/api/jobs/{job_id}/feedback")
def rate(job_id: str, req: FeedbackRequest):
    try:
        return jobs.rate_candidate(job_id, req.index, req.rating)
    except (ValueError, IndexError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/jobs/{job_id}/more")
def more(job_id: str):
    try:
        new = jobs.load_more(job_id)
        return {"added": new, "job": jobs.JOBS[job_id]}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/jobs/{job_id}/source")
def get_source(job_id: str):
    path = jobs.source_path(job_id)
    if path is None:
        raise HTTPException(404, "Source not available yet")
    return FileResponse(path, media_type="video/mp4")


@app.post("/api/jobs/{job_id}/render")
def render_clip(job_id: str, req: RenderRequest):
    if req.layout not in LAYOUTS:
        raise HTTPException(400, f"layout must be one of {LAYOUTS}")
    if req.transition not in ("cut", "fade", "flash"):
        raise HTTPException(400, "transition must be one of cut, fade, flash")
    try:
        return jobs.render_clip_request(
            job_id, [s.model_dump() for s in req.segments], req.layout,
            with_captions=req.captions, regions=req.regions,
            hook=req.hook, index=req.index, boxes=req.boxes,
            text_layers=[t.model_dump() for t in (req.text_layers or [])],
            image_layers=[i.model_dump() for i in (req.image_layers or [])],
            transition=req.transition, font=req.font,
            music_strength=req.music_strength, vocal_boost=req.vocal_boost,
            seg_regions=req.seg_regions,
        )
    except (ValueError, IndexError) as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@app.get("/api/jobs/{job_id}/preview-audio")
def preview_audio(job_id: str, start: float, end: float,
                  music_strength: float = 0.0, vocal_boost: float = 0.0):
    """Backs the editor's "preview in final state" audio -- the frontend points
    a hidden <audio> element's src at this URL (with the current segment's
    start/end and the Music/Vocal slider values as query params) instead of
    relying on the source <video>'s native track, whenever either slider is
    active. Returns 404 if voice separation isn't available for this job
    (Demucs missing, or separation failed) -- the frontend falls back to the
    native audio in that case rather than erroring."""
    try:
        path = jobs.preview_audio_path(job_id, start, end, music_strength, vocal_boost)
    except ValueError as e:
        raise HTTPException(404, str(e))
    if path is None:
        raise HTTPException(404, "Preview audio not available for this job/segment")
    return FileResponse(path, media_type="audio/wav")


@app.get("/api/jobs/{job_id}/clips/{filename}")
def get_clip(job_id: str, filename: str):
    path = (DATA_DIR / job_id / filename).resolve()
    if not str(path).startswith(str(DATA_DIR.resolve())) or not path.exists():
        raise HTTPException(404, "Clip not found")
    return FileResponse(path, media_type="video/mp4", filename=filename)


@app.get("/api/refs")
def list_refs():
    return refs.list_refs()


@app.post("/api/refs")
def add_ref(req: RefRequest):
    if not req.url.strip():
        raise HTTPException(400, "URL required")
    return refs.add_ref(req.url.strip())


@app.get("/api/refs/{ref_id}")
def get_ref(ref_id: str):
    ref = refs.get_ref(ref_id)
    if not ref:
        raise HTTPException(404, "Reference not found")
    return ref


@app.delete("/api/refs/{ref_id}")
def delete_ref(ref_id: str):
    refs.delete_ref(ref_id)
    return {"ok": True}
