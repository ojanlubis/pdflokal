# PDFLokal — Product Definition (v1)

> **Status:** The north-star document. Every product, design, and architecture decision gets measured against this. Written July 2026 out of the "why is the code spaghetti / what is this product" conversation, then grounded in real GA4 + Vercel + Google Ads data. Supersedes the v0.1 draft.
>
> **Reads with:** `memory/product-vision-2026-07.md` (the vision + why, in the founder's words) and `memory/architectural-direction-2026-06-09.md` (the technical foundation that makes this vision buildable). The three must agree.

---

## 1. Mission (the north star)

**Be the WinRAR × Excalidraw of PDF, for Indonesia** — every PDF operation an ordinary Indonesian needs, done entirely in the browser, crafted so well that *using anything else stops making sense.*

- **WinRAR** = ubiquity. The utility everyone just has and uses.
- **Excalidraw** = craft. Browser-native, best-in-class, *loved*.
- We get ubiquity **through** craft — not by having the most features, by having the best *experience* of the features that matter.

**Why this deserves to exist:** PDF is roughly half of an Indonesian knowledge-worker's daily document life, and the incumbents (iLovePDF et al.) are slow and privacy-hostile — they upload your files to a server. We are the opposite by construction.

---

## 2. The moat — the constraint *is* the differentiation

100% client-side is **not** a limitation we tolerate. It is **one architectural choice that pays off four ways at once:**

1. **Private** — files never leave the device. (The whole reason to trust us.)
2. **Fast** — no upload/download round-trip. (Literally why users switch: "iLovePDF is slow because it saves your files.")
3. **Free forever** — no server bill to pass on.
4. **Offline** — works with no connection.

**The moat is structural, not a feature race.** iLovePDF *cannot* copy this without demolishing their own business — their server is load-bearing for their freemium gate and their server-only features (OCR, Word conversion). We are **not a cheaper iLovePDF; we are a structurally different thing they can't become.**

**The discipline that protects the moat:** only build what the browser does *great*. **Refuse** server-jobs (OCR, PDF↔Word) — chasing them would break the moat *and* dilute the craft. Saying no is the strategy.

---

## 3. Who it's for (data-backed, not guessed)

**Primary — the growth user we are literally buying:** a **young Indonesian (18–34), on an Android phone, in Java**, who searched **"gabung pdf"** and needs to **merge — then maybe edit — a document**, fast, free, and private.

**Secondary — the organic base:** desktop visitors arriving via SEO, doing the same jobs.

Grounding (July 2026, see appendix): audience **91% Indonesia**; organic mix **69% desktop / 30% mobile** (Android 23%); **paid acquisition ~95% mobile**, skewing young and slightly female, concentrated in Java. Today's base is desktop (a *lagging* number); the growth we pay for is mobile (a *leading* number). **We build for tomorrow's user, who is on a phone.**

---

## 4. The jobs (data-ranked)

- **Acquisition hook (why they come): MERGE.** "gabung pdf" and its variants dominate search demand and took **92% of our ad clicks**. Merge is the door.
- **In-editor reality (what they do once inside):** add **text** (#1, ~30% of actions, reaches the most people) · **assemble** pages — reorder / delete / rotate / split (~36% combined) · **sign** — signature + paraf (~19%) · **whiteout/redact** (~14%).
- **The insight:** *merge gets them in the door; the editor's breadth is what retains them.* The **mobile merge → edit → download** path is therefore the single most important flow in the entire product.
- Files: **85% PDF**, 15% image.

---

## 5. The strategic bets (stated so we can be deliberately right or wrong)

1. **Unified editor > modular tools.** iLovePDF makes a separate tool per intent and forces a re-upload to switch. But humans don't have "a merge task" and "a reorder task" — they have *"fix this document."* Data confirms it: people merge *and* reorder *and* type *and* sign in one session. Modular models the software; unified models the human. **We bet on the human.** (Cost: harder to build well — see §8.)
2. **Mobile-first.** ⚠️ *The original reasoning here ("the paid growth engine is ~95% mobile") is retired — see the Grounding note; that number is stale AND paid is negative-ROI for a free tool.* **The conclusion survives on stronger ground: mobile is ~half of all real traffic (49%), and the growth channel we're actually betting on — organic/SEO — is where mobile users arrive.** We build for the phone because that's who is there.
3. **SEO-per-intent → editor funnel.** A dedicated, rankable landing page for every intent ("gabung pdf", "kompres pdf", "tanda tangan pdf", …) that delivers *that one job instantly*, then reveals the editor's breadth. **Rule: lead with their intent; breadth is available but never in the way.** (Progressive disclosure at the product level.)

---

## 6. The ONE interaction model (how it must feel)

The mental model is **"a document you can touch."** A vertical stack of pages you scroll; pick a **tool** (a verb) to act; **directly manipulate** objects. Every screen, desktop and mobile, obeys the same eight rules:

1. **Direct manipulation.** Tap to select, drag to move, handles to resize. No hidden modes.
2. **What you're touching is always on top.** An annotation being moved/edited floats above every page and bar — *always*. (The bug we keep hitting is a violation of *this*, not a CSS typo.)
3. **Selection is a real object, never a mode or an index.** It survives scroll, reorder, undo.
4. **Tools are verbs; Select (Pilih) is home.** A tool does its one thing, then returns to Select. (Whiteout is the honest multi-stamp exception.)
5. **Mobile and desktop are the same model, different ergonomics.** Same objects, same gestures. Touch targets ≥44px. **Nothing hover-only, ever.**
6. **Every action reversible; confirm only the irreversible.** A confirm dialog is a failure of undo.
7. **Progressive disclosure.** 3–5 primary verbs visible; the rest in "Lainnya." A crowded toolbar is a bug.
8. **Plain, self-evident Indonesian, casual "kamu."** Labels you don't decode.

**The feeling:** calm, fast, trustworthy. The document is the hero; the UI recedes. Lighter than desktop PDF software, and *safe* ("nothing leaves my phone").

---

## 7. What PDFLokal is NOT

- **Not a server tool.** No OCR, no PDF↔Word, no cloud — they break the moat. Permanent no.
- **Not Canva/Figma.** Document *utility*, not creative canvas. (We borrow their interaction *polish*, not their scope.)
- **Not a viewer.** Drive views; we edit.
- **Not for power users.** When simplicity and a power feature conflict, simplicity wins.

---

## 8. The uncomfortable truth (vision ⇄ architecture are one bet)

"UX is everything" and "the best client PDF tool in the world" are **impossible on the current architecture** — one where annotations slide behind pages and mobile canvases get purged. **The unified-editor bet (§5.1) and the June-9 foundation rebuild are the *same bet*.** You cannot out-craft iLovePDF on a foundation that fights you.

Therefore the foundation work is **not a detour from the vision — it is the vision's price of entry.** And because ~95% of acquisition is mobile: **every mobile bug is a leak in a bucket we pay to fill.** That's the urgency.

---

## 9. Interaction invariants (the bridge from product → code)

Hold these in code and the spaghetti becomes structurally impossible. They line up 1:1 with `architectural-direction-2026-06-09.md`:

1. **One document model = one source of truth.** Not `pages` + `pageCanvases` + DOM canvases + annotation arrays + PDF.js docs all pretending to be the truth.
2. **A page is a picture; annotations are a layer above it; the active object is top-most.** (Rasterize-on-import `<img>` + one overlay — this is §6.2 enforced in code.)
3. **Objects are referenced, never indexed.**
4. **One interaction model → one set of input handlers,** shared by mobile and desktop.
5. **Every mutation goes through one operation path** (mutate → re-render). No UI code touching state directly.
6. **The domain core is headless** — model + operations + import (PDF.js) + export (pdf-lib) must run with no DOM. If it emits a correct PDF in Node, the front/back separation is real.

---

## 10. Success

When a PDFLokal user, offered iLovePDF, thinks: *"Why would I upload my file to a server and wait?"* — **using anything else has stopped making sense.** That moment, at scale, is the win.

---

## 11. Next (what this doc unlocks)

- **Instrument GA4** — register `tool` / `action` / `fileType` as custom dimensions so it stops mis-reporting (it currently counts bots as US desktop; Vercel is the truth today).
- **Design the SEO intent-page → editor architecture** (later phase).
- **Begin foundation Phase 1** (`architectural-direction-2026-06-09.md`) — the enabling work for everything above.

---

## Appendix — the data behind this (July 2026)

**Trust Vercel over GA4 for audience/device.** GA4 reported "37% US / 13% mobile" — that was **bots**. Vercel (edge-counted) shows the truth.

- **Audience:** Indonesia **91%** (Vercel). Java-concentrated (Ads map).
- **Device (organic):** Desktop **69%**, Mobile **30%** (Android 23%, iOS 7%), Tablet 1%.
- **Device (paid acquisition):** ~~**~95% mobile** (bid +90% on mobile deliberately).~~ ⚠️ **STALE — that's April's campaign, which carried a +90% mobile bid adjustment.** The July campaign measured **58% mobile** by clicks. **Site-wide reality (Vercel, Jul 2026): 49% mobile / 46% desktop / 5% tablet, 94% Indonesia.** And paid is now understood to be **negative-ROI by construction for a free product** — a conversion is worth Rp0. **Mobile-first still holds, on better grounds: mobile is half the actual user base, and the growth channel is organic/SEO, not paid.**
- **Demographics (Ads):** 18–34, slight female skew.
- **Tools opened:** unified-editor **75%**; every standalone tool <8% each → *the editor is the product.*
- **In-editor actions:** text_inline 30% · signature 15% · reorder 14% · whiteout 14% · delete_page 8% · rotate 8% · split 6% · paraf 4%.
- **Files:** PDF 85% / image 15%.
- **Acquisition:** SEO-led (google.com dominates referrers); ad search demand = "gabung pdf" and variants; CTR 14–20%, CPC ~Rp108 (cheap, high-intent).
- **Retention:** ~84% new / 14% returning; returning users average ~3.7 sessions. Mostly "one job and leave," with a small loyal core.
