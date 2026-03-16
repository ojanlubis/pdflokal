# Future Architecture Ideas

> This document captures architectural ideas for future Claude sessions to pick up.
> These are NOT active tasks — read this before starting any major refactor.

---

## 1. Reactive State Layer — COMPLETED (Mar 2026)

### Implementation

Implemented as `js/lib/events.js` — a ~37 line synchronous event emitter (Fabric.js pattern).

```js
// js/lib/events.js — SINGLE SOURCE OF TRUTH
import { on, off, emit } from '../lib/events.js';

on('pages:changed', (detail) => { /* react */ });   // returns unsubscribe fn
emit('pages:changed', { source: 'user' });
```

### Event Channels

| Event | Fires when | Detail |
|-------|-----------|--------|
| `pages:changed` | Pages added/removed/reordered/restored | `{ source: 'user' \| 'restore' }` |
| `annotations:changed` | Annotation structurally added/removed | `{ pageIndex }` or `{ source: 'restore' }` |
| `annotations:modified` | Gesture complete (mouseup/edit save) | `{ pageIndex }` |
| `page:selected` | Current page changes | `{ index }` |
| `tool:changed` | Active tool switches | `{ tool }` |

### Design Decisions

- **Synchronous, no batching** — same as Fabric.js. Hot-path rendering (drag/resize at 60fps) uses direct `ueRedrawAnnotations()`, NOT events
- **Source tagging** — `{ source: 'restore' }` lets subscribers skip redundant work during undo/redo
- **Additive migration** — events supplement direct calls. If a subscriber is missed, app still works
- **12 emitter files**, 2 subscriber files (sidebar.js, lifecycle.js) as of Mar 2026
- Search for `emit(` and `on(` to find all wired dependencies

---

## 2. Web Workers for Heavy Operations (Priority: Medium)

### The Problem

Currently pdflokal has ONE web worker — PDF.js's built-in `pdf.worker.min.js`
for PDF parsing. All other heavy operations run on the main thread:

- PDF compression (re-encoding images)
- PDF export / `ueBuildFinalPDF`
- Image processing (resize, convert, remove background)

Large files can freeze the UI during these operations.

### The Idea

Move heavy operations to dedicated workers. Basic pattern:

```js
// js/workers/compress.js
self.onmessage = ({ data }) => {
  const result = heavyCompression(data.fileBytes)
  self.postMessage(result)
}

// caller
const worker = new Worker('./js/workers/compress.js')
worker.postMessage({ fileBytes })
worker.onmessage = ({ data }) => downloadResult(data)
```

### Candidates (in priority order)

1. **PDF export** (`pdf-export.js` → `ueBuildFinalPDF`) — blocks UI on large
   multi-page files. Highest user impact.
2. **Image compression** (`image-tools.js`) — canvas re-encoding is CPU heavy
3. **PDF compression** (`standalone-tools.js`) — re-encodes embedded images
4. **Remove background** — already async but could be offloaded further

### Constraint

Workers can't access the DOM or canvas directly. Data must be passed as
transferable objects (ArrayBuffer, ImageData). pdf-lib operations are pure JS
and are worker-safe. PDF.js rendering requires the main thread canvas — keep
that on main.

### Before Implementing

- Implement reactive state layer first (Issue #1 above)
- Profile which operation causes the most noticeable freeze on a real 50MB PDF
- Start with ONE worker (PDF export) before generalizing

---

## Reading Order for Future Claude

1. Read `CLAUDE.md` first (always)
2. Read `docs/architecture.md` for SSOT patterns
3. Read `docs/patterns.md` for code conventions (includes event emitter pattern)
4. Read this file for planned improvements (Section 1 is done, Section 2 is future)
5. Read `js/lib/state.js` to understand current state shape before touching anything
6. Read `js/lib/events.js` for the event emitter channels
