# Developer handoff

## Entry point
1. `design/screens/whole-app-index.md` — which artifact contains which screen ID.
2. Open the `.dc.html` artifact for the screen you are building; it is the visual source of truth
   (inline styles are literal token values).
3. `design/tokens/tokens.css` — drop-in variables; `tokens.json` for a build pipeline.
4. `design/components/contracts.md` — props, keyboard, screen-reader and responsive behaviour.
5. `design/components/state-matrix.md` — the states each component must ship with.
6. `design/requirements-traceability.md` — which pack rule each behaviour implements.

## Implementation notes that are easy to get wrong
- Lime is a semantic token (`current`), not a brand accent. Do not reuse it for success or selection.
- Text on lime is always `ink.950`. Enforce it in the component, not in usage.
- Cards use `1px line.300`, not shadow. Shadow tokens exist only for overlays.
- Committed / forecast / desired are three different fields with three different renderings. Do not
  collapse them into "due date".
- Client visibility is computed per role at read time; do not persist a boolean on the internal record.
- Approvals store the version hash. A new version invalidates rather than updates the approval.
- The Pulse Track must emit an ordered list in the accessibility tree; the visual segments are decoration
  over that list.
- Board drag must be an enhancement over a keyboard move API, not the only path.
- Automations run as an explicit actor with narrower permissions than any human role.

## Acceptance mapping
Each screen ID maps to user stories in `11-USER-STORIES-ACCEPTANCE.md` and tests in `27-TEST-CATALOG.md`.
A screen is `dev_ready` when: contract signed, tokens referenced (no literals), states implemented,
keyboard path verified, RTL verified, analytics events wired (file 34), and the isolation tests for
tenant leakage pass.

## Assets still required from the owner
Client logos, and Atlas's own real design artefacts if they should replace the stock photography now used
in deliverable previews. Avatars stay as initial orbs by design. Satoshi and Manrope are self-hosted in
`design/assets/fonts/`; Alexandria and Geist Mono are still Google-hosted and need licensed files for
an offline build.
## Type and imagery update — 16 Aug

**Fonts are now self-hosted from the project.** Satoshi is the primary/display family (all UI, headings,
labels, buttons — every rule at weight 500-800); Manrope is the paragraph family (weight 400 body copy);
Geist Mono is unchanged for ids, hashes, times and metadata labels. Files:
`design/assets/fonts/Satoshi-Variable.woff2` (300-900) and `design/assets/fonts/Manrope-Variable.ttf`
(200-800), declared as @font-face in every artifact's `<helmet>`. The Google Fonts link now carries only
Alexandria (Arabic) and Geist Mono. Arabic stacks are `Alexandria, Satoshi, sans-serif`.

**Artefact previews show real homepage designs**, not photography: the deliverable under review is
"Homepage Concept", so the previews are hotel/resort landing-page mockups (Freepik free licence,
cropped out of their presentation frames), in `design/assets/img/` as homepage-concept-v1.jpg,
-v2.jpg and -v3.jpg — one per version of the deliverable, used consistently wherever that version
appears. The striped placeholders and their centred captions are gone; version, hash and status still
come from the surrounding chrome. Avatars remain initial orbs by
deliberate choice (see visual-reference-analysis §5: no stock faces as filler).

