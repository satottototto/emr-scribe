# EMR Scribe

Low-latency handwriting for Obsidian on **E-Ink tablets with Wacom EMR styluses** (Bigme, Boox, and similar Android E-Ink devices) — and it works fine with mouse or pen on desktop too.

Existing drawing plugins re-render their whole scene through a UI framework on every pen sample, which makes them feel sluggish on E-Ink hardware. EMR Scribe draws each new ink segment straight onto a low-latency canvas instead.

## Why it feels fast

- **Incremental rendering** — while you write, only the new segment is drawn. No framework, no virtual DOM, no full-scene redraws (which is also what makes E-Ink screens flash).
- **Every pen sample counts** — `pointerrawupdate` + `getCoalescedEvents()` capture the full EMR report rate (140 Hz+), not one point per display frame.
- **Low-latency canvas** — `desynchronized: true` lets ink bypass the compositor queue where supported (enabled on mobile by default).
- **Predicted ink** — `getPredictedEvents()` draws a short predicted tail to cut perceived latency (optional).

## Handwriting features

- **Pen / marker / eraser** with an iPad-Notes-style popover: 5 thickness presets, color palette + custom color, opacity slider (settings are remembered per tool).
- **Pressure-sensitive** stroke width (pen), stroke-level eraser, hardware eraser button support.
- **Real palm rejection** — fingers scroll, the pen draws, and touches during or right after pen use are ignored. A palm-initiated scroll is cancelled the instant the pen lands.
- **Multi-page canvas** — extend the page downward as you go (one canvas per page, so it never hits the GPU texture-size limit that makes tall canvases break on E-Ink SoCs). Page numbers can be drawn in any corner.
- **Import & annotate** — bring in a camera shot, photo, or file (PDF / image) and write on top of it. Each PDF page or image becomes a page background; your ink stays on its own layer.
- **Floating-ball toolbar** — optionally collapse the toolbar into a draggable round button to free the whole screen for writing.

## Handwriting recognition (OCR)

Turn on **OCR Auto** and the page is recognized ~2 seconds after you stop writing; the text appears in a selectable form directly below the ink and is stored **inside the same file**, so handwriting and text always travel together. Notes embed both (` ```scribe ``` ` code block → lightweight SVG preview + text).

- Built-in engine: Google handwriting recognition (stroke-based — much stronger for handwriting than image OCR). Japanese and English. No API key. Requires network.
- Recognition is cached per line, so auto-OCR normally costs a single request.
- Highlighter strokes are excluded from recognition.
- Privacy note: stroke data is sent to Google's servers when OCR runs. Don't enable it for content that must stay local (a custom HTTP endpoint mode is available for self-hosted OCR).

## File format

`.scribe` files are plain JSON: stroke coordinates (with pressure and timing) plus the recognized text. Your ink is never rasterized away.

## Recommended E-Ink setup

- Set your device's per-app refresh mode for Obsidian to the fastest mode (A2 / X-Speed).
- Disable system animations (developer options).
- On slow devices, lower "Canvas resolution scale" in the plugin settings.

## License

MIT
