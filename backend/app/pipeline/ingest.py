"""yt-dlp download + Most-Replayed heatmap extraction (no API key needed)."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import yt_dlp

from ..config import MAX_HEIGHT, YTDLP_COOKIES_BROWSER


def download(url: str, job_dir: Path, progress_cb=None) -> dict:
    """Download video + info JSON. Returns dict with paths and metadata."""
    job_dir.mkdir(parents=True, exist_ok=True)
    out_tmpl = str(job_dir / "source.%(ext)s")

    def hook(d):
        if progress_cb and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            if total:
                progress_cb(done / total)

    ydl_opts = {
        "format": f"bestvideo[height<={MAX_HEIGHT}][ext=mp4]+bestaudio[ext=m4a]/best[height<={MAX_HEIGHT}][ext=mp4]/best",
        "outtmpl": out_tmpl,
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
    }
    if YTDLP_COOKIES_BROWSER and YTDLP_COOKIES_BROWSER != "off":
        # Lets yt-dlp read a real, already-logged-in YouTube session straight out of
        # the named browser's own cookie/profile storage on this machine -- needed for
        # age-restricted ("Sign in to confirm your age") and some login-required videos.
        # yt-dlp handles the actual extraction/decryption itself; we never see or store
        # a password or cookie value ourselves.
        ydl_opts["cookiesfrombrowser"] = (YTDLP_COOKIES_BROWSER,)

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError:
        if "cookiesfrombrowser" not in ydl_opts:
            raise
        # Browser-cookie extraction itself can fail independently of the actual video
        # (browser not installed under that name, profile not found, cookie DB briefly
        # locked, etc.) -- retry once without cookies so ordinary videos that don't
        # need auth at all still work even when the cookie path is broken on this
        # machine. If the video genuinely needs auth, this retry just surfaces the
        # same "sign in" error yt-dlp would have given anyway.
        fallback_opts = {k: v for k, v in ydl_opts.items() if k != "cookiesfrombrowser"}
        with yt_dlp.YoutubeDL(fallback_opts) as ydl:
            info = ydl.extract_info(url, download=True)

    video_path = job_dir / "source.mp4"
    if not video_path.exists():
        candidates = list(job_dir.glob("source.*"))
        if not candidates:
            raise RuntimeError("Download produced no file")
        video_path = candidates[0]

    # Native heatmap field: list of {start_time, end_time, value} (value 0-1)
    heatmap = info.get("heatmap") or []

    width, height, fps = probe_dims(video_path)

    meta = {
        "id": info.get("id"),
        "title": info.get("title"),
        "duration": info.get("duration"),
        "channel": info.get("channel"),
        "view_count": info.get("view_count"),
        "thumbnail": info.get("thumbnail"),
        "width": width or info.get("width"),
        "height": height or info.get("height"),
        "fps": fps or info.get("fps") or 30,
        "heatmap": heatmap,
        "video_path": str(video_path),
    }
    (job_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def probe_dims(video_path: Path):
    """(width, height, fps) via ffprobe. (None, None, None) on failure."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height,r_frame_rate", "-of", "csv=p=0", str(video_path)],
            capture_output=True, text=True, check=True,
        ).stdout.strip().split(",")
        w, h = int(out[0]), int(out[1])
        num, den = out[2].split("/")
        fps = round(float(num) / float(den), 3) if float(den) else 30.0
        return w, h, fps
    except Exception:
        return None, None, None


def extract_audio(video_path: Path, job_dir: Path) -> Path:
    """Mono 16 kHz WAV for Whisper + energy analysis."""
    wav = job_dir / "audio.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video_path), "-vn", "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", str(wav)],
        check=True, capture_output=True,
    )
    return wav
