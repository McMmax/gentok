# GenTok — YouTube → TikTok Auto-Clipping Engine

Local web app that turns a YouTube link into vertical (9:16) clip candidates using
the "Most Replayed" heatmap, Whisper transcription, and Claude highlight scoring.

**Stage 1 build** (per `plan.md`): core pipeline + web UI shell, gaming-first layouts.

## Architecture

```
frontend/   Next.js (drop-a-link UI, candidate picker, layout selector)
backend/    FastAPI + pipeline
  app/pipeline/
    ingest.py       yt-dlp download + native heatmap extraction
    transcribe.py   faster-whisper word-level transcription (optional)
    highlights.py   heatmap peaks + Claude scoring + audio-energy fallback
    captions.py     ASS subtitle generation (bold, white + black outline)
    render.py       FFmpeg 9:16 layouts: center_crop, blur_pillarbox,
                    split (facecam top / gameplay bottom), facecam_overlay
    llm.py          Anthropic client wrapper
data/       per-job downloads + rendered clips (gitignored)
```

## Setup

On a new Windows PC, install Git, Python, and Node.js, then run:

```powershell
git clone https://github.com/McMmax/gentok.git
cd gentok
.\setup.ps1
claude  # sign in once, then exit
.\run-dev.ps1
```

The clone starts without local jobs, downloads, renders, or `.env` credentials.
`setup.ps1` creates `.env` from `.env.example` and installs dependencies.

```bash
# LLM via your Claude subscription (no API key needed)
npm install -g @anthropic-ai/claude-code
claude          # login once with your Pro/Max account, then exit

# Backend
cd backend
pip install -r requirements.txt
copy ..\.env.example ..\.env   # LLM_PROVIDER=cli is the default

# Frontend
cd ../frontend
npm install
```

FFmpeg must be on PATH (`winget install ffmpeg` on Windows).

## Run (two terminals)

```bash
# 1. API on :8000
cd backend
uvicorn app.main:app --reload --port 8000

# 2. UI on :3000
cd frontend
npm run dev
```

Open http://localhost:3000, paste a YouTube URL.

## Notes

- Heatmap only exists on videos with roughly 50k+ views; the pipeline falls back
  to audio-energy peaks (and Claude transcript scoring when a key is set).
- Whisper runs on CPU by default (`WHISPER_MODEL=small`); set `WHISPER_DEVICE=cuda`
  if you have CUDA + cuDNN installed. Set `WHISPER_MODEL=off` to skip transcription.
- NVENC: set `VIDEO_ENCODER=h264_nvenc` in `.env` for GPU encoding.
- Stage 2 (Remotion animated captions, pyautoflip reframing) and Stage 3
  (reference-TikTok style cloning) come next per the plan.

## Editor (v2)

Full-page editor: canvas timeline (scroll = zoom, drag = pan, razor/select tools,
frame stepping with , and .), live 9:16 composition preview (exactly what renders),
per-region drag-to-pan / scroll-to-zoom framing (e.g. zoom the chat/facecam grab),
like/dislike feedback on suggested moments (biases future Claude ranking via
data/feedback.jsonl), "+ Load more moments", project history (jobs persist in data/
and reload on restart), and renders.jsonl logging every render's full parameters
for outcome analysis / fine-tuning.

## Roadmap (from docs/)

- docs/audio-pipeline-research-report.md — RoFormer vocal separation, BandIt v2
  3-stem (speech/music/SFX) for gaming, WhisperX large-v3 + diarization, two-path
  audio rule (never denoise before ASR). Implemented so far: -14 LUFS loudnorm.
- docs/toolset-captions-lingo-engine.md — Montserrat/Anton caption meta (set
  CAPTION_FONT), emphasis palette, lingo engine (living lexicon from reference
  corpus + comments), engagement mechanics. Implemented so far: font config,
  preference feedback loop.
