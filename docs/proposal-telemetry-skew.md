# Proposal — make schema rejections visible before choosing strict or tolerant

**Status: PROPOSAL. Not implemented. `api/` code, so it is Fauzan's batch.**
Written by the bench 2026-08-09 at the PM's request. Two steps, in order, and the second is
conditional on what the first measures.

---

## The defect

`js/core/telemetry-schema.js` is imported by **both** ends of the rail:

- the client, at `js/v2/telemetry.js:147`
- the server, at `api/t.js:30` — and `api/t.js:135` is `if (!ok) continue`

`validateEvent` fails the **whole event** on an unknown prop *or* a missing declared prop, and
`validateProp` has no optional marker in its vocabulary (`bool` · `int` · `duration` · enum-array).
So a schema change breaks version skew in **both directions**:

| change | who breaks | what is lost |
|---|---|---|
| **add** a prop | clients still running the old bundle omit it → missing declared prop | the whole event |
| **remove** a prop | clients still running the old bundle still send it → unknown prop | the whole event |

PDFLokal is an installable PWA, so "old client" means **a cached install that has not picked up the
new JS**, not a stale tab. There is no upper bound on how long one of those persists.

### It is not hypothetical — it is live

`2e9fa47` (shipped 2026-08-09 17:45) added `class: UNSUPPORTED_CLASS` and `blocked: 'bool'` to the
`failure` event. Both are required. It updated every emit site in the same commit, which is correct
for new clients — and is exactly what strands the old ones:

```js
// what a pre-2e9fa47 cached client still sends
tel('failure', { stage: 'import', reason: 'encrypted' })
// -> missing declared prop `class` -> { ok: false } -> dropped, silently
```

The proposed deletion of `surgery_used`/`fallback` (bench commit `7c2a064`, **held**) is the same
defect pointing the other way. The removal case was found first; the addition case had already
shipped.

### The magnitude is unmeasurable, and that is the actual finding

The PM checked 30 hours of hourly buckets: `failure` events run **0–1 per hour**, and
`props ? 'class'` is **0 in every bucket, including after the push**. At that base rate a dropped
event and an event that never happened are **indistinguishable**.

That is the point. `if (!ok) continue` is silent by construction, so this class of loss can only ever
appear as an absence — and this project has a name for that: **a missing thing looks identical to a
perfect thing.** We cannot currently answer "how much are we dropping?" with anything but a shrug.

---

## Step 1 — count the rejections (do this first, on its own)

Make `api/t.js` record what it throws away, instead of only what it keeps.

At minimum, per rejected event: **the event name** and **why** — distinguishing
`unknown-prop` from `missing-prop` from `bad-value` / `unknown-event`, because they mean different
things. `unknown-prop` and `missing-prop` are almost always **version skew**; `bad-value` is almost
always **our bug**.

This requires `validateEvent` to return a reason rather than a bare `{ ok: false }`. That is an
additive change to its return shape; every existing call site reads only `.ok` and `.clean`, so
nothing else has to move.

Where the count goes is an open question for whoever implements it — a counter row, a log line
`api/t.js` already has precedent for (`console.error('[telemetry] insert REJECTED …')`), or a
`rejected` event on the rail itself. **Not a decision this proposal should make.**

**Why first, and why alone:** until the rate is visible, choosing between strict and tolerant means
inventing a threshold from nothing. With it, the choice makes itself — and if the rate really is
~0, Step 2 is unnecessary and the schema stays strict and honest.

---

## Step 2 — tolerate-and-strip, **only if Step 1's numbers justify it**

If rejections turn out to be material, relax the two skew-shaped failures and keep the rest:

- **unknown prop** → drop the prop, keep the event
- **missing declared prop** → keep the event without it (needs the row to tolerate absent props)
- **bad value / wrong type / unknown event** → still reject the whole event, unchanged

That would make prop additions and removals single-release changes instead of two-release ones.

**The cost is real and should not be waved through:** a partially-recorded event is a row that looks
complete and is not, which is the shape this project keeps getting wrong. Any implementation needs
the stripped props to be *visible* in the row, not silently absent — otherwise Step 2 trades a
countable loss for an invisible one, and we are back where we started.

---

## The tension, stated and deliberately not resolved

`validateEvent`'s own comment says:

> *"a bad call site should be loud, not silently half-recorded"*

**That is right, and it is why the strictness exists** — to catch **our** bugs, at the moment we
write them.

But version skew is **not our bug**. It is the correct behaviour of a client we shipped weeks ago,
doing exactly what it was told.

**Same rule, two populations, and the current code cannot tell them apart.** Strictness protects us
from ourselves and punishes us for shipping. Whichever way this is ruled, that trade is the thing
being ruled on — not "strict vs lenient" in the abstract.

One asymmetry worth weighing: a *loud* failure from our own bad call site is caught in the gate,
before a user ever sees it. A *silent* failure from version skew is caught by nobody. The two
populations do not have equal need of the same instrument.

---

## Until this is ruled

- Bench commit `7c2a064` (delete `surgery_used`/`fallback`) is **held**, per the PM. The fields lie,
  but at current volume they lie quietly, and shipping the deletion first buys a data hole to close
  a cosmetic one.
- **Any future schema edit is a two-release change**: tolerate first, tighten after clients roll.
- Before shipping any schema edit, simulate the skew explicitly — this is one line and it would have
  caught `2e9fa47`:

```js
validateEvent('<event>', <the payload the CURRENTLY DEPLOYED client sends>).ok  // must be true
```
