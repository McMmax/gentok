# Audio Engine Research: Music/Vocal Separation + Multi-Speaker Transcription for the YouTube-to-TikTok Clipping Pipeline

## TL;DR

- **Separation winner:** The RoFormer family (BS-RoFormer / Mel-Band RoFormer) is the undisputed community SOTA for artifact-free vocal isolation, accessible through **python-audio-separator** (the scriptable UVR) — perfect for our FastAPI backend. Top checkpoints: `model_bs_roformer_ep_317_sdr_12.9755.ckpt` (BS-Roformer-Viperx-1297) and the Mel-Band RoFormer "Kim FT by unwa" line.
- **Gaming-specific insight (this changes the architecture):** gaming videos aren't music + vocals — they're **speech + music + game SFX**. A 2-stem vocal model dumps gunshots/hitmarkers into "instrumental" along with the music. If you want to strip copyrighted/original music but *keep* game sounds in the clip, you need a **cinematic 3-stem model: BandIt v2** (speech / music / effects), run via ZFTurbo's Music-Source-Separation-Training repo. This is exactly what film-dialogue extractors in the UVR community use. Caveat: reported at ~9GB VRAM, so it's tight on your 3060 Ti — chunk smaller or fall back to MVSEP.com's hosted version.
- **Counterintuitive ASR finding:** a Dec 2025 systematic study ("When De-noising Hurts", arXiv:2512.17562) found speech-enhancement preprocessing **degraded ASR accuracy in all 40 tested model×noise configurations** (Whisper, Parakeet, Gemini included). A second 2026 study (arXiv:2603.04710) replicated this. Modern ASR is already noise-robust. **Architecture rule: two audio paths.** Path A (playback/render): separate → optionally enhance → mix into the clip. Path B (transcription): feed the *original* mixed audio (or at most the raw vocal stem when music is very loud) to ASR — never the denoised/enhanced version.
- **Transcription winner (local, 3060 Ti):** **WhisperX** — faster-whisper large-v3 backend (int8/float16 fits in 8GB), wav2vec2 forced alignment for sub-100ms word timestamps (what your karaoke captions need), pyannote 3.1 diarization, VAD preprocessing that reduces Whisper's hallucinations. **Transcription winner (cloud):** **ElevenLabs Scribe v2** (~$0.40/audio-hr) — currently ~2.3% WER on clean batch audio (Artificial Analysis), word timestamps + diarization + audio-event tags in one JSON. AssemblyAI (~$0.17/hr) is the budget diarization-strong alternative.
- **Your Claude subscription's role:** Claude can't ingest audio, so it slots in as the **transcript post-processor** — fixing gaming jargon, streamer names, punctuation, and formatting caption chunks. Gemini 2.5 *can* ingest audio natively (up to ~2h/request) and does passable one-shot transcript+diarization, but community consensus: timestamps aren't frame-accurate and diarization breaks on heavy crosstalk — use it as a QA/repair layer, not the primary ASR.
- **Overlapping speech is unsolved everywhere.** DIHARD III shows DER >30% on overlap-heavy audio even for SOTA; when two voices share the same time-frequency region, no current model reliably splits them. Mitigations below — but design captions to follow the dominant speaker, which is what every commercial clipper effectively does.

---

## Part 1 — Music/Vocal Separation Stack (ranked for your use case)

### The landscape in 60 seconds
The 2023 Sound Demixing Challenge was won by **BS-RoFormer** (band-split RoPE transformer), and its successor **Mel-Band RoFormer** improved on it by using mel-scale band projections that match human hearing — the community consistently describes RoFormer output as avoiding the "metallic"/"underwater" artifacts of older architectures (Spleeter-era U-Nets, and to a lesser degree MDX-Net and Demucs). MVSEP.com's public leaderboard and the UVR community treat RoFormer checkpoints (viperx, Kim/Jensen, unwa, becruily fine-tunes) as the current top tier. Demucs v4 (htdemucs_ft) is still respected for multi-stem realism but Meta archived the repo; it's no longer the vocal-clarity king. Spleeter is legacy — don't use it.

### Ranked recommendation

**Tier 1 — Primary (2-stem, cleanest voice): Mel-Band/BS RoFormer via python-audio-separator**
- Library: `nomadkaraoke/python-audio-separator` (pip `audio-separator[gpu]`). It's UVR's model zoo as a Python API — auto-downloads checkpoints, batch-processes without model reloads, exposes segment/overlap/batch knobs. This is the piece Claude Code wires into FastAPI in an afternoon.
- Checkpoints to bundle (in priority order):
  1. `model_bs_roformer_ep_317_sdr_12.9755.ckpt` — "BS-Roformer-Viperx-1297", vocals SDR ~12.9. The repo owner's own guidance thread (discussion #133) names it the first thing to try for both vocal and instrumental work.
  2. `mel_band_roformer_kim_ft_unwa.ckpt` / "Kim FT (2/3) by unwa" — community favorite for natural, crisp vocals; the AI-cover-training community (which is fanatical about clean voice stems) defaults to it.
  3. `vocals_mel_band_roformer.ckpt` (Kimberley Jensen) — vocal-focused alternative, SDR ~12.6.
- Why RoFormer for *overlapping voices*: these models separate "all human voice" vs "everything else" — multiple simultaneous speakers all land in the vocal stem together (that's what you want; speaker untangling happens later at the diarization layer, not here). Their advantage over Demucs is precisely the artifact profile: fewer phasey/watery vocals when music is loud under speech.

**Tier 2 — Gaming mode (3-stem: speech / music / SFX): BandIt v2**
- Repo: `kwatcharasupat/bandit-v2` (weights on Zenodo), run through `ZFTurbo/Music-Source-Separation-Training` (`--model_type bandit_v2`). Trained on DnR v3 specifically for cinematic dialogue/music/effects separation.
- This is the "remove the streamer's background Spotify but keep the Valorant gunfire" tool. UVR community members isolating film dialogue use exactly this (UVR discussion #605), often chaining the speech stem into `resemble-ai/resemble-enhance` for the playback path.
- VRAM caveat: users report ~9GB for long-audio inference — over your 8GB. Options: process in shorter chunks, CPU fallback (slow), or use MVSEP.com's hosted BandIt Plus/v2 (free account, queued).

**Tier 3 — Cleanup chain (PLAYBACK PATH ONLY):**
- `Mel-Roformer-Denoise-Aufr33` — strips mic hiss/room noise from the vocal stem.
- `dereverb`/`UVR-DeEcho-DeReverb` models — for echoey rooms; the MSR Challenge 2025 winning system applies de-reverb to the vocal stem *after* separation, which is the correct order.
- `aspiration_mel_band_roformer_sdr_18.9845.ckpt` (Sucial) — removes breath/plosive noise.
- `resemble-ai/resemble-enhance` or **DeepFilterNet3** — final polish/bandwidth extension for old bad mics. DeepFilterNet works notably well on non-music speech.
- **Adobe Podcast Enhance** (free web) is the zero-effort commercial baseline creators actually use for terrible mics — great output but not automatable at scale and it can over-process into the "AI voice" sound; use as a benchmark for your local chain.

### Settings that prevent the "underwater voice" problem
- RoFormer chunking: keep `chunk_size` at the trained default (352800 ≈ 8s) — RoPE degrades on sequences much longer OR shorter than training length (per the model authors on HuggingFace).
- Raise `num_overlap` (2 → 4, up to 8) if you hear seam artifacts between chunks; diminishing returns past 8, linear cost in time (Kim Jensen's model README).
- If OOM on 8GB: lower batch size first, then segment size. UVR/audio-separator's `--mdxc_batch_size` and segment flags are the levers.
- Avoid stacking aggressive models: separation → denoise → de-reverb → enhance, applied blindly, compounds artifacts. Run each stage conditionally (e.g., only de-reverb if an RT60/reverb heuristic or a quick LLM listen flags it). The AI-cover community's hard-won lesson: fully-automated multi-stage cleaning still isn't perfect; keep stages minimal and quality-gate between them.
- Inference speed ballpark on a 3060 Ti-class card: roughly 1–3 minutes per 10 minutes of audio for a single RoFormer pass (estimate — benchmark on your card; ensemble modes multiply this and are overkill for speech).

### Licensing caveats (worth 5 minutes before you ship)
- Many community checkpoints (viperx, Kim, unwa, becruily, Gabox) carry informal or non-commercial terms and are trained on datasets of unclear provenance. Fine for internal/promotional tooling; verify individual model cards if the engine ever becomes a product.
- Demucs's `mdx_extra` weights are non-commercial; htdemucs is MIT-weighted but the repo is archived.
- BandIt v2 weights: check the Zenodo record's license field.

---

## Part 2 — Transcription Stack (multi-voice, bad mics, word-accurate)

### Local option (your 3060 Ti) — recommended default

**WhisperX** (`m-bain/whisperX`) is still the production-grade open pipeline in 2026:
- faster-whisper (CTranslate2) backend: `large-v3` at `float16` needs ~10GB but **`int8` fits comfortably in 8GB**; batching gives ~70x realtime on datacenter cards — expect a 10-min video to transcribe in well under a minute on the 3060 Ti after model load.
- wav2vec2 forced alignment → **sub-100ms word-level timestamps** (Whisper alone drifts by hundreds of ms — unusable for karaoke word-pop captions; this is why WhisperX and not plain Whisper).
- Built-in VAD preprocessing **reduces Whisper's hallucination on silence/noise** — the single biggest Whisper failure mode on gaming audio with long no-speech stretches.
- pyannote 3.1 diarization integrated (`--diarize --min_speakers 2 --max_speakers N`). Gated model: you must accept terms on HuggingFace and pass an HF token — bake this into your setup docs.
- Use `--model large-v3`, not `turbo`, when diarization matters (turbo is English-tuned and weaker on diarization edge cases per community guidance).
- Gaming vocabulary: pass `initial_prompt`/hotwords with your niche's terms (agent names, streamer names, game slang) — cheap accuracy win; then LLM post-pass (below) catches the rest.

**Worth benchmarking as the English speed king: NVIDIA Parakeet TDT 0.6B v3** — 6.32% avg WER vs Whisper large-v3's 7.44% on the Open ASR Leaderboard, ~3,333x realtime, near-zero silence hallucination, 600M params (tiny VRAM), CC-BY-4.0. Two catches for you: (1) community testing suggests Whisper retains the edge on *accented and noisy* English — your "old bad mic" case — and (2) Parakeet needs NeMo + separate alignment/diarization plumbing, whereas WhisperX is one pipeline. Sensible plan: WhisperX as default, Parakeet as a config-flag alternative to A/B on your actual niche footage.

### Cloud option — when local accuracy isn't enough

Ranked for your use case (word timestamps + diarization + noise robustness):
1. **ElevenLabs Scribe v2** — currently the accuracy leader (~2.3% WER on Artificial Analysis clean-batch; consistently beats Whisper large-v3 and Gemini Flash on FLEURS/Common Voice). Returns word-level timestamps, speaker diarization, and audio-event tags ("laughter", "music") in structured JSON — the event tags are genuinely useful for your virality/hype detection. ~$0.40/audio-hour, so a 30-min VOD costs ~$0.20. This is the "1:1 most accurate" button.
2. **AssemblyAI Universal** — $0.17/hr, diarization up to 30 speakers, 2.9% speaker-count error; the budget pick if you're processing bulk VODs.
3. **Gemini 2.5 (your subscription)** — native audio input, up to ~2h per request (64k output tokens, ~8k tokens per 15 min). One-shot "transcribe + diarize + timestamp" works and is dirt cheap, but field reports agree: timestamps are navigation-grade, not frame-accurate, and diarization breaks on heavy crosstalk. Best roles: (a) transcript *verification/repair* — a 2025 Stanford-adjacent pipeline (TeachLM) generates multiple transcript candidates and uses Gemini 2.5 Pro to pick/fix the best, mitigating dropped segments; (b) cheap second-opinion ASR for confidence scoring.
4. **GPT/Whisper API via Groq** — Whisper large-v3-turbo hosted at ~$0.67/1k-min, 257x realtime; cheapest bulk option, same Whisper accuracy profile.
- **Claude** — no audio input; its job is the text layer: fix jargon/names against a per-project glossary (your reference-TikTok setup already builds one), restore punctuation, split into caption-length chunks with natural phrase boundaries, and flag low-confidence lines for review. This pattern (ASR → LLM cleanup) is standard across every serious 2025-26 pipeline surveyed.

### The overlapping-speech reality check
Honest state of the art: **no tool reliably transcribes two people talking simultaneously on one mixed channel.** DIHARD III (hardest diarization benchmark) shows DER >30% on overlap-heavy audio for SOTA models; when voices collide in the same time-frequency region the embeddings merge, and systems either drop a speaker or hallucinate a phantom third. What actually helps, in order of practicality:
1. **Separate music first** — Demucs/RoFormer vocal isolation before diarization measurably improves diarization quality (this is a documented pattern in WhisperX+NeMo pipelines). Music is the biggest confuser; remove it and pyannote's job gets much easier.
2. **Overlap-aware diarization** — pyannote 3.x detects overlapped-speech regions and can assign multiple labels to the same timestamp; you at least *know where* the crosstalk is, so your caption renderer can style it (e.g., show dominant speaker, or both lines stacked).
3. **Accept dominant-speaker captions.** Every commercial clipper (OpusClip, Submagic) effectively captions the loudest/primary voice during crosstalk. For TikTok retention this is correct — viewers can't read two simultaneous caption streams anyway.
4. **LLM disambiguation** — feed Claude the diarized transcript + context; it's surprisingly good at reassigning obviously-misattributed lines ("that's clearly the streamer responding to chat, not the duo partner").
5. If you ever control the recording (your own promotional content): record per-speaker tracks — the only real solution.

### The "denoise before ASR" trap — do not fall in it
Two independent 2025-26 studies found enhancement preprocessing *hurts* modern ASR:
- arXiv:2512.17562 ("When De-noising Hurts"): MetricGAN+ denoising degraded semWER in **all 40** model×condition configurations across Whisper, Parakeet, Gemini Flash 2.0, and a domain model — with catastrophic cases (Gemini exceeding 50% WER post-denoise). Even on clean audio, denoising added a 1.3–3.2% penalty.
- arXiv:2603.04710 replicated the finding with SAM-Audio + Whisper: degradation was *worse* for larger Whisper models.
Why: Whisper trained on 680k hours of noisy web audio — it has internalized noise robustness, and enhancement shifts the signal off the distribution it learned. **Music separation is different from denoising** — removing loud music genuinely helps (music is competing linguistic-adjacent signal, not noise Whisper was trained around), which is why Demucs-preprocessing is a documented win for diarization and for high-music-bed content. So the rule: **separation before ASR = yes when music is loud; denoise/enhance before ASR = no.** Enhancement lives exclusively on the playback path.

---

## Part 3 — The Pipeline (plugs into the engine from our previous report)

```
[yt-dlp audio extract, 44.1kHz WAV]
        │
        ├──► PATH B: TRANSCRIPTION
        │      1. Quick music-loudness heuristic (or heatmap segment only)
        │      2a. Music quiet → feed ORIGINAL audio to WhisperX
        │      2b. Music loud → RoFormer vocal stem → WhisperX
        │      3. WhisperX: faster-whisper large-v3 int8 + VAD
        │         + wav2vec2 alignment + pyannote 3.1 diarization
        │         (alt: ElevenLabs Scribe v2 API when max accuracy needed)
        │      4. Claude post-pass: jargon/name fixes from project glossary,
        │         punctuation, caption chunking, overlap disambiguation
        │      → word-timestamped, speaker-labeled caption JSON
        │
        └──► PATH A: PLAYBACK AUDIO (what the viewer hears)
               1. Gaming mode: BandIt v2 → keep [speech]+[effects], drop [music]
                  Standard mode: RoFormer → keep [vocals]
               2. Conditional cleanup: Mel-Roformer-Denoise → (if reverby)
                  DeEcho-DeReverb → (if bad mic) resemble-enhance/DeepFilterNet3
               3. ffmpeg loudnorm to -14 LUFS (TikTok target)
               4. Mix: cleaned voice + (optional) game SFX + your trending
                  music bed, ducked under speech (sidechain via ffmpeg)
               → final clip audio into the Remotion/FFmpeg render
```

**VRAM budgeting (8GB, sequential — never load two models simultaneously):** RoFormer separation peaks ~4–6GB with default chunks; faster-whisper large-v3 int8 ~3–4GB; pyannote ~2GB. Run stages sequentially with explicit `torch.cuda.empty_cache()` between them — Claude Code should build the worker as a stage queue, not parallel. BandIt v2 is the only tight fit (~9GB reported) — chunk shorter or route to MVSEP.
**Time per 10-min source video (3060 Ti, rough estimates — benchmark):** separation ~1–3 min, transcription+alignment+diarization ~1–2 min, cleanup models ~1–2 min. Total audio stage ≈ 3–7 min. Since your engine clips 15–60s segments, run heavy audio processing **only on the selected highlight segments**, not the full VOD — cuts this to seconds.

---

## Part 4 — What the pro automators actually use (community evidence)

- **The clipping-automation crowd** (n8n templates, OpusClip-alternative repos, faceless-channel toolchains) overwhelmingly runs: yt-dlp → faster-whisper/WhisperX → FFmpeg, with Demucs bolted on only when music interferes. The sophisticated ones are migrating Demucs → RoFormer via audio-separator because it's pip-installable with the same effort.
- **The AI-cover/RVC community** (the most quality-obsessed voice-stem users on the internet) has fully standardized on Mel-Band RoFormer Kim/unwa checkpoints + chained specialty models (denoise, de-reverb, aspiration removal) via audio-separator or MSST-GUI — their workflow writeups are the best free documentation of artifact-free voice extraction that exists.
- **Film/dialogue extractors** in UVR discussions use BandIt v2 (or Moises Pro, ~$150-300, as the paid ceiling) → resemble-enhance — validating the 3-stem approach for your gaming mode.
- **Commercial clippers** (OpusClip/Submagic-class) don't do heavy source separation at all — they transcribe the mixed audio with a Whisper-class model and eat the errors. The fact that music removal + word-aligned captions + per-niche glossary is *not* standard among them is your quality edge, not table stakes.
- **Podcast/agency pros** benchmark against Adobe Podcast Enhance and Auphonic for playback cleanup, then use AssemblyAI or Scribe for transcripts. Riverside-style per-track recording is their crosstalk answer — unavailable to you since you're processing others' VODs.

## Key caveats
1. pyannote models are HF-gated (token required) — first-run setup friction to document.
2. Model licenses: community RoFormer fine-tunes and Demucs mdx_extra have non-commercial/unclear terms; audit if the engine becomes a product.
3. Whisper hallucination is real on silence/music-only stretches — VAD (built into WhisperX/faster-whisper) is mandatory, and add sanity checks (canned-phrase detection, output-length-vs-audio-length ratio) as a hallucination tripwire.
4. Don't ensemble separation models for speech — ensembles are a music-mastering trick; for dialogue they add time and can smear transients.
5. All time/VRAM figures for the 3060 Ti are estimates from community reports on similar cards — build a 5-minute benchmark script as step one so the engine can auto-tune batch/segment sizes to your actual card.

## Primary sources
- python-audio-separator + model guidance: github.com/nomadkaraoke/python-audio-separator (esp. discussion #133)
- UVR dialogue-isolation thread (BandIt + resemble-enhance chain): github.com/Anjok07/ultimatevocalremovergui/discussions/605
- BandIt v2: github.com/kwatcharasupat/bandit-v2 · runner: github.com/ZFTurbo/Music-Source-Separation-Training (issue #41 for the long-audio/9GB workflow)
- MVSEP leaderboard/algorithms: mvsep.com/en/algorithms
- Mel-Band RoFormer settings (chunk/overlap): github.com/KimberleyJensen/Mel-Band-Roformer-Vocal-Model
- AI-cover community preprocessing workflow: blog.yexca.net/en/archives/283
- WhisperX: github.com/m-bain/whisperX
- Denoising-hurts-ASR studies: arxiv.org/abs/2512.17562 · arxiv.org/pdf/2603.04710
- Parakeet vs Whisper: huggingface.co/blog/open-asr-leaderboard · localaimaster.com/blog/parakeet-vs-whisper
- Diarization/overlap reality: vexascribe.com/compare/best-speaker-diarization-tools (DIHARD III framing)
- Scribe benchmarks/pricing: elevenlabs.io/speech-to-text · usefulai.com/models/ai-transcription-models
- Gemini audio transcription patterns: github.com/philschmid/gemini-samples · cloud.google.com/blog/topics/partners/how-partners-unlock-scalable-audio-transcription-with-gemini
- ASR + Demucs diarization pipeline: learnopencv.com/automatic-speech-recognition
