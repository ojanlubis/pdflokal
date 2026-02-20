# PDFLokal Architecture: SSOT Patterns

This document explains PDFLokal's centralized (SSOT) architecture for object creation, state management, and shared logic. These patterns were introduced in Feb 2026 to replace scattered, error-prone duplication.

---

## 1. Current Architecture: Centralized SSOT Helpers

### 1a. Page Object Factory — `createPageInfo()` (state.js)

A single factory in `js/lib/state.js` is the only way to create page objects. All callers get a guaranteed shape with defaults.

```mermaid
flowchart TB
    subgraph FACTORY["SINGLE SOURCE OF TRUTH"]
        CF["<b>createPageInfo()</b><br/><code>createPageInfo({<br/>  pageNum, sourceIndex,<br/>  sourceName, rotation,<br/>  canvas, thumbCanvas,<br/>  isFromImage<br/>})</code><br/><br/>Returns complete object<br/>with ALL fields + defaults"]
    end

    subgraph CALLERS["ALL CREATORS USE THE FACTORY"]
        direction TB
        C1["file-loading.js<br/>handlePdfFile()<br/><code>createPageInfo({...})</code>"]
        C2["file-loading.js<br/>handleImageFile()<br/><code>createPageInfo({...})</code>"]
        C3["undo-redo.js<br/>ueRestorePages()<br/><code>createPageInfo({...})</code>"]
    end

    subgraph CONSUMERS["CONSUMERS (unchanged)"]
        direction TB
        CS["sidebar.js"]
        CM["mobile-ui.js"]
        CP["page-manager.js"]
        CR["page-rendering.js"]
        CE["pdf-export.js"]
    end

    C1 -->|calls| CF
    C2 -->|calls| CF
    C3 -->|calls| CF

    CF -->|guaranteed shape| CS
    CF -->|guaranteed shape| CM
    CF -->|guaranteed shape| CP
    CF -->|guaranteed shape| CR
    CF -->|guaranteed shape| CE

    style FACTORY fill:#dfd,stroke:#393,stroke-width:3px
    style CALLERS fill:#eff,stroke:#39c,stroke-width:2px
    style CONSUMERS fill:#eff,stroke:#39c,stroke-width:2px
```

**Adding a new field** (e.g., `locked: false`): change `createPageInfo()` once. All creators and consumers automatically get the field with its default value.

### 1b. Centralized State Defaults — `getDefaultUeState()` (state.js)

Returns the full default shape for `ueState`. Both the initial definition and `ueReset()` reference it via `Object.assign()`:

```mermaid
flowchart TB
    subgraph DEFAULTS["SINGLE SOURCE OF TRUTH"]
        GD["<b>getDefaultUeState()</b><br/><code>return {<br/>  pages: [],<br/>  sourceFiles: [],<br/>  selectedPage: -1,<br/>  currentTool: null,<br/>  annotations: {},<br/>  ...<br/>  zoomLevel: 1.0<br/>}</code>"]
    end

    subgraph USERS["ALL CLEANUP POINTS USE DEFAULTS"]
        direction TB
        U1["<b>state.js</b><br/>Initial ueState definition<br/><code>Object.assign(ueState,<br/>getDefaultUeState())</code>"]
        U2["<b>lifecycle.js ueReset()</b><br/><code>Object.assign(ueState,<br/>getDefaultUeState())</code><br/>+ cleanup side effects"]
        U3["<b>tools.js ueSetTool()</b><br/>Uses named subsets:<br/><code>getSignatureDefaults()</code>"]
    end

    GD --> U1
    GD --> U2
    GD --> U3

    style DEFAULTS fill:#dfd,stroke:#393,stroke-width:3px
    style USERS fill:#eff,stroke:#39c,stroke-width:2px
```

**Adding a new state field:** add it to `getDefaultUeState()` once. `ueReset()` automatically clears it. No manual sync needed. Fields with special cleanup (like `pageObserver.disconnect()`) still need explicit handling in `ueReset()`, but the value reset itself is centralized.

### 1c. Centralized Thumbnail Resolution — `getThumbnailSource()` (canvas-utils.js)

A single function resolves the best canvas for thumbnail rendering, used by all 3 UI surfaces:

```mermaid
flowchart TB
    subgraph HELPER["SINGLE SOURCE OF TRUTH"]
        GT["<b>getThumbnailSource(pageIndex)</b><br/><code>const real = ueState.pageCanvases[i];<br/>if (real?.rendered && real.canvas<br/>    instanceof HTMLCanvasElement)<br/>  return real.canvas;<br/>return ueState.pages[i].thumbCanvas;</code><br/><br/>Returns the best available canvas"]
    end

    subgraph CALLERS["ALL CALLERS USE THE HELPER"]
        direction TB
        CA["sidebar.js<br/>ueRenderThumbnails()"]
        CB["mobile-ui.js<br/>ueMobileOpenPagePicker()"]
        CC["page-manager.js<br/>uePmRenderPages()"]
    end

    CA -->|calls| GT
    CB -->|calls| GT
    CC -->|calls| GT

    style HELPER fill:#dfd,stroke:#393,stroke-width:3px
    style CALLERS fill:#eff,stroke:#39c,stroke-width:2px
```

### 1d. Annotation Factories (state.js)

Five factory functions ensure consistent annotation shapes across the codebase:

```mermaid
flowchart TB
    subgraph FACTORIES["ANNOTATION FACTORIES (state.js)"]
        direction TB
        F1["<b>createWhiteoutAnnotation</b><br/><code>{ x, y, width, height }</code>"]
        F2["<b>createTextAnnotation</b><br/><code>{ text, x, y, fontSize,<br/>color, fontFamily, bold, italic }</code>"]
        F3["<b>createSignatureAnnotation</b><br/><code>{ image, imageId, x, y,<br/>width, height, cachedImg,<br/>locked, subtype }</code>"]
        F4["<b>createWatermarkAnnotation</b><br/><code>{ text, fontSize, color,<br/>opacity, rotation, x, y }</code>"]
        F5["<b>createPageNumberAnnotation</b><br/><code>{ text, fontSize, color,<br/>x, y, position }</code>"]
    end

    subgraph CALLERS["CALLERS"]
        direction TB
        CE["canvas-events.js"]
        TM["text-modal.js"]
        SIG["signatures.js"]
        WM["watermark-modal.js"]
        PN["pagenum-modal.js"]
    end

    CE -->|whiteout| F1
    TM -->|text| F2
    SIG -->|signature/paraf| F3
    WM -->|watermark| F4
    PN -->|page numbers| F5

    style FACTORIES fill:#dfd,stroke:#393,stroke-width:3px
    style CALLERS fill:#eff,stroke:#39c,stroke-width:2px
```

### 1e. Additional SSOT Helpers

| Helper | Location | Purpose |
|--------|----------|---------|
| `openModal(id)` / `closeModal(id, skip)` | navigation.js | Standard modal open/close with `.active` class + history management |
| `isPDF(file)` / `isImage(file)` | utils.js | File type validation (replaces inline `file.type ===` checks) |
| `loadPdfDocument(bytes)` | utils.js | PDF.js document loading with defensive `.slice()` (replaces raw `pdfjsLib.getDocument()`) |

---

## 2. Historical Context: The Scattered Patterns (Before SSOT)

The SSOT helpers above were introduced to solve three categories of scattered, error-prone code. This section documents the original problems for context.

### 2a. Page Object Creation Was Scattered (3 locations)

Before `createPageInfo()`, every place that created a page object manually built the same shape. The undo-redo path used `{ ...pageData }` spread which silently dropped fields like `isFromImage`.

### 2b. State Cleanup Was Scattered (2 locations)

Before `getDefaultUeState()`, `ueReset()` manually listed 20+ field assignments that had to stay in sync with the initial `ueState` definition in `state.js`. Missing a field meant stale state across sessions.

### 2c. Thumbnail Resolution Was Copy-Pasted (3 files)

Before `getThumbnailSource()`, three files (sidebar.js, mobile-ui.js, page-manager.js) each had identical 4-line canvas resolution logic. A fix in one file but not the others caused inconsistent thumbnails.
