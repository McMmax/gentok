# LOCKED TOOLSET — Audio Splicing, Transcription, Caption Style & Lingo Engine
### For the YouTube→TikTok clipping engine · RTX 3060 Ti 8GB + Claude/Gemini/GPT subscriptions · as of July 12, 2026

---

## 1. AUDIO SPLICING TOOLSET (final picks)

**Core separation**
- `python-audio-separator` (pip: `audio-separator[gpu]`) — the pipeline wrapper. UVR's entire model zoo, scriptable, auto-downloads checkpoints, keeps model loaded across files.
- Checkpoint A (default, 2-stem): `model_bs_roformer_ep_317_sdr_12.9755.ckpt` — BS-Roformer-Viperx-1297, vocals SDR ~12.9. The community's "just works" pick.
- Checkpoint B (crisp-voice alternative): `mel_band_roformer_kim_ft_unwa.ckpt` — Kim FT by unwa; the AI-voice community's favorite for natural, artifact-free speech.
- Checkpoint C (gaming 3-stem: speech/music/SFX): **BandIt v2** via `ZFTurbo/Music-Source-Separation-Training` (`--model_type bandit_v2`, weights on Zenodo). Keeps game SFX while stripping music. ~9GB VRAM reported → chunk audio into segments or route to MVSEP.com hosted fallback.

**Cleanup chain (PLAYBACK PATH ONLY — never before ASR)**
- `Mel-Roformer-Denoise-Aufr33` — mic hiss / ambient noise on the vocal stem.
- `UVR-DeEcho-DeReverb` (or Sucial de-reverb roformer) — only when reverb detected.
- `aspiration_mel_band_roformer_sdr_18.9845.ckpt` — breath/plosive removal (optional polish).
- **DeepFilterNet3** or `resemble-ai/resemble-enhance` — final bad-mic restoration.
- FFmpeg `loudnorm` → **-14 LUFS** integrated, true peak -1 dBTP (TikTok normalization target); `sidechaincompress` for ducking your music bed under speech.

**Settings memo:** RoFormer `chunk_size` stays at trained default (352800 ≈ 8s — RoPE degrades off-length); raise `num_overlap` 2→4 if chunk-seam artifacts, cap 8; drop batch size first on OOM; no ensembles for speech.

---

## 2. TRANSCRIPTION TOOLSET (final picks)

**Local tier (default — free, private, 3060 Ti)**
- **WhisperX** (`m-bain/whisperX`): faster-whisper **large-v3** backend at **int8** (fits 8GB; ~10GB would be needed at fp16), VAD pre-filter (kills silence hallucinations), **wav2vec2 forced alignment → sub-100ms word timestamps** (mandatory for karaoke captions), pyannote 3.1 diarization (`--diarize --min_speakers 2`). HuggingFace token required for gated pyannote models — bake into setup script.
- **Per-project hotwords**: pass niche vocab (game terms, streamer names) via `initial_prompt`/hotwords. Cheapest accuracy win available.
- **A/B option:** NVIDIA **Parakeet TDT 0.6B v3** (NeMo) — beats Whisper on the Open ASR Leaderboard (6.32% vs 7.44% WER) at ~3,333x realtime with near-zero silence hallucination, but Whisper stays stronger on accented/noisy English and Parakeet needs separate alignment/diarization plumbing. Ship WhisperX default, Parakeet behind a config flag.

**Cloud tier (accuracy ceiling — for hero clips / terrible audio)**
- **ElevenLabs Scribe v2** — current WER leader (~2.3% clean batch per Artificial Analysis), word timestamps + diarization + audio-event tags (laughter/music — feed these to your hype detector) in one JSON. ~$0.40/audio-hr; you're clipping 30-60s segments, so pennies.
- **AssemblyAI** — $0.17/hr budget alternative, diarization to 30 speakers.
- **Groq-hosted Whisper large-v3-turbo** — ~$0.67 per 1,000 minutes at 257x realtime for bulk VOD passes.

**LLM tier (your subscriptions)**
- **Claude (primary)** — transcript repair against the project glossary (names, game jargon), punctuation, caption chunking at natural phrase boundaries, crosstalk reattribution, and all lingo-engine generation (Section 4). Claude never touches audio; it perfects text.
- **Gemini 2.5** — the only one of your three that ingests audio natively (~2h/request). Use as: (a) transcript verifier/second-opinion (the TeachLM pattern: generate candidates, let Gemini pick/repair); (b) "what's happening in this audio" context tagger. Not primary ASR: timestamps are navigation-grade, diarization breaks on crosstalk.
- **GPT** — tertiary fallback / cross-check on lingo generation for variety.

**Routing rule:** music quiet → original audio → WhisperX. Music loud → RoFormer vocal stem → WhisperX. Never denoise/enhance before ASR (documented to degrade every modern ASR model tested). Hallucination tripwires: canned-phrase detector + output-length vs audio-length ratio check.

---

## 3. CAPTION TYPOGRAPHY & COLOR SYSTEM (what the pros run)

**The 2026 meta, per creator-tool data (Blitzcut, millions-of-views dataset + cross-source consensus):**

Fonts (bundle all as licensed/Google Fonts in the renderer):
- **Montserrat Bold/ExtraBold (700-800)** — THE default. Large x-height, reads at mobile size, mimics TikTok's native Classic/Proxima Nova look so clips feel platform-native. Case study: 17s caption-only video, Montserrat Bold white+black outline → 2.3M views.
- **The Bold Font** (free) — the actual "Hormozi look"; **Anton** (Google Fonts) is the closest free mirror. Every major clipper (CapCut, Submagic, OpusClip, Riverside) ships a "Hormozi preset" — it produces consistent ~+15% engagement lift on educational/commentary content.
- **TikTok Sans** — open-sourced by TikTok mid-2025; usable in external editors. The "native-feel" play.
- **Bebas Neue** (condensed all-caps) — high-energy/gaming hooks and title cards, not running captions.
- **Poppins** — softer lifestyle/casual alternative.
- Rules: weight ≥700 always; captions ≈ 12-20% of screen height; one primary font per clip (accent treatment on 1-3 keywords max); never thin weights, scripts, or serifs for running captions.

Colors (the pro palette is small and ruthless):
- Base: **white fill + thick black outline** (or black drop shadow) — works over any footage; the 90% solution.
- Emphasis (Hormozi-style keyword highlights): **yellow #FFE600-ish** (money/energy), **green #00FF88** (positive/win), **red #FF3B3B** (negative/fail/alert). One emphasis color family per project, defined in the reference-style JSON.
- Karaoke active-word: fill-swap to the emphasis color or background-pill behind the current word (word-pop for fast speech, phrase-reveal for slow — per the OpusClip 13.5M-clip retention analysis from our first report).
- Gaming meme tone: white/yellow + occasional red; avoid gradients (readability tax) and avoid neon-on-neon.
- Placement: center or upper-center, clear of TikTok's right-rail icons and bottom UI; never over faces.

**Implementation:** these are all parameters in the Remotion caption component (template-tiktok base). Each Project's reference analysis (vision-LLM pass from report #1) outputs `{font, weight, fill, stroke, emphasis_color, animation, position, casing}` and the renderer consumes it — so "same exact format and font as my niche" is automatic.

---

## 4. THE LINGO ENGINE (trendy language layer)

**Principle: never hardcode slang.** Slang half-life is weeks ("forty-one" rose and died within a season). My knowledge cutoff alone would make baked-in lingo stale. The engine generates language from a **living lexicon** rebuilt from data you feed it.

**Data sources per Project (the "set of data to generate its language from"):**
1. **Reference TikTok captions + on-screen text** — your existing reference setup already downloads these (yt-dlp/TikTok-Api); OCR on-screen text with PaddleOCR.
2. **Top comments on reference videos + your niche's viral posts** — comments are where the real current register lives; scrape top ~50 per reference video. This is the single highest-signal source for "how this audience actually talks."
3. **Creator's own transcript history** (per niche) — keeps voice consistent.
4. **Weekly trend refresh** — automated web search / TikTok Creative Center pull for "trending sounds/phrases <niche>" piped to Claude to diff against the lexicon.

**Lexicon build (Claude job, runs on Project setup + weekly):**
Claude ingests the corpus and emits `lexicon.json`:
- `evergreen` — stable 2+yr terms (no cap, mid, cooked, ate, rent free, locked in, W/L, "and that's on…"). Safe anywhere.
- `current` — the mainstream-accepted layer you described: alive right now, understood by the masses, not yet cringe. (July 2026 examples the research surfaced: "lowkenuinely"/"flowkenuinely" blends, "clanker," "crash out," "chopped," "aura points," "do it for the plot.") This tier is the default voice.
- `volatile` — micro-trend words (the "six-seven"/"forty-one" class). Use ≤1 per video, only if the weekly refresh confirms it's still alive.
- `banned` — actual brainrot that reads as bot/cringe to a mass audience, anything the niche's comments mock, plus brand-safety exclusions. **Flag: the "kirk" word family (incl. "lowkirkenuinely") derives from the Charlie Kirk assassination and functions as taboo/shock slang — real, but a moderation and brand-safety risk for promotional content. Default it to banned; make it a per-project opt-in.**
- Each entry: term, meaning, register (sincere/sarcastic/ironic), example from the corpus, first/last-seen dates.

**Generation prompt contract (per clip):** Claude receives clip transcript + emotional beat map + lexicon + tone target (e.g., "sarcastic-satire, deadpan") + engagement objective, and returns hook text, caption emphasis words, video description, and 3 comment-bait alternates. Constraints baked into the system prompt: only lexicon terms; ≤2 slang terms per caption (sprinkle, don't soak — mass-relatable, not brainrot-dense); sincere-word-used-ironically ("genuinely," "actually," "in shambles") is the sarcasm workhorse; match the reference corpus's casing/emoji/punctuation style.

**Engagement mechanics (discussion + strong emotion, systematized):**
- Every output must pass a self-check: "Would a viewer type a reply?" Claude tags which trigger it used: hot-take framing ("this is genuinely the worst rotation I've ever seen"), side-taking bait ("he's either cooked or he's him, no in-between"), deliberate mild wrongness (the #1 comment-farm technique — misname something obvious), direct address ("tell me you saw it"), or unresolved tension (cut 0.5s before payoff).
- Emotion targeting: pick ONE per clip (disbelief, secondhand embarrassment, hype, righteous anger, awe) and align hook + caption emphasis + cut point to it. Mixed emotions = muted comments.
- Feedback loop (v2): log posted caption/hook + 24h comment count per clip into the Project; Claude periodically mines winners to re-weight the lexicon and hook formulas. This is your compounding moat.

---

## 5. STACK FIT SUMMARY

| Stage | Tool | VRAM | Runs |
|---|---|---|---|
| Separation | audio-separator + RoFormer ckpt | ~4-6GB | local, sequential |
| Gaming 3-stem | BandIt v2 (MSST) | ~9GB (chunk it) | local/MVSEP |
| Playback cleanup | Mel-Ro-Denoise → DeepFilterNet3 | ~2-4GB | local, conditional |
| ASR + align + diarize | WhisperX (large-v3 int8 + pyannote) | ~4-6GB | local, sequential |
| ASR ceiling | ElevenLabs Scribe v2 | — | API, ~$0.40/hr |
| Transcript repair, lingo, captions, hashtags | Claude | — | API (your sub) |
| Audio QA / 2nd-opinion ASR / context tags | Gemini 2.5 | — | API (your sub) |
| Fallback LLM | GPT | — | API (your sub) |
| Caption render | Remotion template-tiktok + style JSON | — | Node render |

One 8GB card handles everything as a sequential stage queue (empty CUDA cache between stages). Process heavy audio only on selected highlight segments, not full VODs.
