# Component contracts (developer-facing)

Every entry: purpose · anatomy · props · content rules · keyboard · screen reader · responsive · RTL.

## PulseTrack
- **Purpose:** make time, state and responsibility physical on one line.
- **Anatomy:** label segment (ink) · 2–6 state segments · current segment (lime, always carries a word
  such as NOW/CURRENT) · optional avatars · optional risk marker · trailing orb action.
- **Props:** `variant` schedule|milestone|request|delivery|client · `segments[]` {id, label, meta, state:
  done|current|next|future|risk, participants[], href} · `orientation` horizontal|vertical ·
  `density` editorial|balanced.
- **Content:** max 6 visible segments; overflow collapses from the oldest done segment. Never more than
  one `current`.
- **Keyboard:** the track is a single tab stop; ← → move between segments; Enter opens the segment.
- **Screen reader:** rendered as an ordered list — "step 2 of 5, current, Homepage direction, committed
  18 August, 1 of 6 items open".
- **Responsive:** < 900px scrolls horizontally with snap; < 640px becomes the vertical step track.
- **RTL:** segment order mirrors (starts right) for interface-flow tracks; a chart-style time axis stays
  LTR and is documented as an exception in `content-and-localization.md`.

## FocusCapsule
- **Anatomy:** lime leading orb (56px) · title · "why now" line · owner avatar · trailing orb.
- **Props:** `title`, `whyNow`, `owner`, `audience`, `href`, `onComplete`.
- **Rules:** exactly one per surface; `whyNow` is required and must reference a date, person or
  dependency — never "important".
- **Motion:** completion sweeps lime across the capsule for 240ms, then the capsule is replaced by the
  next action. Reduced motion: instant swap plus a 120ms fade.

## AudienceHalo
- **Variants:** internal · client visible · client action required · mixed · conflict.
- **Anatomy:** ring + glyph (■ internal, ◎ client, ! action, ≠ conflict) + word + recipient count.
- **Rules:** the fixed copy from file 19 is used verbatim in tooltips and detail views. Colour alone is
  never the carrier; the glyph shape differs per variant.

## GovernedVersionTrack
- **Props:** `versions[]` {label, hash, state, actor, at}, `current`, `invalidatedBy`.
- **Rules:** the version hash is always visible in mono type next to any approve/publish action. An
  approval that no longer matches the current hash renders the invalidated state and disables Approve.

## OpenTable
- **Anatomy:** 34px header row · optional group header with milestone Pulse chip · 38px rows · 3px ink
  left edge on selection · bulk capsule above the table · skeleton row · permission-limited row.
- **Keyboard:** roving tabindex on rows; Space selects; Shift+↑↓ range-selects; ⌘/Ctrl+Enter opens the
  Lens; every inline edit is reachable without a pointer.
- **Screen reader:** row announces type, title, owner, state, committed, forecast, audience, freshness in
  that fixed order.
- **Density:** operational by default; user may switch to balanced (42px rows).

## ContextLens
- **Props:** `mode` pinned|overlay|sheet · `tone` light|dark · `subject`.
- **Rules:** never a permanent third column — it is dismissible, and below 1180px it becomes an overlay,
  below 760px a bottom sheet. Focus is trapped only in overlay/sheet modes and returns to the trigger.

## PublishSafetyCheck
- **Required regions:** recipient list with authority, exclusions list, warnings, true projection preview,
  one primary action. The projection is generated from the client role, not a styled copy.
- **Blocking rule:** if a linked object is internal-only, publication cannot proceed until the link is
  removed or explicitly reviewed.
