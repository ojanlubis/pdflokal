# Editor UI Design: "Document Viewer with Annotation Superpowers"

> Implemented Feb 2026. This document describes the current editor layout and the design rationale behind it.

## Design Rationale

PDFLokal's editor needed to balance two competing needs:
1. **Quick tasks** (sign, add text, download) — 30 seconds to 2 minutes
2. **Document management** (reorder, rotate, split, merge) — a first-class feature

The old layout used ~200px of vertical chrome before the canvas. The redesign reduced this to ~70px (40px header + 30px bottom bar), making the document the hero.

**Reference:** Canva's editor approach — compact header, floating toolbar, body scroll, always-visible sidebar.

---

## Current Layout

### Desktop (>900px)

```
+----------------------------------------------------------+
| [File v]  PDFLokal                    [moon] [Download]  |  ~40px  editor header
+----------+-----------------------------------------------+
| SIDEBAR  |                                               |
| (compact |   [ Sign | Text | Whiteout | Rotate | More ] |  floating (frosted glass)
| rect     |                                               |
| thumbs)  |     +-----------------------------+           |
|          |     |                             |           |
|  [pg 1]  |     |        PDF PAGE 1           |           |
|  [pg 2]  |     |                             |           |
|  [pg 3]  |     +-----------------------------+           |
|          |                                               |
|          |     +-----------------------------+           |
|          |     |        PDF PAGE 2           |           |
|          |     +-----------------------------+           |
|          |                                               |  body scroll
+----------+-----------------------------------------------+
|                  Dukung Kami        [- Zoom +] Hal 2/5 [?]|  ~30px  bottom bar
+----------------------------------------------------------+

Chrome: ~40px top + ~30px bottom = ~70px total
Sidebar: 160px compact Canva-style
Document: fills remaining space, scrolls naturally
```

### Mobile (<=900px)

```
+------------------------------------------+
| [File v]  PDFLokal       [moon] [Down]  |  ~36px  compact header
+------------------------------------------+
|                                          |
| [Sign|Text|White|Sel|Rot|More]          |  icon-only toolbar (fixed)
|                                          |
|     +----------------------------+       |
|     |                            |       |
|     |       PDF PAGE 1           |       |
|     |                            |       |
|     +----------------------------+       |
|                                          |  body scroll
|     +----------------------------+       |
|     |       PDF PAGE 2           |       |
|     +----------------------------+       |
|                                          |
+------------------------------------------+
| [< Hal 2/5 >] [More v] [Zoom -/+] [Sign]|  ~60px  mobile bottom bar
+------------------------------------------+
```

**Mobile differences:**
- Sidebar hidden
- Toolbar uses icons only (no labels), fixed position
- Header shrinks to 36px
- Desktop bottom bar hidden, replaced by 60px mobile bottom bar
- Mobile bottom bar: page navigation, tools dropdown, zoom controls, quick signature access
- Breakpoint: 900px (aligned with sidebar hide)

---

## Layout Components

### Layer 1: Editor Header Bar (~40px desktop, ~36px mobile)

```
[File v]  PDFLokal  ·······························  [moon] [Download PDF]
```

| Element | Purpose |
|---------|---------|
| **[File v]** | Dropdown: Tambah File, Ganti File, Kelola Halaman |
| **PDFLokal** | Brand text, clickable -> home (with unsaved work warning) |
| **[moon]** | Dark mode toggle, small icon |
| **[Download PDF]** | Primary action, always visible, prominent |

### Layer 2: Sidebar (160px, desktop only)

- Compact left panel with small rectangle page thumbnails
- "Kelola Halaman" button opens page manager modal
- Thumbnails rendered via `getThumbnailSource()` SSOT helper
- Drag-drop reorder directly in sidebar
- Sticky positioning, fills height below header

### Layer 3: Floating Toolbar (frosted glass)

```
      [ Sign | Text | Whiteout | Pilih | Rotate | More v ]
```

- Full-width, sticky below header (top: 40px)
- Frosted glass / semi-transparent background
- Dark mode: changes tint color to match theme
- Mobile: icon-only, fixed position

**[More v] dropdown includes:**
- Paraf (Initials)
- Watermark
- Nomor Halaman
- Kunci PDF (Protect)
- Undo / Redo
- Clear Annotations

### Layer 4: Document Area

- Pages scroll naturally (body scroll = document scroll)
- No fixed wrapper height — pages stack and flow
- Pages centered in available width (sidebar + document)
- Gap between pages for visual separation
- `scroll-snap-type: y proximity` on pages
- IntersectionObserver (`root: null`) for lazy rendering

### Layer 5: Bottom Bar

**Desktop** (~30px, fixed bottom):
```
|                       Dukung Kami              [- Zoom +]  Hal 2/5  [?] |
```

**Mobile** (~60px, fixed bottom):
```
| [< Hal 2/5 >]  [More v]  [Zoom -/+]  [Sign] |
```

---

## Mobile-Specific Features

- **Pinch-to-zoom:** 2-finger touch detection in canvas-events.js, 30px distance threshold
- **Inline text editing:** 300ms blur delay on mobile to prevent accidental saves from keyboard dismiss. `visualViewport.resize` scrolls editor into view when virtual keyboard opens
- **Double-tap:** Unlock locked signatures (300ms + 30px detection thresholds)
- **Touch events:** Conditional `preventDefault` — only when tool is active or annotation is hit (preserves scroll)
- **Page navigation:** Prev/Next buttons in mobile bottom bar

---

## Design Decisions

| Question | Decision |
|----------|----------|
| Floating toolbar position | Full-width, sticky below header, always visible |
| Floating toolbar style | Frosted glass / semi-transparent |
| Dark mode interaction | Toolbar changes tint color |
| Rotate placement | In floating toolbar (not buried in More) |
| Zoom placement | Bottom bar, right side |
| Page indicator | Bottom bar, right side (Hal 2/5) |
| Sidebar | Always visible on desktop, hidden on mobile |
| Dukung Kami | Bottom bar, centered, subtle/ghosted (desktop only) |
| Keyboard shortcuts | [?] button in bottom bar, rightmost |
| Undo/Redo buttons | In [More] dropdown (Ctrl+Z/Y is primary) |
| Brand click -> home | Yes, with unsaved work warning |
| Browser back | Same behavior as current |
| Escape key | Closes modals, then goes home |
| Site header in editor | Replaced entirely by editor header |
| Site footer in editor | Replaced entirely by bottom bar |
| Mobile breakpoint | 900px (same as sidebar hide) |
| Mobile bottom bar | 60px, page nav + tools + zoom + sign |
