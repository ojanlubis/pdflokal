# Future Architecture Ideas

> This document captures architectural ideas for future Claude sessions to pick up.
> These are NOT active tasks — read this before starting any major refactor.

---

## 1. Reactive State Layer (Priority: High)

### The Problem

`ueState` is the SSOT for data, but rendering is manual. After any state mutation,
code must manually call the right update functions:

```js
// Current — manual, error-prone
ueState.pages.splice(index, 1)
ueRedrawAnnotations()    // forget this → canvas wrong
ueRenderThumbnails()     // forget this → sidebar wrong
updateModal()            // forget this → modal wrong
```

Missing even one call causes the canvas, sidebar thumbnails, and Gabungkan modal
to desync. This is the root cause of "manage page modal not wiring correctly"
reported in first-hand testing.

### The Idea

Add a tiny pub/sub layer (~15 lines) to `js/lib/state.js`. Nothing subscribes
automatically — each module declares what it cares about.

```js
// js/lib/state.js addition
const subscribers = {}

export function subscribe(key, fn) {
  if (!subscribers[key]) subscribers[key] = []
  subscribers[key].push(fn)
}

export function notify(key) {
  (subscribers[key] || []).forEach(fn => fn())
}
```

Each module subscribes once at init:
```js
// sidebar.js
subscribe('pages', ueRenderThumbnails)

// page-rendering.js
subscribe('pages', ueRedrawAnnotations)

// page-manager.js
subscribe('pages', updateModal)
```

State mutation becomes:
```js
ueState.pages.splice(index, 1)
notify('pages')  // everything syncs automatically
```

### Why This Fits pdflokal

- Pure vanilla JS — no library, no framework, no build step
- ~15 lines total, lives entirely in state.js
- Doesn't change existing ueState shape
- This IS the core idea behind React, Vue, MobX — stripped to its essence
- Future Claude: search for `subscribe(` and `notify(` to find all wired dependencies

### Before Implementing

- Audit every place ueState.pages / ueState.annotations is mutated
- Map which update functions each mutation currently calls manually
- That map becomes the subscription wiring

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
3. Read `docs/patterns.md` for code conventions
4. Read this file for planned improvements
5. Read `js/lib/state.js` to understand current state shape before touching anything
