# TManage — Visual Reference Analysis (Phase 0)

**Reference inspected:** uploaded image, packaged locally as `assets/references/TManage-primary-visual-reference.webp`.
**Status:** image inspected visually. Direction: Limeframe — Neo-Editorial Work OS (file 39).
**Planning root loaded from workspace:** `TManage-Planning-Pack/`

Files read for this phase: `00-README.md`, `39-TMANAGE-COMPLETE-DESIGN-BIBLE.md`,
`40-DESIGN-SYSTEM-TOKENS-AND-COMPONENTS.md`, `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX.md`,
`45-DESIGN-QUALITY-GATE-AND-CRITIQUE-RUBRIC.md`, `47-PRIMARY-VISUAL-REFERENCE-ANALYSIS.md`,
`19-SEED-DATA-AND-COPY.md`, `contracts/design/tokens.foundation.json`.

## 1. What I actually see in the image

**Palette.** Four fields do all the work: near-black (nav orb, top track shell, primary capsule,
overlapping right panel), a warm off-white/concrete plane for the whole canvas, pure white for content
cards, and one acid lime that appears in exactly two places — the live schedule segment and one featured
task card. Semantic color is a few pixels wide: small red/green delta chips beside the numbers, a red
end-call orb. Roughly 80% neutral, 15% lime, 5% everything else.

**Type.** One geometric sans throughout, driven by scale rather than colour. The page word ("WORKSPACE")
is set at roughly 5× the metadata size, wide-tracked, uppercase, sitting on the same baseline as a small
black capsule button. Numerals (34 / 20 / 3) are display-scale with a small lowercase word underneath —
figure and meaning are a pair, never a bare KPI. Body/metadata falls to ~12–14px and stays quiet.

**Geometry.** Only two shapes exist: the capsule (999px) and the large-radius rectangle (~24–32px).
Circles appear at 40/48/56px as controls — nav, expand, filter, media, call. No small radii anywhere.

**Grid and composition.** Alignment is disciplined: track, title, filter row and card row all start on the
same left edge; the card row runs off the right edge under the overlapping panel, which reads as
continuation rather than truncation. Asymmetry comes from a single offset element (the back-orb hanging
left of the title, the schedule capsule inset from the rail) not from random placement.

**Depth.** Almost no shadow. Depth is made by plane contrast and overlap: dark panel over light canvas,
media card over dark panel, card row sliding under panel edge. Nothing is blurred or glassy.

**Whitespace.** The first third of the composition is title, numbers and air. Density only arrives at the
card rows, and even there the cards are broad and low with generous internal padding.

**The track.** The strongest element on screen is a horizontal capsule of time: a black label segment,
then proportional segments per event, avatars clipped into the segments, a hairline "now" marker with a
time flag, an outlined future segment. It makes time physical.

**Avatars.** Small, circular, always attached to a thing that has an owner or participants. Never a
decorative face pile.

**Cards.** One card is lime and it is the one you are supposed to act on. Every other card is white with
the same anatomy — identity, title, timing, a status control, one or two orb actions.

## 2. Adopt

- Ink / warm paper / concrete / acid-lime four-field palette; lime concentrated, never sprinkled.
- One geometric sans (Manrope; Alexandria for Arabic) with 4–5× scale jumps between display and metadata.
- Capsule + large-radius rectangle + circle as the only shape vocabulary.
- Display numerals paired with plain-language meaning.
- The horizontal time/state track as a first-class product element → **Pulse Track**.
- Black capsule = decisive primary action; lime = current/next/forward; circle = icon control.
- Dark overlapping panel for context/summary, over a light canvas → **Context Lens**.
- One lime focal card among quieter white cards → **Focus** work card.
- Depth via plane contrast, overlap and 1–1.5px ink outline; shadow only for true overlays.
- Avatars as evidence of responsibility, clipped small into the information.

## 3. Adapt

- **Track → Pulse Track grammar** with five variants (schedule, milestone, request, delivery version,
  client journey) plus a mandatory ordered text equivalent for screen readers.
- **Lead cards → Work Object DNA cards**: type, title, owner, next action, committed vs forecast date,
  state capsule, Audience Halo. No sales vocabulary.
- **Vanity counters → Editorial Metrics** tied to delivery decisions: days to committed milestone,
  approval wait time, blocked commitments. Max three per region, each with source and drill-down.
- **Left orbs → Orbital Rail** with always-available labels (the reference relies on icon recognition;
  that fails WCAG 2.2 and Arabic, so labels are added at 9–10px and expand on hover/focus).
- **Video panel → dark Context Lens / Meeting Companion**, dismissible and never permanent chrome.
- **One expressive screen → three densities**: editorial (overview, client, onboarding), balanced
  (project, docs, detail), operational (lists, audit, admin) sharing type, palette, orbs, capsules, line.
- **Lime featured card → single focal field rule**: at most one dominant lime field per viewport, except
  connected Pulse Track segments.

## 4. Do not copy

- The CRM screen itself: its logo, its composition, "Leads / Deals / won / lost" vocabulary, its people
  as sales prospects, its Google Meet arrangement, its exact icon set and positions.
- The permanent video call panel on every screen.
- Photographic stock faces as filler (avatars are initials placeholders until real assets are supplied).
- The "hot client" flame/heat metaphor — TManage never gamifies or scores people.
- Putting every table, form or list inside a white card.

## 5. Deliberate deviations from the reference (with reason)

| Deviation | Reason |
|---|---|
| Rail orbs carry permanent text labels | WCAG 2.2 AA, first-run comprehension, long Arabic labels |
| Lime segments always pair with text state ("Now", "Current") | Colour alone cannot carry meaning |
| Metric deltas get a word, not only an arrow chip | Screen-reader and colour-blind parity |
| Cards use 1px `line.300` outline on white | Card edge survives high-contrast mode and print |
| Operational screens drop to 18px radius and 36px rows | Reference has no dense-data case; 200-row test must hold |
| Ink text on lime, never white | Contrast: white on `#B7FF57` fails; ink passes at 12.9:1 |

## 6. Assumptions and open risks

1. Client logos are still absent; avatars are initial orbs by design; deliverable previews use stock
   photography from `design/assets/img/`.
2. Satoshi (display/UI) + Manrope (paragraphs) + Alexandria assumed an accessible trio; Arabic display sizes reduced ~10% and
   line height increased 12% — needs a native-Arabic reader review.
3. Lime as a large focal field on dark surfaces glares; dark theme uses `#A9ED55` and smaller fields.
4. Pulse Track proportional segments compress badly below 400px; mobile switches to a vertical step track.
5. 172-screen matrix is designed as templates + mapped compositions; low-risk IDs inherit a template.
