# GenTok Output-Quality Roadmap

_Last updated: 2026-07-13_

## What just shipped

**New: independent per-segment crop/pan**
- Each segment in a multi-segment clip can now be cropped/panned independently. Previously every segment in a clip shared one crop region -- now selecting a segment and dragging on the 9:16 preview gives *that segment* its own crop without touching any other segment's framing. Segments you haven't touched keep using the shared crop from the "Regions" panel, so single-segment clips and any clip you don't specifically edit behave exactly as before. A segment with its own override is marked with a "*" in the segment chip list, with a one-click "use shared crop instead" to revert it back to the default.
- Splitting a segment carries its crop override (if it has one) to both halves; removing a segment cleans up its override too, so there's no orphaned state left behind.
- Destination box position/size (e.g. where the facecam PIP sits on screen, or the split-layout divider) is a deliberate exception and stays shared across all segments in a clip -- see "Known v1 approximations" below.

**Bug fix: facecam overlay wasn't filling the full 9:16 frame**
- `facecam_overlay` was rendering the game footage pillarboxed instead of filling the full vertical frame edge-to-edge like `center_crop` does (with just the small facecam box added on top, as intended). Root cause was subtle: FFmpeg's `scale` filter, when the cropped source region's aspect ratio doesn't already exactly match the output frame, doesn't just resize the pixels -- it also writes compensating "pixel aspect ratio" metadata instead of assuming square pixels. The encoded pixels were technically fine, but players that honor that metadata rendered/reported the wrong shape. Fixed with a `setsar=1` (force square pixels) appended to the end of every layout's filter chain. The same latent bug was quietly present in the `split` and `white_pillarbox` layouts too, so all three got fixed, not just facecam overlay.
- Found while live-testing the fixes above: a render request could come back as a generic server error even though the video itself had already rendered and saved successfully. The cause was a bookkeeping step that runs *after* the render finishes (writing one line to an analytics log) that, unlike every other optional side-effect in this pipeline, had no error handling -- a transient hiccup on that single log write was enough to turn an already-successful render into a failed-looking request. Fixed so that step fails silently on error instead (matching the same best-effort pattern used elsewhere, like diarization and voice isolation), and job-state saves were also made atomic (write-then-rename) as a second layer of protection against partial/corrupted save files.

**New: voice isolation / music ducking**
- Two new controls in the render panel: "isolate voice (remove music)" and "duck music under voice", each with a 0-100% strength slider. Both run on Demucs (Meta's open-source voice-separation model) under the hood, scoped to just the segment(s) you're rendering (not the whole source video) so a typical 15-90s clip separates in well under a minute instead of the 10+ minutes a full source video would take, with results cached per exact segment so re-rendering with a different slider value is instant after the first pass.
- Isolate uniformly attenuates everything that isn't voice, at all times. Duck only attenuates it *while you're talking* (using the transcript's word timings, with a short fade so it's not an audible on/off snap), leaving music/SFX at full volume between lines. Both combine into one gain formula, so you can run a constant floor of separation plus extra ducking under speech.
- Important caveat, disclosed directly in the UI: standard voice-separation tools split audio into "voice" vs. "everything else" — they cannot tell music apart from game sound effects, so both isolate and duck will also quiet hit-markers, footsteps, and similar SFX along with the music. There's no clean off-the-shelf way around this; if that trade-off doesn't work for your clips, the "Medium-term" section below has a middle-ground idea.
- Requires the `demucs` Python package (added to `requirements.txt`) plus PyTorch. **Action needed on your end**: re-run `start-backend.bat` to pick up the new dependency — it now installs a CPU-only PyTorch build first (a plain `pip install demucs` pulls a full multi-GB NVIDIA CUDA toolkit as a side dependency even on machines with no GPU, which this avoids). This is a real, first-time download (a few hundred MB), so the first restart will take longer than usual.
- Verified in this environment: the full request/response path (both sliders, both checkboxes, the render call, graceful fallback when Demucs isn't yet installed) end-to-end in your actual running app; the gain-envelope math (attack/release smoothing, isolate+duck combination formula) against synthetic audio; the ffmpeg segment-extraction and re-mux wiring with a stand-in for the Demucs step (the real neural separation itself needs a network path to PyTorch's model host that this sandboxed dev environment doesn't have — worth a live smoke-test on your machine once the backend restarts with the new dependency installed).

**Bug fixes (round 3 — found during live QA on your machine)**
- Clicking a suggested moment's hook-variant chip (the bold quoted text, the most prominent clickable thing on a moment card) did nothing on its *first* click. The handler only loaded the candidate once a variant was already selected, so a first-time click looked exactly like "moments don't do anything" — fixed so any click always loads the moment.
- Related: after seeking the source video programmatically (e.g. from a moment click), some browsers won't paint a new frame until playback separately starts, making a working click look frozen. Moment clicks now start playback immediately so the preview always paints.
- The "Transition" selector and "burn word-synced captions" checkbox were already present and wired correctly in the right panel — if they're not visible, scroll down inside that panel; nothing was actually missing.
- Word-synced captions weren't rendering in the live 9:16 preview at all (they only existed in the final FFmpeg-burned output). The composer canvas now mirrors the same word-chunking/timing logic as the backend and draws live captions on every frame, matching what actually renders.
- New: a transcript panel with per-word timestamps, so a mis-transcribed word/segment can be corrected without touching timing. Corrections save to the same `transcript.json` the renderer reads, so the next render picks them up automatically.
- Caught during the same testing pass: after correcting a word in the transcript panel, it visually ran into the next word with no space (the display relied on Whisper's word tokens carrying their own leading space, which a typed correction doesn't have). Fixed by always rendering an explicit space between words — cosmetic only, the actual burned-in captions were never affected since the renderer already trims/rejoins words itself.

**Bug fixes (round 1)**
- Captions no longer linger through silence. Chunking now splits on any gap >0.6s between words (not just word count), so a caption disappears as soon as the speaker pauses.
- "Preview cuts" no longer freezes. The playhead-jump logic was re-seeking on every timeupdate tick, including mid-seek, which thrashed the decoder. It now waits for the seek to settle and only jumps when actually off-target.
- Suggested moments no longer duplicate. A greedy NMS dedupe (borrowed from object-detection non-max-suppression) drops any candidate that overlaps >35% with a higher-scored one, and the LLM prompt now explicitly forbids returning the same beat twice.

**Bug fixes (round 2 — found during full end-to-end QA)**
- `backend/requirements.txt` had a corrupted line silently swallowing `numpy`, `python-dotenv`, `Pillow`, and `pytesseract` into one broken token — a clean install would fail immediately (this is what caused the `python-multipart`-missing crash on startup; the fix is to re-run `pip install -r backend/requirements.txt` in whatever Python environment runs `uvicorn`).
- Rendering a segment outside the actual video length used to silently return a fabricated "successful" clip instead of an error. Segments are now validated/clamped against real source duration.
- Firing multiple renders on the same job at once could silently overwrite each other's output file (filename only had second-resolution timestamp). Output filenames are now collision-proof.

**New capabilities**
- Real caption fonts bundled (Montserrat, Anton, Bebas Neue, Poppins) instead of relying on system Arial.
- Creative brief panel: while the video downloads/transcribes, you can pick a goal (funny / skill / fails / nostalgia / drama), a vibe, and title ideas. This feeds directly into the highlight-scoring prompt and the auto-generated hook text.
- White pillarbox layout alongside the existing blur pillarbox.
- Ctrl+drag to move or resize any editable region (split, facecam overlay), with snapping to centers/edges of the frame and other boxes.
- Freeform text layers and image layers, fully editable live on the 9:16 preview: drag to move, corner-drag to resize, scroll to change font size, double-click to edit text in place. What you see in the preview is pixel-matched to what FFmpeg burns in.
- Emoji rendered from a bundled Twemoji set rather than the OS emoji font (see caveat below).
- Auto-detected clip boundaries for compilation videos (e.g. Mr3MS-style username-card compilations), via scene-cut detection + optional OCR title-card labeling. Shown as dashed markers on the timeline and used to snap suggested-moment start/ends to real cuts.
- Reference-style bank: paste a TikTok/short URL, and GenTok extracts its cut pacing, a real detected BPM/beat grid, and (if `ANTHROPIC_API_KEY` is set) a vision read of its text pattern, tone, and glow/transition style. Apply it to a job to bias wording and transitions toward that reference.
- **Real beat/BPM detection**: replaced the old energy-peak heuristic with genuine onset-detection + beat-tracking (librosa, with a numpy-only spectral-flux fallback if librosa is ever unavailable). Verified against synthetic 90/120 BPM click tracks at <2.5% error, with confidence gating so a noisy/non-musical clip returns "no confident beat" instead of a fabricated number.
- **Loudness normalization**: every rendered clip is normalized to -14 LUFS integrated / -1 dBTP (TikTok's typical target) via ffmpeg's `loudnorm` filter, applied consistently whether the clip is a single segment or a multi-segment cut/fade/flash sequence. Verified end to end: a -51.8 LUFS source measured at exactly -14.0 LUFS after render.
- **Speaker diarization**: multi-person compilations get a `speaker` label per transcript word/segment, via offline MFCC-based acoustic clustering (no gated model or account needed). An optional `pyannote.audio`-backed path can be enabled via an env var on machines with network/HF access, falling back cleanly if unavailable.
- **Hook/title A/B variants**: the LLM now proposes 2-3 distinct hook/title angles per suggested moment instead of one; pick between them as chips right in the moment list, and whichever you pick seeds the clip's text layer.
- **Transcript editor + live caption preview**: expand "Transcript" in the left panel to see every line with a timestamp; click any word (or a whole line, if word-level timing isn't available) to fix a mis-transcription in place. The 9:16 preview now also burns in live word-synced captions as you scrub, pixel-and-timing-matched to the same chunking rules the final render uses, so what you see while editing is what you get.

## Known v1 approximations (disclosed, not hidden)

- **Emoji**: Apple's emoji glyphs are proprietary and can't be legally bundled. GenTok ships Twemoji (CC-BY) instead — same coverage, different art style.
- **Beat/BPM detection** is genuine DSP (onset detection + beat tracking), not manually verified against real music genres beyond synthetic click tracks — expect it to be more reliable on percussive/EDM-style audio than on rubato or sparse acoustic material.
- **Speaker diarization** clusters by acoustic timbre (MFCCs), not a trained speaker-embedding model — it will do well distinguishing clearly different-sounding voices and may mis-cluster similar-sounding speakers. This is a real, working v1, not a stub, just not pyannote-grade accuracy out of the box.
- **Hook/title variants**: the prompt and parsing are fully implemented and tested against hand-constructed fake LLM responses, but have not yet been exercised against a live Claude call in this environment (no API key/CLI login available during development) — worth a quick live smoke-test on your machine once you render a real job.
- **Reference-style extraction** reads pacing/vision/beat signals and replicates the *pattern* (text placement rhythm, transition type, glow presence, tone of language, tempo) — it does not reverse-engineer exact shader code or frame-perfect timings from the source video.
- **OCR title-card labeling** (naming compilation sub-clips by username) needs the system `tesseract` binary installed; it degrades gracefully to unlabeled boundaries if absent.
- **Vision-based reference analysis** needs `ANTHROPIC_API_KEY` (not available through the `claude` CLI subscription path); without it, reference matching still works for cut pacing, beat, and audio energy, just not text/tone/glow reads.
- **Voice isolation / ducking** can't distinguish game sound effects from music (see above) -- it only separates voice from non-voice. Duck strength also does nothing if a video has no transcript (transcription off/failed); it silently behaves as if set to 0 rather than erroring. The live 9:16 preview's audio is never affected by either control -- you only hear the result in the rendered clip.
- **Per-segment crop** only covers the source crop/pan region. The destination box (where the facecam PIP or split divider sits on screen) is intentionally still shared across every segment in a clip -- if you need the box itself to move between segments, that's not supported yet.

## Next: raising output quality

**Near-term**
1. Live-smoke-test the hook-variant LLM prompt against a real Claude call (the parsing side is verified; the prompt itself hasn't had a live round-trip yet).
2. Wire the diarization speaker labels into the frontend UI (backend data plumbing is done; nothing shows it yet).
3. Extend per-segment independence to box position/size, not just crop/pan (currently the facecam/split box is shared across all segments by design -- see "Known v1 approximations").

**Medium-term**
4. Learn from the like/dislike feedback already being logged (`feedback.py`) — right now it's captured but not fed back into scoring. A simple weighting pass (boost candidates whose reason/hook style resembles liked clips) would close the loop.
5. Multi-reference blending — let a job point at 2+ reference styles and blend their cut pacing / text rhythm rather than a single style.
6. Auto-captions styling presets per layout (e.g. bottom-third for split layout vs. top-third for facecam overlay) instead of one global caption position.
7. Batch export: render all "liked" candidates in one pass instead of one at a time.
8. A middle ground for voice isolation/ducking that preserves game SFX: e.g. a short-duration/transient-energy heuristic layered on top of Demucs's "non-vocal" stem to distinguish percussive hit-marker/footstep-style sounds from sustained music beds, so ducking could target music specifically rather than everything non-vocal.

**Longer-term / exploratory**
9. On-device face/object tracking to auto-follow a subject in `center_crop` layout instead of a fixed crop window (smart auto-reframe).
10. Music-bed suggestion: use the new real beat-detection to time an inserted licensed background track to the clip's own cut rhythm.
11. A lightweight local model fine-tune (or few-shot cache) on this channel's specific highlight patterns, to reduce reliance on per-request LLM calls.
