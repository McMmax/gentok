import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env from repo root (works whether cwd is backend/ or repo root)
_here = Path(__file__).resolve()
for candidate in (_here.parents[2] / ".env", _here.parents[1] / ".env"):
    if candidate.exists():
        load_dotenv(candidate)
        break
else:
    load_dotenv()

REPO_ROOT = _here.parents[2]
DATA_DIR = Path(os.getenv("DATA_DIR", REPO_ROOT / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5")
# auto | cli (Claude Code subscription) | api (Anthropic API key) | off
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "auto")

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")

VIDEO_ENCODER = os.getenv("VIDEO_ENCODER", "libx264")
MAX_HEIGHT = int(os.getenv("MAX_HEIGHT", "1080"))

# yt-dlp auth for age-restricted/login-required videos: pulls cookies straight from a
# browser profile already logged into YouTube on this machine (yt-dlp's own
# --cookies-from-browser mechanism -- no separate account/password handling on our end,
# and nothing gets typed into any form here). Defaults to Chrome since that's what most
# people have; set to "edge", "firefox", etc. to match your machine, or "off" to disable
# (e.g. if this ever runs somewhere without a real browser profile available).
YTDLP_COOKIES_BROWSER = os.getenv("YTDLP_COOKIES_BROWSER", "chrome")

# Bundled caption fonts — real OFL-licensed .ttf files vendored in backend/assets/fonts
# (sourced via the @fontsource npm packages, converted to static .ttf). They're passed to
# ffmpeg's subtitles filter via `fontsdir`, so they render correctly with zero OS-level
# font install required. CAPTION_FONT can still be set to any OS-installed font name (e.g.
# Arial) as a fallback — it just won't be guaranteed present the way these four are.
ASSETS_DIR = _here.parents[1] / "assets"
FONTS_DIR = ASSETS_DIR / "fonts"
EMOJI_DIR = ASSETS_DIR / "emoji"

BUNDLED_FONTS = {
    "Montserrat": "Montserrat-ExtraBold.ttf",   # THE 2026 default per caption research
    "Anton": "Anton-Regular.ttf",               # free mirror of "The Bold Font" (Hormozi look)
    "Bebas Neue": "BebasNeue-Regular.ttf",       # condensed, high-energy hooks/titles
    "Poppins": "Poppins-ExtraBold.ttf",          # softer lifestyle/casual alternative
}
CAPTION_FONT = os.getenv("CAPTION_FONT", "Montserrat")

# Normalize clip audio to TikTok target (-14 LUFS integrated, -1 dBTP)
AUDIO_LOUDNORM = os.getenv("AUDIO_LOUDNORM", "1") not in ("0", "false", "off")

# Clip candidate defaults
MIN_CLIP_SEC = 20
MAX_CLIP_SEC = 60
NUM_CANDIDATES = 5

# Non-max-suppression threshold for deduping near-identical suggested moments
# (fraction of the shorter clip's duration that can overlap before we call it a dupe)
DEDUPE_IOU = 0.35

# Compilation-video scene/cut detection
SCENE_CUT_THRESHOLD = 0.35
MIN_SUBCLIP_SEC = 4.0
