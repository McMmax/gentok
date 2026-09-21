"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ---------------- constants & helpers ---------------- */

const LAYOUTS = [
  ["split", "Split (cam/chat top + gameplay)"],
  ["center_crop", "Center crop"],
  ["facecam_overlay", "Facecam overlay"],
  ["blur_pillarbox", "Blur pillarbox"],
  ["white_pillarbox", "White pillarbox"],
];

// dest rects per layout in 1080x1920 output px: key -> [x, y, w, h] (DEFAULTS -- see `boxes` for
// the user-customizable ctrl-drag version of these same rects, stored as output fractions)
const LAYOUT_REGIONS = {
  center_crop: { game: [0, 0, 1080, 1920] },
  blur_pillarbox: {},
  white_pillarbox: {},
  split: { cam: [0, 0, 1080, 640], game: [0, 640, 1080, 1280] },
  facecam_overlay: { game: [0, 0, 1080, 1920], cam: [350, 120, 380, 214] },
};
const BOX_EDITABLE = { split: true, facecam_overlay: true };
const FONTS = ["Montserrat", "Anton", "Bebas Neue", "Poppins"];
const GOAL_OPTIONS = ["Funny moments", "Insane skill moments", "Fail moments", "Nostalgia bait", "Drama / controversy"];
const TRANSITIONS = [["cut", "Hard cut"], ["fade", "Crossfade"], ["flash", "Flash cut"]];
const SNAP_T = 0.015;

const fmt = (s) => {
  if (s == null || isNaN(s)) return "-:--";
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(2).padStart(5, "0")}`;
};
const fmtShort = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const uid = () => Math.random().toString(36).slice(2, 10);

function defaultRegions(layout, vw, vh) {
  const out = {};
  const dests = LAYOUT_REGIONS[layout] || {};
  for (const key of Object.keys(dests)) {
    if (key === "cam") {
      out[key] = { x: 0.0, y: 0.7, w: 0.3, h: 0.3 };
    } else {
      const [, , dw, dh] = dests[key];
      const target = dw / dh;
      const src = vw / vh;
      if (src > target) {
        const w = target / src;
        out[key] = { x: (1 - w) / 2, y: 0, w, h: 1 };
      } else {
        const h = src / target;
        out[key] = { x: 0, y: (1 - h) / 2, w: 1, h };
      }
    }
  }
  return out;
}

// default destination "boxes" (output fractions) -- the ctrl-drag-editable window
// position/size, seeded from the fixed pixel layout above
function defaultBoxes(layout) {
  const out = {};
  const dests = LAYOUT_REGIONS[layout] || {};
  for (const key of Object.keys(dests)) {
    const [x, y, w, h] = dests[key];
    out[key] = { x: x / 1080, y: y / 1920, w: w / 1080, h: h / 1920 };
  }
  return out;
}

// centered sub-rect of region rect matching dest aspect (same math as backend)
function effRect(rect, destW, destH, vw, vh) {
  let rx = rect.x * vw, ry = rect.y * vh;
  let rw = Math.max(rect.w * vw, 16), rh = Math.max(rect.h * vh, 16);
  const target = destW / destH;
  if (rw / rh > target) {
    const nw = rh * target;
    rx += (rw - nw) / 2; rw = nw;
  } else {
    const nh = rw / target;
    ry += (rh - nh) / 2; rh = nh;
  }
  rx = Math.min(Math.max(rx, 0), vw - rw);
  ry = Math.min(Math.max(ry, 0), vh - rh);
  return [rx, ry, rw, rh];
}

// merge custom boxes (output fractions) over the fixed defaults -> px dest rects (1080x1920 space)
function currentDests(layout, boxes) {
  const defaults = LAYOUT_REGIONS[layout] || {};
  const out = {};
  for (const key of Object.keys(defaults)) {
    const b = boxes?.[key];
    out[key] = b ? [b.x * 1080, b.y * 1920, b.w * 1080, b.h * 1920] : defaults[key];
  }
  return out;
}

function snapRect(rect, guidesX, guidesY, t = SNAP_T) {
  const r = { ...rect };
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, right = r.x + r.w, bottom = r.y + r.h;
  const near = (v, list) => list.find((g) => Math.abs(v - g) < t);
  const gcx = near(cx, guidesX);
  if (gcx !== undefined) r.x = gcx - r.w / 2;
  else {
    const gl = near(r.x, guidesX); if (gl !== undefined) r.x = gl;
    const gr = near(right, guidesX); if (gr !== undefined) r.x = gr - r.w;
  }
  const gcy = near(cy, guidesY);
  if (gcy !== undefined) r.y = gcy - r.h / 2;
  else {
    const gt = near(r.y, guidesY); if (gt !== undefined) r.y = gt;
    const gb = near(bottom, guidesY); if (gb !== undefined) r.y = gb - r.h;
  }
  return r;
}

// ---- emoji: split text into (chunk, isEmoji) runs, resolve to bundled Twemoji PNGs ----
// (mirrors backend/app/pipeline/textlayers.py so the live preview matches the burned-in render)
const EMOJI_RE = /(?:[\u{1F1E6}-\u{1F1FF}]{2})|(?:[\u{1F300}-\u{1FAFF}][\u{1F3FB}-\u{1F3FF}]?(?:\u{200D}[\u{1F300}-\u{1FAFF}][\u{1F3FB}-\u{1F3FF}]?)*\u{FE0F}?)|(?:[\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}]\u{FE0F}?)/gu;

function splitRuns(text) {
  const runs = [];
  let last = 0;
  for (const m of text.matchAll(EMOJI_RE)) {
    if (m.index > last) runs.push([text.slice(last, m.index), false]);
    runs.push([m[0], true]);
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push([text.slice(last), false]);
  return runs.length ? runs : [[text, false]];
}
function emojiCodeKey(cluster, stripFE0F) {
  return [...cluster].filter((c) => !(stripFE0F && c === "\u{FE0F}"))
    .map((c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join("-");
}
function hexAlpha(hex, a) {
  const c = (hex || "#ffffff").replace("#", "");
  const r = parseInt(c.slice(0, 2), 16) || 0, g = parseInt(c.slice(2, 4), 16) || 0, b = parseInt(c.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${a})`;
}

// ---- word-synced caption preview: mirrors backend/app/pipeline/captions.py's chunking
// (split on word-count cap OR a silence gap) so the live preview matches what gets burned in.
// Operates directly on SOURCE time (no multi-segment output-timeline rebasing) since the
// composer preview always scrubs the source video directly, one segment at a time.
const CAP_MAX_WORDS = 4;
const CAP_MAX_GAP_SEC = 0.6;
const CAP_LINGER_SEC = 0.12;

function buildCaptionChunks(transcript) {
  const chunks = [];
  for (const seg of transcript || []) {
    const words = seg.words && seg.words.length
      ? seg.words
      : (seg.text ? [{ start: seg.start, end: seg.end, word: seg.text }] : []);
    if (!words.length) continue;
    const segChunks = [];
    let cur = [];
    for (const w of words) {
      if (cur.length && (w.start - cur[cur.length - 1].end > CAP_MAX_GAP_SEC || cur.length >= CAP_MAX_WORDS)) {
        segChunks.push(cur);
        cur = [];
      }
      cur.push(w);
    }
    if (cur.length) segChunks.push(cur);
    for (let i = 0; i < segChunks.length; i++) {
      const c = segChunks[i];
      const start = c[0].start;
      const nextStart = i + 1 < segChunks.length ? segChunks[i + 1][0].start : seg.end;
      const end = Math.min(c[c.length - 1].end + CAP_LINGER_SEC, nextStart);
      if (end > start) {
        const text = c.map((w) => (w.word || "").trim().toUpperCase()).filter(Boolean).join(" ");
        if (text) chunks.push({ start, end, text });
      }
    }
  }
  chunks.sort((a, b) => a.start - b.start);
  return chunks;
}

function activeCaptionText(chunks, t) {
  for (const c of chunks || []) {
    if (t >= c.start && t < c.end) return c.text;
    if (c.start > t) break;
  }
  return null;
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let d = r.statusText;
    try { d = (await r.json()).detail || d; } catch {}
    throw new Error(d);
  }
  return r.json();
}
const post = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/* ---------------- root: landing vs editor ---------------- */

export default function Home() {
  const [job, setJob] = useState(null);
  const [history, setHistory] = useState([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    FONTS.forEach((f) => { try { document.fonts.load(`900 60px "${f}"`); } catch {} });
  }, []);

  const refreshHistory = useCallback(() => {
    api("/api/history").then(setHistory).catch(() => {});
  }, []);
  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  const poll = useCallback((id) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const j = await api(`/api/jobs/${id}`);
        setJob(j);
        if (j.status === "ready" || j.status === "error") clearInterval(pollRef.current);
      } catch {}
    }, 2000);
  }, []);
  useEffect(() => () => clearInterval(pollRef.current), []);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const j = await post("/api/jobs", { url });
      setJob(j);
      poll(j.id);
    } catch (e) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  };

  const openJob = async (id) => {
    try {
      const j = await api(`/api/jobs/${id}`);
      setJob(j);
      if (!["ready", "error"].includes(j.status)) poll(j.id);
    } catch (e) { setErr(String(e.message || e)); }
  };

  const close = () => {
    clearInterval(pollRef.current);
    setJob(null);
    refreshHistory();
  };

  if (job) return <Editor job={job} setJob={setJob} onBack={close} />;

  return (
    <div className="landing">
      <div className="landing-inner">
        <h1>Gen<span>Tok</span></h1>
        <p className="tagline">Drop a YouTube link -&gt; find the moments -&gt; chop, frame &amp; render 9:16.</p>
        <div className="urlbar">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && url && !busy && submit()}
            placeholder="https://www.youtube.com/watch?v=..."
          />
          <button onClick={submit} disabled={!url || busy}>{busy ? "..." : "Clip it"}</button>
        </div>
        {err && <p className="error" style={{ marginTop: 12 }}>{err}</p>}

        {history.length > 0 && (
          <>
            <h2 className="hist-title">History</h2>
            <div className="hist-grid">
              {history.map((h) => (
                <div className="hist-card" key={h.id} onClick={() => openJob(h.id)}>
                  {h.thumbnail ? <img src={h.thumbnail} alt="" /> : <div style={{ aspectRatio: "16/9", background: "#000" }} />}
                  <div className="hc-body">
                    <div className="hc-title">{h.title || h.url}</div>
                    <div className="hc-sub">
                      <span>{h.channel || "?"}</span>
                      <span>{h.n_candidates} moments</span>
                      <span>{h.n_clips} clips</span>
                      {h.status !== "ready" && <span className="error">{h.status}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- creative brief (asked while the video processes) ---------------- */

function BriefPanel({ brief, setBrief, onSave, saving, open, setOpen, working }) {
  const toggleGoal = (g) => setBrief((b) => ({
    ...b, goals: b.goals.includes(g) ? b.goals.filter((x) => x !== g) : [...b.goals, g],
  }));

  if (!open) {
    const summary = brief.goals.join(", ") || brief.vibe || "Not set";
    return (
      <div className="briefsummary" onClick={() => setOpen(true)}>
        <span className="muted">Brief:</span> <span>{summary}</span> <span className="muted">(edit)</span>
      </div>
    );
  }

  return (
    <div className="briefpanel">
      {working && (
        <div className="hint">
          While the video downloads/transcribes: what are we making? This steers Claude's moment picks and hook wording.
        </div>
      )}
      <label>Goal (pick any)</label>
      <div className="regionbtns">
        {GOAL_OPTIONS.map((g) => (
          <span key={g} className={`chip ${brief.goals.includes(g) ? "sel" : ""}`} onClick={() => toggleGoal(g)}>{g}</span>
        ))}
      </div>
      <label>Vibe</label>
      <input type="text" value={brief.vibe} onChange={(e) => setBrief((b) => ({ ...b, vibe: e.target.value }))}
             placeholder="chaotic high energy, wholesome, petty drama..." />
      <label>Title ideas</label>
      <textarea rows={3} value={brief.titleIdeas} onChange={(e) => setBrief((b) => ({ ...b, titleIdeas: e.target.value }))}
                placeholder={"one per line..."} />
      <div className="row">
        <button className="sec" onClick={onSave} disabled={saving}>{saving ? "Saving..." : "Save brief"}</button>
        {!working && <button className="sec" onClick={() => setOpen(false)}>Collapse</button>}
      </div>
    </div>
  );
}

/* ---------------- transcript editor (timestamps + click-a-word-to-fix-it) ---------------- */

function TranscriptPanel({ jobId, transcript, setTranscript, open, setOpen, loading }) {
  const [editingKey, setEditingKey] = useState(null); // "w:segIdx:wordIdx" | "s:segIdx"
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState(null);

  const commitWord = (si, wi) => {
    setTranscript((prev) => {
      const next = prev.map((s, i) => (i === si ? { ...s, words: s.words.map((w) => ({ ...w })) } : s));
      next[si].words[wi] = { ...next[si].words[wi], word: draft };
      next[si].text = next[si].words.map((w) => (w.word || "").trim()).filter(Boolean).join(" ");
      return next;
    });
    setEditingKey(null);
    setDirty(true);
  };
  const commitSeg = (si) => {
    setTranscript((prev) => prev.map((s, i) => (i === si ? { ...s, text: draft } : s)));
    setEditingKey(null);
    setDirty(true);
  };

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      await post(`/api/jobs/${jobId}/transcript`, { segments: transcript });
      setDirty(false);
    } catch (e) { setErr(String(e.message || e)); }
    finally { setSaving(false); }
  };

  if (!open) {
    const label = loading ? "loading..." : transcript.length ? `${transcript.length} lines` : "none yet";
    return (
      <div className="briefsummary" onClick={() => setOpen(true)}>
        <span className="muted">Transcript:</span> <span>{label}</span> <span className="muted">(open to correct)</span>
      </div>
    );
  }

  return (
    <div className="transcriptpanel">
      <div className="hint">Click any word to fix a mis-transcription -- timestamps stay put, only the text changes.</div>
      {loading && <div className="hint">Loading transcript...</div>}
      {!loading && !transcript.length && <div className="hint">No transcript for this video (still processing, or transcription is disabled).</div>}
      <div className="transcript-scroll">
        {transcript.map((seg, si) => {
          const hasWords = seg.words && seg.words.length > 0;
          return (
            <div className="tseg" key={si}>
              <span className="tseg-time">{fmt(seg.start)}</span>
              {hasWords ? (
                <span className="tseg-words">
                  {seg.words.map((w, wi) => (
                    editingKey === `w:${si}:${wi}` ? (
                      <input
                        key={wi} autoFocus className="tword-edit" value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commitWord(si, wi)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); commitWord(si, wi); }
                          if (e.key === "Escape") setEditingKey(null);
                        }}
                      />
                    ) : (
                      <span key={wi} className="tword" title={`${fmt(w.start)} - ${fmt(w.end)}`}
                            onClick={() => { setEditingKey(`w:${si}:${wi}`); setDraft(w.word.trim()); }}>
                        {w.word.trim()}{" "}
                      </span>
                    )
                  ))}
                </span>
              ) : editingKey === `s:${si}` ? (
                <input
                  autoFocus className="tword-edit" style={{ flex: 1 }} value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitSeg(si)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commitSeg(si); }
                    if (e.key === "Escape") setEditingKey(null);
                  }}
                />
              ) : (
                <span className="tseg-text" onClick={() => { setEditingKey(`s:${si}`); setDraft(seg.text); }}>
                  {seg.text}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="row">
        <button className="sec" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving..." : dirty ? "Save corrections" : "Saved"}
        </button>
        <button className="sec" onClick={() => setOpen(false)}>Collapse</button>
      </div>
      {err && <div className="hint error">{err}</div>}
    </div>
  );
}

/* ---------------- editor ---------------- */

function Editor({ job, setJob, onBack }) {
  const videoRef = useRef(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [vdims, setVdims] = useState([1920, 1080]);
  const [segments, setSegments] = useState([]);
  const [selSeg, setSelSeg] = useState(0);
  const [activeCand, setActiveCand] = useState(null);
  const [hookVariantSel, setHookVariantSel] = useState({}); // candidate index -> chosen hook_variants index
  const [tool, setTool] = useState("select"); // select | razor
  const [layout, setLayout] = useState("split");
  const [regions, setRegions] = useState(null);
  const [boxes, setBoxes] = useState(null);
  // Per-segment crop/pan override: { [segment.id]: regionsObj }. A segment with
  // no entry here just uses the shared `regions` above (today's exact behavior) --
  // this only kicks in once a segment is selected and its crop is dragged, so
  // single-segment clips (the common case) never touch this at all. `boxes`
  // (where a region's window sits/how big it is) deliberately stays shared/global
  // across every segment -- only the source crop/pan is per-segment-overridable.
  const [segRegions, setSegRegions] = useState({});
  const [selRegion, setSelRegion] = useState("game");
  const [font, setFont] = useState("Montserrat");
  const [textLayers, setTextLayers] = useState([]);
  const [imageLayers, setImageLayers] = useState([]);
  const [selLayerId, setSelLayerId] = useState(null);
  const [editingLayerId, setEditingLayerId] = useState(null);
  const [transition, setTransition] = useState("cut");
  const [captions, setCaptions] = useState(true);
  // Music: splices background music/SFX out of the mix (0 = untouched, 1 = fully
  // removed). Vocal: boosts the vocal stem's gain on top of that (0 = untouched,
  // 1 = +6dB). Both 0 by default -- render/preview behave exactly as before this
  // feature existed until a slider is actually moved.
  const [musicStrength, setMusicStrength] = useState(0);
  const [vocalBoost, setVocalBoost] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const fileInputRef = useRef(null);

  const [brief, setBrief] = useState(job.brief || { goals: [], vibe: "", titleIdeas: "" });
  const [briefSaving, setBriefSaving] = useState(false);
  const [briefOpen, setBriefOpen] = useState(true);

  const [refsList, setRefsList] = useState([]);
  const [refUrl, setRefUrl] = useState("");
  const [addingRef, setAddingRef] = useState(false);
  const [styleRefId, setStyleRefId] = useState(job.style_ref_id || null);

  const [transcript, setTranscript] = useState([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  const stateRef = useRef({});
  stateRef.current = { segments, previewing };

  const fps = job.meta?.fps || 30;
  const dur = duration || job.meta?.duration || 0;

  useEffect(() => {
    if (regions === null && vdims[0]) {
      setRegions(defaultRegions(layout, vdims[0], vdims[1]));
      setBoxes(defaultBoxes(layout));
    }
  }, [vdims, layout, regions]);

  const refreshRefs = useCallback(() => { api("/api/refs").then(setRefsList).catch(() => {}); }, []);
  useEffect(() => {
    refreshRefs();
    const t = setInterval(refreshRefs, 4000);
    return () => clearInterval(t);
  }, [refreshRefs]);

  useEffect(() => {
    if (job.status !== "ready") return;
    setTranscriptLoading(true);
    api(`/api/jobs/${job.id}/transcript`)
      .then(setTranscript)
      .catch(() => {})
      .finally(() => setTranscriptLoading(false));
  }, [job.id, job.status]);

  const changeLayout = (l) => {
    setLayout(l);
    setRegions(defaultRegions(l, vdims[0], vdims[1]));
    setBoxes(defaultBoxes(l));
    setSegRegions({}); // per-segment crops don't carry across a layout swap
    const keys = Object.keys(LAYOUT_REGIONS[l] || {});
    setSelRegion(keys.includes("game") ? "game" : keys[0] || null);
  };

  /* Which segment the crop/pan editor is currently targeting -- same segment
     the "Segments" list has selected. Dragging on the 9:16 preview edits THIS
     segment's own crop (forking a per-segment override on first edit) instead
     of the shared one, whenever a segment is selected. */
  const currentSeg = segments[selSeg] || null;
  const effRegions = (currentSeg && segRegions[currentSeg.id]) || regions;
  const setEffRegions = (updater) => {
    if (currentSeg) {
      setSegRegions((prev) => {
        const base = prev[currentSeg.id] || regions;
        const next = typeof updater === "function" ? updater(base) : updater;
        return { ...prev, [currentSeg.id]: next };
      });
    } else {
      setRegions(updater);
    }
  };
  const segHasOverride = currentSeg && !!segRegions[currentSeg.id];
  const clearSegOverride = () => {
    if (!currentSeg) return;
    setSegRegions((prev) => {
      const next = { ...prev };
      delete next[currentSeg.id];
      return next;
    });
  };

  const seek = useCallback((t) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(t, v.duration || t));
    setTime(v.currentTime);
  }, []);

  /* Live "preview in final state" audio: whenever Music or Vocal is turned up, a
     hidden <audio> plays the backend-spliced mix for whichever segment the playhead
     is currently inside, instead of the source <video>'s native track -- so you hear
     what the render will actually sound like before you render it. Outside any
     segment, native audio plays as normal (that footage won't be in the final clip
     anyway). `activeSegStartRef` lets DOM event handlers below always read the
     latest active segment's start without stale-closure issues, the same pattern
     `stateRef` already uses elsewhere in this component. */
  const previewAudioRef = useRef(null);
  const [previewAudioSrc, setPreviewAudioSrc] = useState(null);
  const activeSeg = segments.find((s) => time >= s.start && time < s.end) || null;
  const activeSegStartRef = useRef(0);
  activeSegStartRef.current = activeSeg ? activeSeg.start : 0;

  useEffect(() => {
    if (!activeSeg || (musicStrength <= 0 && vocalBoost <= 0)) {
      setPreviewAudioSrc(null);
      return;
    }
    const { start, end } = activeSeg;
    // Debounced so dragging a slider doesn't fire a request per tick -- only the
    // value it settles on after a brief pause actually gets fetched.
    const t = setTimeout(() => {
      setPreviewAudioSrc(
        `/api/jobs/${job.id}/preview-audio?start=${start}&end=${end}` +
        `&music_strength=${musicStrength.toFixed(2)}&vocal_boost=${vocalBoost.toFixed(2)}`
      );
    }, 300);
    return () => clearTimeout(t);
  }, [activeSeg?.id, activeSeg?.start, activeSeg?.end, musicStrength, vocalBoost, job.id]);

  // Mute the native track the instant a spliced preview is requested/loaded, and
  // restore it the moment there isn't one (sliders back to 0, left the segment, or
  // the fetch 404'd -- see the <audio onError> below, which falls back the same way
  // separation itself does everywhere else: never blocks, just skips the effect).
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.muted = !!previewAudioSrc;
  }, [previewAudioSrc]);

  // Keeps the hidden preview <audio> in lockstep with the main video: same play/pause
  // state, and only re-sought when actually off-target (same thrash-avoidance guard
  // onTimeUpdate below already uses) rather than on every single tick.
  const syncPreviewAudio = () => {
    const v = videoRef.current, a = previewAudioRef.current;
    if (!v || !a || !previewAudioSrc) return;
    const target = Math.max(0, v.currentTime - activeSegStartRef.current);
    if (Math.abs(a.currentTime - target) > 0.15) a.currentTime = target;
    if (v.paused && !a.paused) a.pause();
    else if (!v.paused && a.paused) a.play().catch(() => {});
  };

  /* preview cuts: was re-issuing a seek on every timeupdate tick even mid-seek,
     which thrashes the decoder on long-GOP source video and looks like a freeze.
     Guard on v.seeking + only seek when we're actually not close to the target. */
  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    setTime(v.currentTime);
    syncPreviewAudio();
    const { segments: segs, previewing: pv } = stateRef.current;
    if (!pv || v.paused || !segs.length || v.seeking) return;
    const sorted = [...segs].sort((a, b) => a.start - b.start);
    const t = v.currentTime;
    if (sorted.some((s) => t >= s.start && t < s.end)) return;
    const next = sorted.find((s) => s.start > t);
    if (next) {
      if (Math.abs(v.currentTime - next.start) > 0.05) v.currentTime = next.start;
    } else {
      v.pause(); setPreviewing(false);
    }
  };

  const playPause = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play(); else v.pause();
  };
  const frameStep = (dir) => {
    videoRef.current?.pause();
    seek(time + dir / fps);
  };
  const startPreview = () => {
    if (!segments.length) return;
    const sorted = [...segments].sort((a, b) => a.start - b.start);
    setPreviewing(true);
    stateRef.current.previewing = true;
    const v = videoRef.current;
    v.currentTime = sorted[0].start;
    v.play();
  };

  /* segment ops */
  const loadCandidate = (c, i, variantIdx) => {
    const idx = variantIdx ?? hookVariantSel[i] ?? 0;
    const hookText = (c.hook_variants && c.hook_variants[idx]) || c.hook;
    setSegments([{ id: uid(), start: c.start, end: c.end }]);
    setSegRegions({});
    setSelSeg(0);
    setActiveCand(i);
    setTextLayers(hookText ? [{ id: uid(), text: hookText, x: 0.5, y: 0.14, fontSize: 84, color: "#FFE600", font: "Anton", glow: true }] : []);
    setImageLayers([]);
    seek(c.start);
    // Force an immediate frame paint: some browsers won't decode/paint a frame after a bare
    // currentTime set while paused, so a moment click can look like "nothing happened" (still
    // showing the previous or a black frame) until the user separately presses play. Starting
    // playback here both fixes that and matches the intent of clicking a moment (preview it).
    videoRef.current?.play().catch(() => {});
  };
  const pickHookVariant = (c, i, variantIdx) => {
    setHookVariantSel((prev) => ({ ...prev, [i]: variantIdx }));
    // Always load the candidate, not just when it's already active -- the hook-variant chips are
    // the most prominent clickable text on a moment card, so this is usually a user's FIRST click
    // on that moment, not a follow-up. Gating on activeCand===i meant that first click silently
    // did nothing (looked exactly like "moments don't do anything when I click them").
    loadCandidate(c, i, variantIdx);
  };
  const splitAt = (t) => {
    const i = segments.findIndex((s) => t > s.start + 0.15 && t < s.end - 0.15);
    if (i < 0) return;
    const s = segments[i];
    const idA = uid(), idB = uid();
    const next = [...segments];
    next.splice(i, 1, { id: idA, start: s.start, end: t }, { id: idB, start: t, end: s.end });
    setSegments(next);
    // Splitting a segment shouldn't silently reset its crop -- both halves
    // inherit whatever custom crop the original segment had, if any.
    if (s.id && segRegions[s.id]) {
      setSegRegions((prev) => {
        const { [s.id]: orig, ...rest } = prev;
        return { ...rest, [idA]: orig, [idB]: orig };
      });
    }
    setSelSeg(i + 1);
  };
  const addSegment = () => {
    setSegments([...segments, { id: uid(), start: time, end: Math.min(time + 15, dur) }].sort((a, b) => a.start - b.start));
  };
  const removeSeg = (i) => {
    const removed = segments[i];
    const next = segments.filter((_, j) => j !== i);
    setSegments(next);
    setSelSeg(Math.max(0, Math.min(selSeg, next.length - 1)));
    if (removed?.id) {
      setSegRegions((prev) => {
        if (!(removed.id in prev)) return prev;
        const { [removed.id]: _drop, ...rest } = prev;
        return rest;
      });
    }
  };

  /* keyboard */
  useEffect(() => {
    const onKey = (e) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.code === "Space") { e.preventDefault(); playPause(); }
      else if (e.key === ",") frameStep(-1);
      else if (e.key === ".") frameStep(1);
      else if (e.key === "s") splitAt(videoRef.current?.currentTime ?? time);
      else if (e.key === "Delete" && segments.length) removeSeg(selSeg);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* feedback + more */
  const rate = async (i, rating) => {
    const cand = job.candidates[i];
    const newRating = cand.rating === rating ? 0 : rating;
    try {
      await post(`/api/jobs/${job.id}/feedback`, { index: i, rating: newRating });
      const cands = [...job.candidates];
      cands[i] = { ...cand, rating: newRating };
      setJob({ ...job, candidates: cands });
    } catch {}
  };
  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await post(`/api/jobs/${job.id}/more`, {});
      setJob(r.job);
    } catch {}
    finally { setLoadingMore(false); }
  };

  const saveBrief = async () => {
    setBriefSaving(true);
    try {
      const r = await post(`/api/jobs/${job.id}/brief`, brief);
      setJob((j) => ({ ...j, brief: r.brief }));
      setBriefOpen(false);
    } catch {} finally { setBriefSaving(false); }
  };

  const addRef = async () => {
    if (!refUrl.trim()) return;
    setAddingRef(true);
    try { await post("/api/refs", { url: refUrl.trim() }); setRefUrl(""); refreshRefs(); } catch {}
    finally { setAddingRef(false); }
  };
  const applyStyleRef = async (id) => {
    setStyleRefId(id || null);
    try { await post(`/api/jobs/${job.id}/style-ref`, { ref_id: id || null }); } catch {}
  };

  /* layers */
  const addTextLayer = () => {
    const id = uid();
    setTextLayers((a) => [...a, { id, text: "NEW TEXT", x: 0.5, y: 0.4, fontSize: 70, color: "#FFFFFF", font, glow: false }]);
    setSelLayerId(id);
    setEditingLayerId(id);
  };
  const updateTextLayer = (id, patch) => setTextLayers((a) => a.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const removeTextLayer = (id) => {
    setTextLayers((a) => a.filter((l) => l.id !== id));
    if (selLayerId === id) setSelLayerId(null);
  };
  const removeImageLayer = (id) => {
    setImageLayers((a) => a.filter((l) => l.id !== id));
    if (selLayerId === id) setSelLayerId(null);
  };
  const onPickImage = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    try {
      const r = await fetch(`/api/jobs/${job.id}/upload-image`, { method: "POST", body: form });
      if (!r.ok) return;
      const { file: fname, url } = await r.json();
      const id = uid();
      setImageLayers((a) => [...a, { id, file: fname, previewUrl: url, x: 0.78, y: 0.82, w: 0.18, h: 0.18 }]);
      setSelLayerId(id);
    } catch {}
  };

  const working = ["queued", "downloading", "transcribing", "detecting_cuts", "scoring"].includes(job.status);
  const statusLabel = {
    queued: "Queued...",
    downloading: `Downloading ${Math.round((job.progress || 0) * 100)}%`,
    transcribing: "Transcribing...",
    detecting_cuts: "Detecting cuts...",
    scoring: "Scoring highlights...",
    ready: `ranked by ${job.source || "?"}`,
    error: job.error,
  }[job.status];

  const selTextLayer = textLayers.find((l) => l.id === selLayerId) || null;
  const selImageLayer = imageLayers.find((l) => l.id === selLayerId) || null;
  const selectedRefStyle = refsList.find((r) => r.id === styleRefId)?.style;

  return (
    <div className="app">
      <div className="topbar">
        <button className="sec" onClick={onBack}>&larr; Library</button>
        <span className="title">{job.meta?.title || job.url}</span>
        <span className={`badge ${working ? "working" : ""}`}>
          {working && <span className="spinner" style={{ marginRight: 6 }} />}
          {statusLabel}
        </span>
        <span style={{ flex: 1 }} />
        <span className="badge">{job.meta?.channel}</span>
        <span className="badge">{fmtShort(job.meta?.duration || 0)}</span>
      </div>

      <div className="main">
        {/* left: brief + moments */}
        <div className="pane">
          <div className="pane-h"><span>Creative brief</span></div>
          <div style={{ padding: 12 }}>
            <BriefPanel brief={brief} setBrief={setBrief} onSave={saveBrief} saving={briefSaving}
                       open={briefOpen} setOpen={setBriefOpen} working={working} />
          </div>
          <div className="pane-h">
            <span>Suggested moments</span>
            <span className="muted">{(job.candidates || []).length}</span>
          </div>
          {working && !(job.candidates || []).length && (
            <div className="hint" style={{ padding: 12 }}>
              Moments will show up here once scoring finishes -- fill out the brief above in the meantime.
            </div>
          )}
          {(job.candidates || []).map((c, i) => (
            <div key={i} className={`moment ${activeCand === i ? "active" : ""}`} onClick={() => loadCandidate(c, i)}>
              <div className="m-row">
                <span className="m-time">{fmtShort(c.start)} -&gt; {fmtShort(c.end)}</span>
                <span className="m-fb" onClick={(e) => e.stopPropagation()}>
                  <button className={`icon ${c.rating === 1 ? "on" : ""}`} title="Like -- trains your automation" onClick={() => rate(i, 1)}>&#9650;</button>
                  <button className={`icon ${c.rating === -1 ? "on" : ""}`} title="Dislike" onClick={() => rate(i, -1)}>&#9660;</button>
                </span>
              </div>
              {c.hook_variants && c.hook_variants.length > 1 ? (
                <div className="m-hook" onClick={(e) => e.stopPropagation()}>
                  {c.hook_variants.map((v, vi) => (
                    <span key={vi}
                          className={`chip ${(hookVariantSel[i] ?? 0) === vi ? "sel" : ""}`}
                          onClick={() => pickHookVariant(c, i, vi)}>
                      &quot;{v}&quot;
                    </span>
                  ))}
                </div>
              ) : (
                c.hook && <div className="m-hook">&quot;{c.hook}&quot;</div>
              )}
              {c.reason && <div className="m-reason">{c.reason}</div>}
              <div className="m-score">score {c.score}</div>
            </div>
          ))}
          {job.status === "ready" && (
            <button className="sec loadmore" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? <>Finding more <span className="spinner" /></> : "+ Load more moments"}
            </button>
          )}
          <div className="pane-h"><span>Transcript</span></div>
          <TranscriptPanel jobId={job.id} transcript={transcript} setTranscript={setTranscript}
                           open={transcriptOpen} setOpen={setTranscriptOpen} loading={transcriptLoading} />
        </div>

        {/* center: source + composer */}
        <div className="center">
          <div className="viewers">
            <div className="srcbox">
              {job.video_ready ? (
                <video
                  ref={videoRef}
                  src={`/api/jobs/${job.id}/source`}
                  onTimeUpdate={onTimeUpdate}
                  onPlay={() => { setPlaying(true); previewAudioRef.current?.play().catch(() => {}); }}
                  onPause={() => { setPlaying(false); setPreviewing(false); previewAudioRef.current?.pause(); }}
                  onLoadedMetadata={(e) => {
                    setDuration(e.target.duration);
                    setVdims([e.target.videoWidth, e.target.videoHeight]);
                  }}
                />
              ) : (
                <div style={{ flex: 1, display: "grid", placeItems: "center" }} className="muted">
                  {working ? "Downloading source..." : "No source video"}
                </div>
              )}
              <audio
                ref={previewAudioRef}
                src={previewAudioSrc || undefined}
                style={{ display: "none" }}
                onLoadedData={syncPreviewAudio}
                onError={() => setPreviewAudioSrc(null)}
              />
              <div className="boxlabel">SOURCE</div>
            </div>
            <Composer
              videoRef={videoRef}
              layout={layout}
              regions={effRegions}
              selRegion={selRegion}
              setRegions={setEffRegions}
              boxes={boxes}
              setBoxes={setBoxes}
              vdims={vdims}
              textLayers={textLayers}
              setTextLayers={setTextLayers}
              imageLayers={imageLayers}
              setImageLayers={setImageLayers}
              selLayerId={selLayerId}
              setSelLayerId={setSelLayerId}
              editingLayerId={editingLayerId}
              setEditingLayerId={setEditingLayerId}
              updateTextLayer={updateTextLayer}
              transcript={transcript}
              showCaptions={captions}
            />
          </div>

          <Transport
            playing={playing}
            playPause={playPause}
            frameStep={frameStep}
            time={time}
            dur={dur}
            fps={fps}
            tool={tool}
            setTool={setTool}
            splitAt={() => splitAt(time)}
            addSegment={addSegment}
            previewing={previewing}
            startPreview={startPreview}
            stopPreview={() => { videoRef.current?.pause(); setPreviewing(false); }}
            segments={segments}
          />

          <TimelineCanvas
            duration={dur}
            time={time}
            heatmap={job.meta?.heatmap || []}
            boundaries={job.meta?.clip_boundaries || []}
            candidates={job.candidates || []}
            segments={segments}
            selSeg={selSeg}
            setSelSeg={setSelSeg}
            setSegments={setSegments}
            tool={tool}
            onSeek={seek}
            onSplit={splitAt}
          />
        </div>

        {/* right: format + layers + render + clips */}
        <div className="pane">
          <div className="pane-h"><span>Format - 9:16</span></div>
          <div className="rp">
            <label>Layout</label>
            <select value={layout} onChange={(e) => changeLayout(e.target.value)}>
              {LAYOUTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>

            {Object.keys(LAYOUT_REGIONS[layout] || {}).length > 0 && (
              <>
                <label>Regions -- drag to pan - scroll to zoom{BOX_EDITABLE[layout] ? " - ctrl+drag window to move/resize" : ""}</label>
                <div className="regionbtns">
                  {Object.keys(LAYOUT_REGIONS[layout]).map((k) => (
                    <span key={k} className={`chip ${selRegion === k ? "sel" : ""}`} onClick={() => setSelRegion(k)}>
                      {k === "cam" ? "cam / chat" : k}
                    </span>
                  ))}
                  <span className="chip" onClick={() => { setRegions(defaultRegions(layout, vdims[0], vdims[1])); setBoxes(defaultBoxes(layout)); setSegRegions({}); }}>reset</span>
                </div>
                <div className="hint">
                  Select a region, then drag on the 9:16 preview to reposition what it shows;
                  scroll to zoom in/out. {BOX_EDITABLE[layout] ? "Hold Ctrl and drag the window body to move it, or its bottom-right corner to resize -- snaps to center/edges." : ""}
                  {segments.length > 1 ? " Crop/pan edits only apply to whichever segment is selected below -- each cut can have its own." : ""}
                </div>
              </>
            )}

            <label>Caption font</label>
            <select value={font} onChange={(e) => setFont(e.target.value)}>
              {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>

            <label>Transition (between cuts)</label>
            <select value={transition} onChange={(e) => setTransition(e.target.value)}>
              {TRANSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>

            <label>Segments</label>
            <div className="segchips">
              {segments.length === 0 && <span className="hint">Pick a moment on the left or press In on the timeline.</span>}
              {segments.map((s, i) => (
                <span key={s.id || i} className={`chip ${i === selSeg ? "sel" : ""}`} onClick={() => { setSelSeg(i); seek(s.start); }}>
                  {fmtShort(s.start)}-{fmtShort(s.end)}{s.id && segRegions[s.id] ? " *" : ""}
                  <b style={{ marginLeft: 6, color: "var(--danger)", cursor: "pointer" }}
                     onClick={(e) => { e.stopPropagation(); removeSeg(i); }}>&times;</b>
                </span>
              ))}
            </div>
            {segments.length > 1 && Object.keys(LAYOUT_REGIONS[layout] || {}).length > 0 && (
              <div className="hint">
                {segHasOverride
                  ? <>This segment (*) has its own crop. <span className="chip" onClick={clearSegOverride}>use shared crop instead</span></>
                  : "Selected segment uses the shared crop above -- drag on the preview to give it its own."}
              </div>
            )}

            <label>Text &amp; image layers -- drag directly on the 9:16 preview</label>
            <div className="row">
              <button className="sec" onClick={addTextLayer}>+ Add text</button>
              <button className="sec" onClick={() => fileInputRef.current?.click()}>+ Add image</button>
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPickImage} />
            </div>
            {(textLayers.length > 0 || imageLayers.length > 0) && (
              <div className="layerlist">
                {textLayers.map((l) => (
                  <div key={l.id} className={`layerrow ${selLayerId === l.id ? "sel" : ""}`} onClick={() => setSelLayerId(l.id)}>
                    <span className="lr-label">T - {l.text.slice(0, 18) || "(empty)"}</span>
                    <button className="icon" onClick={(e) => { e.stopPropagation(); removeTextLayer(l.id); }}>&#10005;</button>
                  </div>
                ))}
                {imageLayers.map((l) => (
                  <div key={l.id} className={`layerrow ${selLayerId === l.id ? "sel" : ""}`} onClick={() => setSelLayerId(l.id)}>
                    <span className="lr-label">IMG - {l.file}</span>
                    <button className="icon" onClick={(e) => { e.stopPropagation(); removeImageLayer(l.id); }}>&#10005;</button>
                  </div>
                ))}
              </div>
            )}
            {selTextLayer && (
              <div className="layerctl">
                <input type="text" value={selTextLayer.text}
                       onChange={(e) => updateTextLayer(selTextLayer.id, { text: e.target.value })} />
                <div className="row">
                  <select value={selTextLayer.font} onChange={(e) => updateTextLayer(selTextLayer.id, { font: e.target.value })}>
                    {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <input type="color" value={selTextLayer.color}
                         onChange={(e) => updateTextLayer(selTextLayer.id, { color: e.target.value })} />
                </div>
                <div className="row">
                  <input type="range" min="24" max="140" value={selTextLayer.fontSize}
                         onChange={(e) => updateTextLayer(selTextLayer.id, { fontSize: +e.target.value })} style={{ flex: 1 }} />
                  <label className="cap">
                    <input type="checkbox" checked={selTextLayer.glow}
                           onChange={(e) => updateTextLayer(selTextLayer.id, { glow: e.target.checked })} /> glow
                  </label>
                </div>
              </div>
            )}
            {selImageLayer && (
              <div className="hint">Drag the image on the preview to move it; drag its bottom-right corner to resize.</div>
            )}

            <label>Match a reference style</label>
            <select value={styleRefId || ""} onChange={(e) => applyStyleRef(e.target.value || null)}>
              <option value="">None</option>
              {refsList.map((r) => (
                <option key={r.id} value={r.id} disabled={r.status !== "ready"}>
                  {(r.meta?.title || r.url || "").slice(0, 40)}{r.status !== "ready" ? ` (${r.status})` : ""}
                </option>
              ))}
            </select>
            <div className="row">
              <input type="text" value={refUrl} onChange={(e) => setRefUrl(e.target.value)}
                     placeholder="Paste a TikTok/short URL to learn its style" />
              <button className="sec" onClick={addRef} disabled={addingRef || !refUrl.trim()}>+ Add</button>
            </div>
            {selectedRefStyle && (
              <div className="hint">
                Matching: {selectedRefStyle.text_pattern || "cut pacing"} - {selectedRefStyle.transition || "hard_cut"}
                {selectedRefStyle.tone ? ` - "${selectedRefStyle.tone}"` : ""}
                {!selectedRefStyle.vision_available ? " (no ANTHROPIC_API_KEY -- pacing only, no vision read)" : ""}
              </div>
            )}

            <label className="cap">
              <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} /> burn word-synced captions
            </label>

            <label>Music <span className="badge">{Math.round(musicStrength * 100)}%</span></label>
            <div className="row">
              <input type="range" min="0" max="100" value={Math.round(musicStrength * 100)}
                     onChange={(e) => setMusicStrength(+e.target.value / 100)} style={{ flex: 1 }} />
            </div>

            <label>Vocal <span className="badge">{Math.round(vocalBoost * 100)}%</span></label>
            <div className="row">
              <input type="range" min="0" max="100" value={Math.round(vocalBoost * 100)}
                     onChange={(e) => setVocalBoost(+e.target.value / 100)} style={{ flex: 1 }} />
            </div>

            {(musicStrength > 0 || vocalBoost > 0) && (
              <div className="hint">
                Music splices background music/SFX out of the mix; Vocal boosts voices on top of that
                (up to +6dB). Both use AI voice isolation (Demucs) under the hood -- it separates voice
                from everything else, but can&apos;t tell music apart from game sound effects, so those
                get quieted too. The preview above now plays the spliced mix so you can hear it before
                you render. First use on a given video takes noticeably longer (one-time separation
                pass across the whole source); every segment/slider combo after that is instant.
              </div>
            )}

            <RenderButton job={job} segments={segments} layout={layout} regions={regions} boxes={boxes}
                         segRegions={segRegions}
                         textLayers={textLayers} imageLayers={imageLayers} transition={transition}
                         font={font} captions={captions} setJob={setJob}
                         musicStrength={musicStrength}
                         vocalBoost={vocalBoost} />

            {(job.clips || []).length > 0 && (
              <>
                <label>Rendered clips ({job.clips.length})</label>
                {[...job.clips].reverse().map((c, i) => <ClipItem key={c.file || i} jobId={job.id} clip={c} />)}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- render button ---------------- */

function RenderButton({ job, segments, layout, regions, boxes, segRegions, textLayers, imageLayers, transition, font, captions, musicStrength, vocalBoost, setJob }) {
  const [rendering, setRendering] = useState(false);
  const [err, setErr] = useState(null);
  const render = async () => {
    setRendering(true); setErr(null);
    try {
      const clip = await post(`/api/jobs/${job.id}/render`, {
        segments, layout, regions, boxes, transition, font, captions,
        seg_regions: (segRegions && Object.keys(segRegions).length) ? segRegions : null,
        music_strength: musicStrength || 0, vocal_boost: vocalBoost || 0,
        text_layers: textLayers.map(({ id, ...rest }) => rest),
        image_layers: imageLayers.map(({ id, previewUrl, ...rest }) => rest),
      });
      setJob({ ...job, clips: [...(job.clips || []), clip] });
    } catch (e) { setErr(String(e.message || e)); }
    finally { setRendering(false); }
  };
  return (
    <>
      <button className="renderbtn" onClick={render} disabled={rendering || !segments.length || !job.video_ready}>
        {rendering ? <>Rendering... <span className="spinner" /></> : "Render 9:16"}
      </button>
      {err && <div className="hint error">{err}</div>}
    </>
  );
}

function ClipItem({ jobId, clip }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="clipitem">
      <div className="ci-row">
        <span>{clip.layout} - {clip.duration}s{clip.segments?.length > 1 ? ` - ${clip.segments.length} cuts` : ""}</span>
        <span>
          <button className="icon" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"}</button>
          <a href={clip.url} download>save</a>
        </span>
      </div>
      {open && <video src={clip.url} controls />}
    </div>
  );
}

/* ---------------- transport bar ---------------- */

function Transport({ playing, playPause, frameStep, time, dur, fps, tool, setTool, splitAt, addSegment, previewing, startPreview, stopPreview, segments }) {
  const total = segments.reduce((a, s) => a + Math.max(0, s.end - s.start), 0);
  return (
    <div className="transport">
      <button className="tool" onClick={() => frameStep(-1)} title="Previous frame (,)">&#9198;</button>
      <button className="tool" onClick={playPause} title="Play/pause (space)">{playing ? "⏸" : "▶"}</button>
      <button className="tool" onClick={() => frameStep(1)} title="Next frame (.)">&#9197;</button>
      <span className="tc">{fmt(time)} / {fmt(dur)}</span>
      <span className="badge">{fps} fps</span>
      <span className="sep" />
      <button className={`tool ${tool === "select" ? "on" : ""}`} onClick={() => setTool("select")} title="Select/drag tool -- drag segment edges to trim, body to move">select</button>
      <button className={`tool ${tool === "razor" ? "on" : ""}`} onClick={() => setTool("razor")} title="Razor -- click a segment to split it">razor</button>
      <button className="tool" onClick={splitAt} title="Split at playhead (s)">split @ playhead</button>
      <button className="tool" onClick={addSegment} title="New segment at playhead">+ segment</button>
      <span className="sep" />
      {previewing
        ? <button className="tool on" onClick={stopPreview}>stop</button>
        : <button className="tool" onClick={startPreview} disabled={!segments.length} title="Play only the segments, skipping gaps">preview cuts</button>}
      {segments.length > 0 && <span className="badge">clip {total.toFixed(1)}s{segments.length > 1 ? ` - ${segments.length} cuts` : ""}</span>}
      <span style={{ flex: 1 }} />
      <span className="hint">wheel = zoom timeline - drag = pan - space , . s</span>
    </div>
  );
}

/* ---------------- timeline canvas ---------------- */

function TimelineCanvas({ duration, time, heatmap, boundaries, candidates, segments, selSeg, setSelSeg, setSegments, tool, onSeek, onSplit }) {
  const canvasRef = useRef(null);
  const [view, setView] = useState({ t0: 0, t1: 60 });
  const dragRef = useRef(null);
  const stateRef = useRef({});
  stateRef.current = { duration, time, heatmap, boundaries, candidates, segments, selSeg, view, tool };

  useEffect(() => {
    if (duration > 0) setView({ t0: 0, t1: duration });
  }, [duration]);

  /* draw */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    let raf;
    const draw = () => {
      const { duration: dur, time: t, heatmap: hm, boundaries: bnds, candidates: cands, segments: segs, selSeg: sel, view: v } = stateRef.current;
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const span = Math.max(v.t1 - v.t0, 0.001);
      const X = (tt) => ((tt - v.t0) / span) * w;

      /* heatmap */
      ctx.fillStyle = "#232c3f";
      for (const e of hm) {
        const x0 = X(e.start_time), x1 = X(e.end_time);
        if (x1 < 0 || x0 > w) continue;
        const bh = Math.max(e.value * (h - 46), 2);
        ctx.fillRect(x0, h - 18 - bh, Math.max(x1 - x0 - 0.5, 1), bh);
      }

      /* detected compilation cut boundaries */
      if (bnds && bnds.length > 1) {
        ctx.strokeStyle = "rgba(255,255,255,.4)";
        ctx.setLineDash([2, 3]);
        for (const b of bnds) {
          const x = X(b.start);
          if (x < 0 || x > w) continue;
          ctx.beginPath(); ctx.moveTo(x, 22); ctx.lineTo(x, h - 18); ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      /* candidate markers */
      for (const c of cands) {
        const x0 = X(c.start), x1 = X(c.end);
        if (x1 < 0 || x0 > w) continue;
        ctx.fillStyle = c.rating === 1 ? "rgba(0,255,136,.16)" : c.rating === -1 ? "rgba(255,84,112,.10)" : "rgba(140,160,220,.10)";
        ctx.fillRect(x0, 22, x1 - x0, h - 40 - 22);
        ctx.fillStyle = "rgba(140,160,220,.5)";
        ctx.fillRect(x0, 22, 1, h - 40 - 22);
      }

      /* segments */
      segs.forEach((s, i) => {
        const x0 = X(s.start), x1 = X(s.end);
        if (x1 < 0 || x0 > w) return;
        ctx.fillStyle = i === sel ? "rgba(0,255,136,.30)" : "rgba(0,255,136,.16)";
        ctx.fillRect(x0, 22, x1 - x0, h - 40 - 22);
        ctx.fillStyle = "#00ff88";
        ctx.fillRect(x0 - 1, 22, 3, h - 62);
        ctx.fillRect(x1 - 1, 22, 3, h - 62);
      });

      /* ruler */
      ctx.fillStyle = "#0d1017";
      ctx.fillRect(0, 0, w, 20);
      ctx.strokeStyle = "#2a3242";
      ctx.fillStyle = "#8b94a7";
      ctx.font = "10px Consolas, monospace";
      const targetTicks = w / 90;
      const steps = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
      const step = steps.find((s) => span / s <= targetTicks) || 600;
      for (let tt = Math.ceil(v.t0 / step) * step; tt <= v.t1; tt += step) {
        const x = X(tt);
        ctx.beginPath(); ctx.moveTo(x, 12); ctx.lineTo(x, 20); ctx.stroke();
        ctx.fillText(step < 1 ? tt.toFixed(2) : fmtShort(tt), x + 3, 10);
      }

      /* playhead */
      const px = X(t);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(px - 0.5, 0, 1.5, h);
      ctx.beginPath();
      ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 8); ctx.closePath();
      ctx.fill();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* interactions */
  const toTime = (clientX) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const { view: v } = stateRef.current;
    return v.t0 + ((clientX - rect.left) / rect.width) * (v.t1 - v.t0);
  };

  const onWheel = (e) => {
    e.preventDefault();
    const { view: v, duration: dur } = stateRef.current;
    const span = v.t1 - v.t0;
    const cursor = toTime(e.clientX);
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    let ns = Math.min(Math.max(span * factor, 0.5), dur || 60);
    let t0 = cursor - ((cursor - v.t0) / span) * ns;
    t0 = Math.min(Math.max(t0, 0), Math.max((dur || 60) - ns, 0));
    setView({ t0, t1: t0 + ns });
  };
  useEffect(() => {
    const cv = canvasRef.current;
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, []);

  const hitTest = (t, pxTolerance) => {
    const { segments: segs, view: v } = stateRef.current;
    const w = canvasRef.current.clientWidth;
    const tol = (pxTolerance / w) * (v.t1 - v.t0);
    for (let i = segs.length - 1; i >= 0; i--) {
      if (Math.abs(t - segs[i].start) < tol) return { i, part: "start" };
      if (Math.abs(t - segs[i].end) < tol) return { i, part: "end" };
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      if (t > segs[i].start && t < segs[i].end) return { i, part: "body" };
    }
    return null;
  };

  const onPointerDown = (e) => {
    canvasRef.current.setPointerCapture(e.pointerId);
    const t = toTime(e.clientX);
    const { tool: tl, segments: segs, view: v } = stateRef.current;
    if (tl === "razor") {
      const hit = hitTest(t, 6);
      if (hit && hit.part === "body") onSplit(t);
      return;
    }
    const hit = hitTest(t, 6);
    if (hit) {
      setSelSeg(hit.i);
      dragRef.current = { kind: hit.part, i: hit.i, startT: t, orig: { ...segs[hit.i] }, moved: false };
    } else {
      dragRef.current = { kind: "pan", startX: e.clientX, origView: { ...v }, startT: t, moved: false };
    }
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const t = toTime(e.clientX);
    if (Math.abs(e.clientX - (d.lastX ?? e.clientX)) > 0) d.lastX = e.clientX;
    const { segments: segs, duration: dur, view: v } = stateRef.current;
    if (!d.moved && Math.abs(t - d.startT) < (v.t1 - v.t0) * 0.004) return;
    d.moved = true;
    if (d.kind === "pan") {
      const rect = canvasRef.current.getBoundingClientRect();
      const span = d.origView.t1 - d.origView.t0;
      const dt = ((d.startX - e.clientX) / rect.width) * span;
      let t0 = Math.min(Math.max(d.origView.t0 + dt, 0), Math.max((dur || 60) - span, 0));
      setView({ t0, t1: t0 + span });
      return;
    }
    const next = segs.map((s) => ({ ...s }));
    const s = next[d.i];
    if (d.kind === "start") s.start = Math.min(Math.max(t, 0), s.end - 0.2);
    else if (d.kind === "end") s.end = Math.max(Math.min(t, dur || t), s.start + 0.2);
    else if (d.kind === "body") {
      const len = d.orig.end - d.orig.start;
      let ns = d.orig.start + (t - d.startT);
      ns = Math.min(Math.max(ns, 0), (dur || len) - len);
      s.start = ns; s.end = ns + len;
    }
    setSegments(next);
  };

  const onPointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved && (d.kind === "pan" || d.kind === "body")) {
      onSeek(toTime(e.clientX));
    }
  };

  return (
    <div className="tl-wrap">
      <canvas
        ref={canvasRef}
        className="tl-canvas"
        style={{ cursor: tool === "razor" ? "crosshair" : "default" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  );
}

/* ---------------- 9:16 composer (live preview: regions/boxes/text/image layers) ---------------- */

function Composer({
  videoRef, layout, regions, selRegion, setRegions, boxes, setBoxes, vdims,
  textLayers, setTextLayers, imageLayers, setImageLayers,
  selLayerId, setSelLayerId, editingLayerId, setEditingLayerId, updateTextLayer,
  transcript, showCaptions,
}) {
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const stateRef = useRef({});
  stateRef.current = { layout, regions, selRegion, boxes, vdims, textLayers, imageLayers, selLayerId, showCaptions };
  const captionChunksRef = useRef([]);
  useEffect(() => { captionChunksRef.current = buildCaptionChunks(transcript); }, [transcript]);
  const emojiIndexRef = useRef(null);
  const emojiImgCache = useRef({});
  const imgLayerCache = useRef({});
  const textBoxesRef = useRef({}); // last-drawn bbox per text layer id, in FRACTION space
  const imageBoxesRef = useRef({});
  const [editRect, setEditRect] = useState(null);

  useEffect(() => {
    fetch("/emoji/emoji.json").then((r) => r.json()).then((data) => {
      const map = new Map();
      for (const e of data) {
        map.set(e.unified.toUpperCase(), e.image);
        if (e.non_qualified) map.set(e.non_qualified.toUpperCase(), e.image);
      }
      emojiIndexRef.current = map;
    }).catch(() => {});
  }, []);

  const emojiPngUrl = (cluster) => {
    const idx = emojiIndexRef.current;
    if (!idx) return null;
    for (const key of [emojiCodeKey(cluster, false), emojiCodeKey(cluster, true)]) {
      const fname = idx.get(key);
      if (fname) return `/emoji/64/${fname}`;
    }
    return null;
  };

  /* draw loop */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    let raf;
    const CW = 540, CH = 960; // internal resolution (2x display)
    const draw = () => {
      const { layout: lo, regions: regs, selRegion: sel, boxes: bx, vdims: vd, textLayers: tls, imageLayers: ils } = stateRef.current;
      const video = videoRef.current;
      if (cv.width !== CW) { cv.width = CW; cv.height = CH; }
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, CW, CH);
      const scale = CW / 1080;
      const ready = video && video.readyState >= 2 && vd[0] > 0;

      if (ready) {
        if (lo === "blur_pillarbox" || lo === "white_pillarbox") {
          const [vw, vh] = vd;
          if (lo === "blur_pillarbox") {
            ctx.filter = "blur(14px)";
            const cover = effRect({ x: 0, y: 0, w: 1, h: 1 }, 1080, 1920, vw, vh);
            ctx.drawImage(video, cover[0], cover[1], cover[2], cover[3], 0, 0, CW, CH);
            ctx.filter = "none";
          } else {
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, CW, CH);
          }
          const fh = (vh / vw) * CW;
          ctx.drawImage(video, 0, (CH - fh) / 2, CW, fh);
        } else {
          const dests = currentDests(lo, bx);
          const order = Object.keys(dests);
          for (const key of order) {
            const [dx, dy, dw, dh] = dests[key];
            const rect = (regs || {})[key];
            if (!rect) continue;
            const [ex, ey, ew, eh] = effRect(rect, dw, dh, vd[0], vd[1]);
            ctx.drawImage(video, ex, ey, ew, eh, dx * scale, dy * scale, dw * scale, dh * scale);
          }
          for (const key of order) {
            const [dx, dy, dw, dh] = dests[key];
            ctx.strokeStyle = key === sel ? "#00ff88" : "rgba(255,255,255,.18)";
            ctx.lineWidth = key === sel ? 2.5 : 1;
            ctx.strokeRect(dx * scale + 1, dy * scale + 1, dw * scale - 2, dh * scale - 2);
            if (key === sel) {
              ctx.fillStyle = "rgba(0,255,136,.9)";
              ctx.font = "bold 13px system-ui";
              ctx.fillText(key === "cam" ? "CAM / CHAT" : key.toUpperCase(), dx * scale + 8, dy * scale + 18);
            }
          }
        }

        /* word-synced captions -- mirrors the ASS style used at render time closely enough
           to be a trustworthy preview (bold white + thick black outline, bottom-third),
           though the karaoke fill sweep itself isn't reproduced here, just the text/timing. */
        if (stateRef.current.showCaptions) {
          const capText = activeCaptionText(captionChunksRef.current, video.currentTime || 0);
          if (capText) {
            const capSize = 0.0458 * CH;
            ctx.font = `900 ${capSize}px "Montserrat"`;
            ctx.textAlign = "center";
            ctx.textBaseline = "alphabetic";
            const cx = CW / 2, cy = CH * 0.70;
            ctx.lineWidth = capSize * 0.16;
            ctx.strokeStyle = "rgba(0,0,0,0.9)";
            ctx.fillStyle = "#ffffff";
            ctx.strokeText(capText, cx, cy);
            ctx.fillText(capText, cx, cy);
            ctx.textAlign = "left"; // text layers below assume default (left) alignment
          }
        }

        /* image layers */
        for (const im of ils || []) {
          const w = im.w * CW, h = im.h * CH, x = im.x * CW - w / 2, y = im.y * CH - h / 2;
          imageBoxesRef.current[im.id] = { x: im.x - im.w / 2, y: im.y - im.h / 2, w: im.w, h: im.h };
          let img = imgLayerCache.current[im.previewUrl];
          if (!img) { img = new window.Image(); img.src = im.previewUrl; imgLayerCache.current[im.previewUrl] = img; }
          if (img.complete && img.naturalWidth) ctx.drawImage(img, x, y, w, h);
          if (im.id === stateRef.current.selLayerId) {
            ctx.strokeStyle = "#00ff88"; ctx.lineWidth = 2;
            ctx.strokeRect(x, y, w, h);
            ctx.fillStyle = "#00ff88";
            ctx.fillRect(x + w - 8, y + h - 8, 8, 8);
          }
        }

        /* text layers */
        for (const layer of tls || []) {
          const size = Math.max(layer.fontSize || 64, 8) * scale;
          ctx.font = `900 ${size}px "${layer.font || "Montserrat"}"`;
          ctx.textBaseline = "top";
          const runs = splitRuns(layer.text || "");
          const widths = runs.map(([chunk, isEmoji]) => (isEmoji ? size : ctx.measureText(chunk).width));
          const totalW = widths.reduce((a, b) => a + b, 0) || 1;
          const cx = (layer.x ?? 0.5) * CW, cy = (layer.y ?? 0.14) * CH;
          const startX = cx - totalW / 2, topY = cy - size / 2;
          textBoxesRef.current[layer.id] = { x: startX / CW, y: topY / CH, w: totalW / CW, h: size / CH };

          if (layer.glow) {
            for (const [bw, a] of [[16 * scale, 0.25], [10 * scale, 0.35], [6 * scale, 0.5]]) {
              let gx = startX;
              ctx.lineWidth = bw;
              ctx.strokeStyle = hexAlpha(layer.color, a);
              ctx.fillStyle = hexAlpha(layer.color, a);
              for (const [chunk, isEmoji] of runs) {
                if (!isEmoji && chunk) { ctx.strokeText(chunk, gx, topY); ctx.fillText(chunk, gx, topY); }
                gx += isEmoji ? size : ctx.measureText(chunk).width;
              }
            }
          }
          let curX = startX;
          for (let i = 0; i < runs.length; i++) {
            const [chunk, isEmoji] = runs[i];
            if (isEmoji) {
              const url = emojiPngUrl(chunk);
              if (url) {
                let img = emojiImgCache.current[url];
                if (!img) { img = new window.Image(); img.src = url; emojiImgCache.current[url] = img; }
                if (img.complete && img.naturalWidth) ctx.drawImage(img, curX, topY, size, size);
              }
            } else if (chunk) {
              ctx.lineWidth = 3 * scale * 2;
              ctx.strokeStyle = "rgba(0,0,0,0.85)";
              ctx.fillStyle = layer.color || "#fff";
              ctx.strokeText(chunk, curX, topY);
              ctx.fillText(chunk, curX, topY);
            }
            curX += widths[i];
          }
          if (layer.id === stateRef.current.selLayerId) {
            ctx.strokeStyle = "#00ff88"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
            ctx.strokeRect(startX - 4, topY - 4, totalW + 8, size + 8);
            ctx.setLineDash([]);
          }
        }
      } else {
        ctx.fillStyle = "#39414f";
        ctx.font = "14px system-ui";
        ctx.fillText("waiting for video...", 20, CH / 2);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [videoRef]);

  /* inline text-edit overlay position */
  useEffect(() => {
    if (!editingLayerId) { setEditRect(null); return; }
    const compute = () => {
      const cv = canvasRef.current;
      const bbox = textBoxesRef.current[editingLayerId];
      if (!cv || !bbox) return;
      const rect = cv.getBoundingClientRect();
      setEditRect({
        left: rect.left + bbox.x * rect.width,
        top: rect.top + bbox.y * rect.height,
        width: Math.max(bbox.w * rect.width + 16, 100),
        height: Math.max(bbox.h * rect.height + 8, 30),
      });
    };
    compute();
    const t = setInterval(compute, 200);
    window.addEventListener("resize", compute);
    return () => { clearInterval(t); window.removeEventListener("resize", compute); };
  }, [editingLayerId]);

  const toFrac = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { fx: (e.clientX - rect.left) / rect.width, fy: (e.clientY - rect.top) / rect.height };
  };

  const pickTextOrImageLayer = (fx, fy) => {
    const { textLayers: tls, imageLayers: ils } = stateRef.current;
    for (let i = (ils || []).length - 1; i >= 0; i--) {
      const im = ils[i];
      const b = imageBoxesRef.current[im.id];
      if (!b) continue;
      const corner = Math.abs(fx - (b.x + b.w)) < 0.03 && Math.abs(fy - (b.y + b.h)) < 0.03;
      if (fx >= b.x && fx <= b.x + b.w && fy >= b.y && fy <= b.y + b.h) return { type: "image", id: im.id, corner, rect: b };
    }
    for (let i = (tls || []).length - 1; i >= 0; i--) {
      const l = tls[i];
      const b = textBoxesRef.current[l.id];
      if (!b) continue;
      if (fx >= b.x - 0.01 && fx <= b.x + b.w + 0.01 && fy >= b.y - 0.01 && fy <= b.y + b.h + 0.01) return { type: "text", id: l.id, rect: b };
    }
    return null;
  };

  const pickRegionKey = (fx, fy) => {
    const { layout: lo, boxes: bx } = stateRef.current;
    const dests = currentDests(lo, bx);
    const keys = Object.keys(dests).reverse();
    for (const key of keys) {
      const [dx, dy, dw, dh] = dests[key];
      const x0 = dx / 1080, y0 = dy / 1920, x1 = (dx + dw) / 1080, y1 = (dy + dh) / 1920;
      if (fx >= x0 && fx <= x1 && fy >= y0 && fy <= y1) return key;
    }
    return null;
  };

  const onPointerDown = (e) => {
    canvasRef.current.setPointerCapture(e.pointerId);
    const { fx, fy } = toFrac(e);

    const layerHit = pickTextOrImageLayer(fx, fy);
    if (layerHit) {
      setSelLayerId(layerHit.id);
      if (layerHit.type === "image") {
        dragRef.current = { kind: layerHit.corner ? "imgresize" : "imgmove", id: layerHit.id, startFx: fx, startFy: fy, orig: { ...layerHit.rect } };
      } else {
        dragRef.current = { kind: "textmove", id: layerHit.id, startFx: fx, startFy: fy, orig: { ...layerHit.rect } };
      }
      return;
    }

    const key = pickRegionKey(fx, fy) || stateRef.current.selRegion;
    if (!key) return;
    setSelLayerId(null);

    if (e.ctrlKey || e.metaKey) {
      const dests = currentDests(stateRef.current.layout, stateRef.current.boxes);
      const [dx, dy, dw, dh] = dests[key];
      const box = { x: dx / 1080, y: dy / 1920, w: dw / 1080, h: dh / 1920 };
      const corner = Math.abs(fx - (box.x + box.w)) < 0.035 && Math.abs(fy - (box.y + box.h)) < 0.035;
      setSelRegion(key);
      dragRef.current = { kind: corner ? "boxresize" : "boxmove", key, startFx: fx, startFy: fy, orig: box };
      return;
    }

    dragRef.current = { key, startX: e.clientX, startY: e.clientY, orig: { ...((stateRef.current.regions || {})[key] || {}) } };
  };

  const guideList = (excludeKey, axis) => {
    const { layout: lo, boxes: bx } = stateRef.current;
    const dests = currentDests(lo, bx);
    const g = [0, 0.5, 1];
    for (const k of Object.keys(dests)) {
      if (k === excludeKey) continue;
      const [dx, dy, dw, dh] = dests[k];
      if (axis === "x") { g.push(dx / 1080, (dx + dw) / 1080, (dx + dw / 2) / 1080); }
      else { g.push(dy / 1920, (dy + dh) / 1920, (dy + dh / 2) / 1920); }
    }
    return g;
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const { fx, fy } = toFrac(e);

    if (d.kind === "textmove") {
      const b = textBoxesRef.current[d.id] || d.orig;
      let nx = d.orig.x + (fx - d.startFx) + b.w / 2;
      let ny = d.orig.y + (fy - d.startFy) + b.h / 2;
      const snapped = snapRect({ x: nx - b.w / 2, y: ny - b.h / 2, w: b.w, h: b.h }, [0, 0.5, 1], [0, 0.5, 1]);
      updateTextLayer(d.id, { x: snapped.x + b.w / 2, y: snapped.y + b.h / 2 });
      return;
    }
    if (d.kind === "imgmove" || d.kind === "imgresize") {
      const { imageLayers: ils } = stateRef.current;
      const layer = ils.find((l) => l.id === d.id);
      if (!layer) return;
      if (d.kind === "imgmove") {
        let r = { x: d.orig.x + (fx - d.startFx), y: d.orig.y + (fy - d.startFy), w: d.orig.w, h: d.orig.h };
        r = snapRect(r, [0, 0.5, 1], [0, 0.5, 1]);
        setImageLayers((arr) => arr.map((l) => (l.id === d.id ? { ...l, x: r.x + r.w / 2, y: r.y + r.h / 2 } : l)));
      } else {
        const w = Math.max(0.04, Math.min(1, fx - d.orig.x));
        const h = Math.max(0.04, Math.min(1, fy - d.orig.y));
        setImageLayers((arr) => arr.map((l) => (l.id === d.id ? { ...l, x: d.orig.x + w / 2, y: d.orig.y + h / 2, w, h } : l)));
      }
      return;
    }
    if (d.kind === "boxmove" || d.kind === "boxresize") {
      const { boxes: bx } = stateRef.current;
      const orig = d.orig;
      if (d.kind === "boxmove") {
        let r = { x: orig.x + (fx - d.startFx), y: orig.y + (fy - d.startFy), w: orig.w, h: orig.h };
        r.x = Math.min(Math.max(r.x, 0), 1 - r.w);
        r.y = Math.min(Math.max(r.y, 0), 1 - r.h);
        r = snapRect(r, guideList(d.key, "x"), guideList(d.key, "y"));
        setBoxes({ ...bx, [d.key]: r });
      } else {
        let w = Math.max(0.08, Math.min(1 - orig.x, fx - orig.x));
        let h = Math.max(0.08, Math.min(1 - orig.y, fy - orig.y));
        let r = { x: orig.x, y: orig.y, w, h };
        const snappedBR = snapRect(
          { x: orig.x + w - 0.001, y: orig.y + h - 0.001, w: 0.002, h: 0.002 },
          guideList(d.key, "x"), guideList(d.key, "y")
        );
        r.w = Math.max(0.08, snappedBR.x - orig.x);
        r.h = Math.max(0.08, snappedBR.y - orig.y);
        setBoxes({ ...bx, [d.key]: r });
      }
      return;
    }

    // legacy region pan (source crop)
    if (d.orig.x === undefined) return;
    const { layout: lo, vdims: vd, boxes: bx, regions: regs } = stateRef.current;
    const dests = currentDests(lo, bx);
    const dest = dests[d.key];
    if (!dest) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const [, , dw, dh] = dest;
    const [, , ew, eh] = effRect(d.orig, dw, dh, vd[0], vd[1]);
    const fx2 = ((e.clientX - d.startX) / rect.width) * (1080 / dw) * (ew / vd[0]);
    const fy2 = ((e.clientY - d.startY) / rect.height) * (1920 / dh) * (eh / vd[1]);
    const r = { ...d.orig };
    r.x = Math.min(Math.max(d.orig.x - fx2, 0), 1 - r.w);
    r.y = Math.min(Math.max(d.orig.y - fy2, 0), 1 - r.h);
    setRegions({ ...regs, [d.key]: r });
  };

  const onPointerUp = () => { dragRef.current = null; };

  const onDoubleClick = (e) => {
    const { fx, fy } = toFrac(e);
    const hit = pickTextOrImageLayer(fx, fy);
    if (hit && hit.type === "text") { setSelLayerId(hit.id); setEditingLayerId(hit.id); }
  };

  const onWheel = (e) => {
    e.preventDefault();
    const { fx, fy } = toFrac(e);
    const layerHit = pickTextOrImageLayer(fx, fy);
    if (layerHit && layerHit.type === "text") {
      updateTextLayer(layerHit.id, {
        fontSize: Math.max(16, Math.min(200, (stateRef.current.textLayers.find((l) => l.id === layerHit.id)?.fontSize || 64) * (e.deltaY > 0 ? 0.93 : 1.075))),
      });
      return;
    }
    const { regions: regs, selRegion: sel } = stateRef.current;
    const key = pickRegionKey(fx, fy) || sel;
    if (!key || !regs?.[key]) return;
    const r = { ...regs[key] };
    const factor = e.deltaY > 0 ? 1.07 : 0.935;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    r.w = Math.min(Math.max(r.w * factor, 0.03), 1);
    r.h = Math.min(Math.max(r.h * factor, 0.03), 1);
    r.x = Math.min(Math.max(cx - r.w / 2, 0), 1 - r.w);
    r.y = Math.min(Math.max(cy - r.h / 2, 0), 1 - r.h);
    setRegions({ ...regs, [key]: r });
  };
  useEffect(() => {
    const cv = canvasRef.current;
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, []);

  const editingLayer = textLayers.find((l) => l.id === editingLayerId);

  return (
    <div className="compbox">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
      />
      <div className="boxlabel">9:16 PREVIEW -- exactly what renders - double-click text to edit</div>
      {editingLayer && editRect && (
        <textarea
          autoFocus
          className="inline-text-edit"
          style={{ position: "fixed", left: editRect.left, top: editRect.top, width: editRect.width, height: editRect.height }}
          value={editingLayer.text}
          onChange={(e) => updateTextLayer(editingLayer.id, { text: e.target.value })}
          onFocus={(e) => e.target.select()}
          onBlur={() => setEditingLayerId(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); setEditingLayerId(null); }
            if (e.key === "Escape") setEditingLayerId(null);
          }}
        />
      )}
    </div>
  );
}
