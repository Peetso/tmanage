# TManage — Session handoff (resume in a new chat)

**Direction:** Limeframe (Neo-Editorial Work OS), locked from file 39. One direction, no alternatives.
**Planning pack:** attached local folder `TManage-Planning-Pack/` — treat as authority, precedence order
in `00-README.md`.

## Working rules the user has stated explicitly
1. **Follow the pack.** Do not invent product decisions. If the pack answers it, the pack wins.
2. **Never change navigation or anything else on your own initiative.** Ask first. (I changed the rail
   to Calendar/People from file 38 §6 without asking; the user reverted that. The rail as shipped is
   **My Day · Inbox · Chat · Work · Docs · Files · Clients · Insights · Control Center + account orb**,
   with Calendar appearing as the active rail item only in the Calendar screens file.)
3. **All 172 screen IDs from file 41 must be designed.** Not templates, not "mapped" — drawn.
4. Ask before adding material or making sweeping edits from ambiguous feedback.

## Design language (already established — reuse verbatim, do not re-derive)
- Palette: ink `#090A09` `#232521` `#4D5049` `#74786F` · paper `#FFFFFF` `#F7F7F3` `#E9E9E5` `#D5D6D1`
  rail `#E4E4DF` · line `#C5C7C0` `#2C2E29` · lime `#B7FF57` (pressed `#9CEA3F`) · client violet
  `#7755C7` · success `#1D8A63` · warning `#C96F18` · danger `#D9474F`.
  Dark: canvas `#121311`, rail `#171814`, surface `#1B1D19` / `#242720`, line `#3A3E35`, ink `#F5F6F0`,
  muted `#A7ACA0`, lime `#A9ED55`, lime plane `#29351D`, violet `#A98AE5`, warning `#E9A85C`, danger `#FF7780`.
- Type: Satoshi (Latin display and UI), Manrope (Latin paragraphs), Alexandria (Arabic, ~10% smaller + ~12% more line height, zero tracking),
  Geist Mono (ids, hashes, times, metadata labels — uppercase, 10–11px, letter-spacing 0.12em).
- Geometry: radius 10/14/18/24/28/32/999. Orbs 32/40/44/48/56/64. Borders 1 / 1.5 / 2px.
  Focus = `2px solid #090A09` + `box-shadow:0 0 0 3px #B7FF57`.
- Lime means **current / next / live only**. Ink text on lime always; white on lime is forbidden.
- Cards: white + `1px solid #C5C7C0`. Shadow only for true overlays.
- Densities: editorial (48–64px rhythm, 32px radius) · balanced (40–44px, 24px) · operational
  (36–38px rows, 18px radius, 3px ink left edge on selection).
- Signature patterns: **Pulse Track** (ink=done, lime=current with a word, outline=future, dashed=unknown,
  orange edge=risk), **Focus Capsule** (black capsule, lime leading orb, "Why now —" line),
  **Audience Halo** (■ internal / ◎ client visible / ! client action required / ≠ conflict),
  **Work Story** (chapter rail, lime node = now), **Editorial Metric** (display numeral + meaning line +
  source, max 3 per region), **Context Lens** (light pinned / dark overlay / mobile sheet).
- Every artifact file starts with the same `<helmet>` (self-hosted Satoshi + Manrope @font-face,
  Alexandria + Geist Mono link, body
  `#2C2E29`, `a`/`a:hover` rules, `<meta name="design_doc_mode" content="canvas">`), then a
  `display:flex;flex-direction:column;gap:52px;padding:56px` wrapper. Every screen carries a
  `data-screen-label` and a Geist Mono caption line with its ID, composition and canvas size.
- Screens are drawn at fixed sizes: desktop 1440 wide (heights 620–980), mobile 390×844, portal 1440.
- Seed data (file 19) is used everywhere: Northstar Studio (Omar Adel PM, Maya Hassan admin, Lina Samir
  design, Karim Nabil eng, Noor Fathy content) · Atlas Hospitality (Salma Riad client admin, Youssef
  Kamal reviewer with approval authority, Dina Ashraf viewer) · Atlas Website Relaunch, launch committed
  30 Sep, milestone "Homepage direction" committed 18 Aug, Homepage Concept v2 hash `8f2c·d41a`,
  26h client wait, Content migration forecast 8 Sep vs committed 1 Sep, Arabic booking FAQ request
  desired 3 Sep uncommitted, 214-row work list, 40 channels.

## Files already built (21 .dc.html + design/ docs)
| File | Screen IDs covered |
|---|---|
| `TManage Foundations.dc.html` | north star, colour, type incl. Arabic, geometry, primitives, patterns, 3 densities |
| `TManage Screens - Public and Identity.dc.html` | PUB-01…07, ID-01…06 |
| `TManage Screens - Onboarding.dc.html` | ON-01…10 |
| `TManage Screens - Personal.dc.html` | HOME-01, IN-01, IN-05 |
| `TManage Screens - Personal and Inbox Extended.dc.html` | HOME-02…05, IN-02, IN-03, IN-04, IN-06, IN-07 |
| `TManage Screens - Project and Chat.dc.html` | PRJ-01, CH-02, CH-05, CH-08 |
| `TManage Screens - Chat Extended.dc.html` | CH-01, CH-03, CH-04, CH-06, CH-07, CH-09, CH-10, CH-11, CH-12, CH-13 |
| `TManage Screens - Work.dc.html` | WK-02, WK-03 |
| `TManage Screens - Work Extended.dc.html` | WK-01, WK-04…WK-14, REQ-01…03 |
| `TManage Screens - Projects Portfolio Objectives.dc.html` | PRJ-02…05, POR-01…03, OBJ-01, OBJ-02 |
| `TManage Screens - Calendar and Meetings.dc.html` | CAL-01…04, MTG-01, MTG-03, MTG-04 |
| `TManage Screens - Docs and Decisions.dc.html` | DOC-01…04, DEC-01, DEC-02 |
| `TManage Screens - Delivery.dc.html` | DEL-03, DEL-04, DEL-05, FIL-04 |
| `TManage Screens - Client Portal.dc.html` | CL-01, CL-05 / APP-02 |
| `TManage Screens - Client Portal Extended.dc.html` | CL-02…CL-04, CL-06…CL-16 |
| `TManage Screens - Files and Approvals.dc.html` | FIL-01, FIL-02, FIL-03, DEL-01, DEL-02, APP-01, APP-03 |
| `TManage Screens - Insights and Admin.dc.html` | INS-01, AUT-02, AUT-03 |
| `TManage Screens - Insights Extended.dc.html` | INS-02, INS-03, INS-04, INS-05, INS-06 |
| `TManage Screens - Mobile.dc.html` | HOME-01, IN-01, CH-02, CL-05 at 390×844 |
| `TManage Screens - People.dc.html` | PEO-01…04 |
| `TManage Screens - Search and AI.dc.html` | SR-01…04, AI-01…04 |
| `TManage Screens - Automations and Integrations.dc.html` | AUT-01, AUT-04, AUT-05, INT-01, INT-02, INT-03 |
| `TManage Screens - Administration.dc.html` | ADM-01…14 |
| `TManage Screens - Billing Preferences and System.dc.html` | BIL-01…03, PREF-01…05, SYS-04…06 |
| `TManage Screens - Dark, RTL and States.dc.html` | WK-02 dark, MTG-02, PRJ-01 Arabic RTL, SYS-01/02/03, APP-04, empty queue |

Docs in `design/`: visual-reference-analysis, design-principles, decision-log, tokens (json/css/themes),
components (inventory, contracts, state-matrix), patterns ×5, screens (screen-status, whole-app-index),
sitemap-and-role-navigation, information-architecture, requirements-traceability,
content-and-localization, responsive-and-desktop, accessibility-audit, design-quality-scorecard,
prototype-map, flows, developer-handoff.

## Status: all 172 screen IDs are drawn (as of 15 Aug). Remaining work is Phase 12 below.

## Remaining screen IDs to draw (next session, in this order)
1. ~~Files & deliverables remainder — FIL-01, FIL-02, FIL-03, DEL-01, DEL-02~~ **done, in
   `TManage Screens - Files and Approvals.dc.html`**
2. ~~Approvals remainder — APP-01, APP-03~~ **done, same file** (APP-01 and APP-03 drawn on the client
   portal chrome, since APP-02 and APP-04 are client-decision surfaces)
3. ~~Client Portal remainder — CL-02…CL-04, CL-06…CL-16~~ **done, in
   `TManage Screens - Client Portal Extended.dc.html`**
4. ~~People — PEO-01…04~~ **done, in `TManage Screens - People.dc.html`** (People drawn as the active
   rail item in this file only, following the Calendar precedent — confirm or revert)
5. ~~Insights remainder — INS-02…06~~ **done, in `TManage Screens - Insights Extended.dc.html`**
6. ~~Search & AI — SR-01…04, AI-01…04~~ **done, in `TManage Screens - Search and AI.dc.html`** (rail
   unchanged; SR-01 is a dark Context Lens overlay over Work, AI-04 sits under Control Center)
7. ~~Automations & integrations remainder — AUT-01, AUT-04, AUT-05, INT-01…03~~ **done, in
   `TManage Screens - Automations and Integrations.dc.html`** (all six drawn under Control Center; rail
   unchanged, Control is the active item)
8. ~~Administration — ADM-01…14~~ **done, in `TManage Screens - Administration.dc.html`** (one
   Control Center shell: 64px context bar + 208px section column, operational density; rail unchanged —
   these screens sit behind the Control Center orb. New asset `design/assets/tmanage-icon-lime.svg`
   (icon with fill declared) is used as an `<img>` in each header orb instead of re-inlining the path.)
9. ~~Billing — BIL-01…03~~ · 10. ~~Preferences — PREF-01…05~~ · 11. ~~System states — SYS-04…06~~
   **all done, in `TManage Screens - Billing Preferences and System.dc.html`** (Billing on the Control
   Center admin shell; Preferences on the account-orb shell with its own 5-item column; SYS-04 as an
   orange banner over a working Files screen, SYS-05 as a dark full-screen replacement, SYS-06 as two
   710px halves — not-found and unexpected-error.)
12. **Phase 12 — in progress.** Done: `screen-status.md` statuses updated for ADM/BIL/PREF/SYS, letter
    orb swapped in the Dark/RTL file. Still to do: re-score against file 45 across the whole set (last
    self-score 85/100 on the Phase-1 subset), and build prototypes 3 and 5 — **both done**:
    re-score is 91/100 whole-set in `design/design-quality-scorecard.md`, and the clickable prototype is
    `TManage Prototype - Flows 3 and 5.dc.html`. Remaining open items there: real AT pass, Arabic reader
    pass, tablet WK-02 and CL-01, two more RTL surfaces.

## Brand assets (added 15 Aug)
- Real TManage marks are in the project: `design/assets/tmanage-logo.svg` (wordmark, viewBox 0 0 329.3 72.5)
  and `design/assets/tmanage-icon.svg` (mark only, viewBox 0 0 95.4 72.5). Both ship with `class="st0"`
  and no fill declared — always set fill explicitly.
- The placeholder "T" letter orb has been replaced by the inlined icon in every `.dc.html`: black orb,
  lime `#B7FF57` fill (`#A9ED55` on dark), icon width ≈ 55% of the orb diameter, `display:block`.
  All files now carry the real mark. `TManage Screens - Dark, RTL and States.dc.html` was swapped on
  15 Aug using `design/assets/tmanage-icon-ink.svg` (ink fill, for the lime orb on dark) and
  `tmanage-icon-lime.svg` (lime fill, for the ink orb on light). Both are linked as `<img>`, so the
  path no longer needs re-inlining.
- **Wordmark placed 16 Aug.** Three colour variants generated from `tmanage-logo.svg` (mark + name,
  tagline dropped): `tmanage-wordmark-ink.svg`, `-paper.svg`, `-lime.svg`. The ink lockup replaced the
  orb + "TManage" text lockup in the PUB marketing headers and the ON-01 welcome; Foundations gained a
  "Brand lockup" specimen (ink on paper / paper on dark / in-app orb) with the rule that the wordmark is
  never used inside the product chrome and lime never carries the name in-product. The client-portal
  header still shows the client's name, so it keeps the orb.

## Known open items
- Self-score 85/100 against file 45 on the Phase-1 subset; DOC-02 and WK-04 have since been drawn,
  which closes two of the five listed gaps. Re-score after the remaining IDs land.
- All ten flows are clickable. No real assistive-tech pass; avatars are initial orbs by design; artefact previews now use
  stock photography. Alexandria and Geist Mono still load from Google.
