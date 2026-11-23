# ADR-0016 — The app uses the Density v2 tokens beside the design export, and sizes and layout are enforced by a ratcheting lint and a layout check

- **Status:** Accepted (design approved by Fable 5.2 in Figma on 2026-11-23, `WORK-FIGMA-FABLE-REVIEW.md`; Peter delegated design decisions, memory "Peter delegated the open decisions", "All designs pre-approved")
- **Date:** 2026-11-23
- **Deciders:** Fable 5.2 (design review); Opus 5.5 implementation lead (lane WF)
- **Rules affected:** UX-5, UX-11, UX-13, UX-18, UX-22; adds UX-25…UX-28 to `UI-UX-DESIGN-STANDARD.md`; **bends a rule:** yes, the token-change process of `packages/ui/src/tokens/PART.md` §9 step 1 (see Consequences)
- **Quality scenarios:** usability at a short laptop window (1646 × 838 CSS px, Peter's screen)
- **Evidence:** `D:/TManage/work/pass-2026-11-23/WORK-AREA-REVIEW-AND-PLAN.md` §2 (156 screens measured: 9 page-title sizes, 21 font sizes, 43 control heights, header rows mixing up to 5 heights on 130 of 156 screens, text 6–12px from edges); `scripts/lint/design-tokens.mjs --report --ref 8282d2a3` (3,412 hard-coded sizes in 134 of 181 CSS files); owner reports 2026-11-23 (content 8px from the rail; text 12px from a pill end, fixed in `7ce92a65`).

## Context

The design system had density tokens (`--control`, `--row`) and a type scale, but the CSS used them 44 times against ~3,400 literal sizes. Every screen picked its own numbers, so the same kind of control came in many heights and titles in many sizes. Nothing stopped a new literal. The two owner examples were found by eye, by Peter, twice.

In Figma (`ZdUCRiqBiT7s3u08HA28RO`, page `0:1`, doc frame `918:2052`) the design system now has Density v2: control 32 / 28 / 40, row 36, panel row 32, header row 56, page gutter 32 / 24 / 16, insets 12 / 16 / 12 / 24 / 24, text-edge-min 24, and 16 text styles (`App/`, `App AR/`). Fable 5.2 approved it with fixes, all applied (`WORK-FIGMA-REPORT.md` §6).

The code tokens mirror the design export `docs/design/source/project/design/tokens/`, which is immutable source material and is pinned by `packages/ui/tests/tokens.drift.test.ts`. Its `--control` / `--row` are the member's density preference and must keep their meaning.

## Decision

1. **Density v2 lives in `packages/ui/src/styles/density.css`**, imported by `limeframe.css` right after `tokens.css`, under names the export does not use: `--app-control`, `--app-control-sm`, `--app-control-lg`, `--app-row`, `--app-panel-row`, `--app-header-row`, `--target-min`, `--page-gutter`, `--app-rail`, `--app-context-rail`, `--properties-panel`, `--panel-label`, `--dialog`, `--inset-control`, `--inset-capsule`, `--inset-cell`, `--inset-card`, `--inset-dialog`, `--text-edge-min`, `--app-radius`, and `--t-app-<style>{,-line,-weight}` for the 8 `App/` styles. The TS form is `packages/ui/src/tokens/app-density.ts`; `packages/ui/tests/app-density.test.ts` pins the two forms together in both directions.
2. **Components:** `Button` gains `size="header"` (32, radius 14, text inset 12) and `size="large"` (40, radius 14, inset 16) and `flush` for text buttons; `IconButton` (28 `small`, 32 `header`) is the icon-only toolbar control. `.tm-pill` keeps its text 16px from the rounded ends and is never under 11px.
3. **Sizes come from tokens (UX-25).** `scripts/lint/design-tokens.mjs` (in `pnpm verify`) fails when a CSS file has more literal `font-size`, height, padding, margin, gap or size custom-property values than its entry in `docs/architecture/baselines/design-tokens.json`; a new file must have none. `--update` only lowers the baseline.
4. **Layout invariants (UX-26…UX-28)** are measured in a real browser by `apps/web/vr/layout.spec.ts` with `apps/web/vr/layout-invariants.ts`: page gutter beside the rail ≥ the gutter token; text ≥ 16px and ≥ half the height from a capsule's rounded ends; text ≥ 12px from a control's edge; text ≥ 24px from a card, panel or dialog edge; one control height in the page header row; no text under 11px; targets ≥ 24 × 24. A fixture story reproduces the two owner examples and the spec fails if the checker does not flag them. The `vr`-tagged screen stories are held to a per-story baseline (`docs/architecture/baselines/layout-invariants.json`) that may only shrink.
5. **The app shell header uses the header size:** every control in `.tm-canvas-header__actions` is 32 high with radius 14; the page title is `--t-app-page-title` (24) everywhere, and the body gutter is `--page-gutter`.

## Alternatives considered

| Option                                                                         | Pros             | Cons                                                                                                                            | Why not chosen                                                                                                             |
| ------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Change `--control`, `--row`, `--t-heading-page` in the export and `tokens.css` | one set of names | edits the immutable export; changes the member's density preference and the public site and portal (balanced/editorial) at once | the export is source material (PART.md T-1…T-3) and the public site keeps its own density                                  |
| Install `stylelint` with `declaration-property-unit-disallowed-list`           | standard tool    | a new dev dependency and lockfile change for one rule; no ratchet built in                                                      | the repo's lints are small Node scripts (`lint:copy`, `lint:csv`); a ratchet is needed to adopt on 3,400 existing literals |
| Screenshot review only                                                         | no new code      | found the defects late, by Peter                                                                                                | a check that fails is the point (PR-3)                                                                                     |

## Consequences

- Good: every new CSS line is pushed onto tokens; the count can only fall; the two owner-reported defect classes are caught by a test. Sweeping a file is mechanical and visible in the baseline diff.
- Bad: two token files instead of one until the export is regenerated from Figma with Density v2 (TOK-4/TOK-5). The member's density preference no longer changes the swept app screens; it still governs the public site and the portal.
- **Bent rule:** `packages/ui/src/tokens/PART.md` §9 step 1 asks for the export to change first. Compensating control: `app-density.test.ts` pins CSS ↔ TS, and every value names its Figma variable id. **Exit condition:** when the export is regenerated from Figma (UX-12/UX-13, DTCG), `density.css` folds into it and this ADR is superseded.

## Fitness functions

| Rule                                                          | Check (path)                                                                                                                                                                             | Exists / to build |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| UX-25 sizes from tokens                                       | `scripts/lint/design-tokens.mjs` + `scripts/lint/design-tokens.test.mjs`, baseline `docs/architecture/baselines/design-tokens.json`                                                      | exists            |
| UX-26…UX-28 insets, gutter, header row, minimum text, targets | `apps/web/vr/layout.spec.ts`, `apps/web/vr/layout-invariants.ts`, fixture `apps/web/stories/LayoutInvariants.stories.tsx`, baseline `docs/architecture/baselines/layout-invariants.json` | exists            |
| Density v2 CSS ↔ TS                                           | `packages/ui/tests/app-density.test.ts`                                                                                                                                                  | exists            |
| Figma variables ↔ code                                        | `scripts/design/figma-variables-diff.mjs` (UX-13)                                                                                                                                        | to build          |
