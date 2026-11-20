---
part: ds/tokens
kind: ds-area
context: design-system
owner: implementation-lead
lifecycle: production
depends_on: []
provides_api:
  [
    '@tmanage/ui token exports (packages/ui/src/tokens/index.ts)',
    'CSS custom properties (packages/ui/src/styles/tokens.css via @tmanage/ui/styles.css)',
  ]
consumes_api: []
tables_owned: []
rules: [AR-2, AR-11, AR-12, PR-1, PR-3]
ux_rules: [UX-7, UX-11, UX-12, UX-13, UX-14, UX-16, UX-18, UX-21, UX-22]
last_verified_commit: 3b7e4fa70eb6facff3f1dccc65c0867f0707a0a6
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane E)
---

# ds/tokens: the Limeframe design tokens

Paths in this part: `packages/ui/src/tokens/tokens.ts`, `packages/ui/src/tokens/index.ts`, and the stylesheet that carries the same values, `packages/ui/src/styles/tokens.css`. `styles/base.css` and `styles/components.css` belong to `ds/styles`. They are listed here only as the main consumers.

## Purpose and bounded context

Tokens are the single source of design values (colour, type, space, radius, border, focus, layout, motion, density) for every TManage surface. There are two forms:

- **CSS custom properties** in `styles/tokens.css`, for anything that renders in the DOM. The web imports them once, through `@tmanage/ui/styles.css` → `limeframe.css:9-11` (tokens, then base, then components), at `apps/web/src/app/layout.tsx:4`.
- **TypeScript constants** in `tokens/tokens.ts`, for anything that must compute with a value: charts, canvas, mail, tests (`tokens.ts:8-12`). They are exported from the package root (`packages/ui/src/index.ts:12`). Consumers include `apps/web/.storybook/preview.tsx`, `DisplayPreferencesView.tsx`, `viewer/FigmaStage.tsx` and `apps/web/tests/contrast.test.ts`.

**Upstream:** the design export `docs/design/source/project/design/tokens/{tokens.json,tokens.css}`, version `1.0.0-design` (`tokens.json:2-7`). It is **immutable source material** and is never edited from code (`tokens.ts:4-7`, `tokens.css:4-10`). Behind it sits the Figma file `ZdUCRiqBiT7s3u08HA28RO`, page `0:1` (UX-13; memory "Figma is the design").
**Downstream:** `ds/styles`, every `packages/ui` component, every web route area, `packages/mail` templates. Context-map relation: **published language**. Consumers conform; nobody else defines a colour.

## Domain model and invariants

Token groups (`tokens.ts`): `colorLight` (`:22-49`), `colorDark` (`:51-64`), `typeFamily` (`:66-70`), `typeFamilyCjk` (`:77`, not in the export, documented at `:72-76`), `typeScale` (`:83-95`), `typeArabic` (`:97-101`), `space` (`:103`), `radius` (`:118`), `orb` (`:128`), `border` (`:137-141`), `focus` (`:143-148`), `layout` (`:150-158`), `motion` (`:160-167`), `density` (`:169-174`). Types: `Density`, `Theme = 'light' | 'dark'`, `Contrast = 'normal' | 'high'` (`:176-180`).

Theming axes in CSS (selectors set by `ThemeProvider`, `packages/ui/src/components/ThemeProvider.tsx:40-43`):

| Axis | Selector | Lines |
| --- | --- | --- |
| light (default) | `:root` | `tokens.css:19-132` |
| dark | `[data-theme='dark']` | `:134-155` |
| high contrast | `[data-contrast='high']` (quiet line → structural, 1.5 px borders, muted ink → strong) | `:157-161` |
| density | `[data-density='editorial' / 'balanced' / 'operational']` | `:163-179` |
| reduced motion | `@media (prefers-reduced-motion: reduce)`, every `--t-*` set to 0 ms | `:181-188` |

| # | Invariant (checkable) | Proof |
| --- | --- | --- |
| T-1 | `tokens.ts` equals `tokens.json` for the light and dark palettes, type, geometry, focus, layout, motion and density, in both directions. | `packages/ui/tests/tokens.drift.test.ts:30-71` |
| T-2 | `tokens.css` declares every selector the export declares, with the same value for each property the export has. | `tokens.drift.test.ts:73-91` |
| T-3 | `:root` adds only the named properties that `tokens.json` backs (space 20/24, orb, layout extras, type scale, density). | `tokens.drift.test.ts:99-140` |
| T-4 | **Law 1:** text on `--lime-500` is always `--ink-950`; white on lime (1.5:1) is prohibited. **Law 2:** lime means current, next or live only. **Law 3:** every colour state also carries a word and a shape. | Stated at `tokens.css:12-17`. Law 1 is tested in `packages/ui/tests/contrast.test.ts:73-88`. Laws 2 and 3 are enforced in `components.css` and the component tests, not by a token test. |
| T-5 | Every text pairing the primitives paint passes WCAG 2.2 AA (4.5:1 text, 3:1 non-text) in light and dark; the quiet line fails 3:1 and high contrast fixes it. | `contrast.test.ts:90`, `:115`, `:157` |
| T-6 | Under `prefers-reduced-motion: reduce`, every motion duration token is 0. | `tokens.css:181-188`; VR runs with `reducedMotion: 'reduce'` (`packages/ui/vr/playwright.config.ts`, UX-16 row) |

## Public API and contracts

- **TS:** `export { colorLight, colorDark, typeFamily, typeFamilyCjk, typeScale, typeArabic, space, radius, orb, border, focus, layout, motion, density, type Density, type Theme, type Contrast }` (`tokens/index.ts:1-19`). Every object is `as const`, so values are literal types (AR-12).
- **CSS:** custom properties `--ink-*`, `--paper-*`, `--line-*`, `--lime-*`, `--client-500`, `--success-600`, `--warning-600`, `--danger-600` (`tokens.css:20-46`); `--font-latin/-arabic/-mono` (`:49-51`); `--t-*` type scale and motion; `--r-*` radius (`:78-84`); `--b-*` borders (`:85-87`); `--focus-ring` (`:88`, dark `:154`); `--s1…--s24` space (`:99-110`); `--rail*` layout (`:113-114`); `--row`, `--control`, `--surface-radius` density (`:129-131`).
- **Package export paths:** `@tmanage/ui/styles.css` → `src/styles/limeframe.css` and `@tmanage/ui/styles/*` (`packages/ui/package.json` `exports`).
- n/a — HTTP routes and events. This part is a static library.

## Data: tables and migrations

n/a — this part has no database. The data is the design export (`docs/design/source/project/design/tokens/`), versioned in git. Its change process is in §9.

## Permissions and tenant rules

n/a — there is no runtime authority. Tenant themes are not supported. A tenant-specific brand colour would need an ADR and a semantic tier (UX-21) first.

## Runtime, background work and failure modes

n/a — no runtime: no jobs, no I/O. Build-time failure modes:

| Failure | Guard |
| --- | --- |
| A value is typed into `tokens.ts` or `tokens.css` that the export does not have | T-1, T-3 fail |
| The export changes and code is not updated | T-1, T-2 fail |
| **A property is added under `[data-theme='dark']` or another non-root selector that the export lacks** | **Not guarded.** T-3 checks only `:root` additions (`tokens.drift.test.ts:100-102`). Example at HEAD: `--success-600: #4cc690` at `tokens.css:151`. It is not in the export's dark block (`docs/.../tokens.css:26-32`) and not in `colorDark` (`tokens.ts:51-64`), so TS and CSS disagree on dark success (TOK-1). |
| A literal colour bypasses tokens elsewhere | Not guarded (UX-11 gap; §11) |

## UX rules for its screens

This part has no screen of its own. These rules apply to **every** screen through it:

- Colour meaning: lime = current, next or live only; success, warning and danger are separate tokens (`tokens.css:40-46`, Law 2). Client identity is `--client-500` violet (`:43`), the visual sign of the client trust zone.
- Contrast (UX-7): T-5. Arabic gets `typeArabic` factors (size 0.9, line 1.34, `tokens.ts:97-101`). The Arabic font is `--font-arabic` Alexandria.
- Focus (UX-6): `--focus-ring` is a 2 px ink inner ring plus a 3 px lime halo, `0 0 0 2px …, 0 0 0 5px …` (`tokens.css:88`, `:154`). That meets the 2.4.13 AAA appearance target of a 2 px perimeter at 3:1.
- Motion (UX-16): durations 140/180/240/300 ms with one easing (`tokens.ts:160-167`), zeroed under reduced motion (T-6).
- Density: balanced is the default composition (`tokens.css:129-131`).
- n/a — Figma node ids per screen and copy keys. Those belong to the web route parts.

## Standards that apply

| Rule | Today | Target |
| --- | --- | --- |
| AR-2 | `tokens.ts` imports nothing; plain constants | met |
| AR-11 | one set of values, two forms, pinned by T-1 and T-2; `typeFamilyCjk` is a documented addition | met, except TOK-1 |
| AR-12 | `as const` literal types; `Theme`/`Contrast` unions | met |
| UX-7 | contrast tests over painted pairs (T-5) | extend to every semantic pair once UX-21 exists |
| UX-11 | tokens exist. **Literal hex outside the token files:** 89 in 11 CSS files plus 73 in TS/TSX under `apps/web/src`, and 14 in `packages/ui/src/styles/components.css` (grep `#[0-9a-fA-F]{6}`/`{3}`, 2026-11-20). There is no lint. | a stylelint `color-no-hex` (or a custom check) with an allowlist for brand marks; ratchet to 0 |
| UX-12 | the export declares the DTCG `$schema` (`tokens.json:2`) but has **0 `$value` and 0 `$type`** (grep) | a DTCG 2025.10 export with `$value`, `$type` and aliases; regenerate `tokens.ts`/`tokens.css` from it |
| UX-13 | code is pinned to the export, **not to Figma**; no check reads the Figma variables of `ZdUCRiqBiT7s3u08HA28RO` page `0:1` | Figma variables → DTCG export → drift test (one chain) |
| UX-14 | tokens carry no direction; RTL is set by `ThemeProvider` `dir` (`ThemeProvider.tsx:43`) | met for tokens; physical CSS belongs to ds/styles (4 physical side properties in `components.css`, e.g. `:722`, `:739`, `:743`) |
| UX-16 | motion tokens, reduced-motion zeroing (T-6) | met for tokens |
| UX-18 | light, dark and RTL VR baselines in `packages/ui/vr/stories.spec.ts-snapshots` | a token change re-takes only the shots it touches (memory "Re-take only the VR baselines a change touches") |
| UX-21 | **flat palette names only** (`--ink-950`, `--paper-0`…); dark mode re-maps palette names (`tokens.css:134-155`), so `--ink-950` means "strongest text" in both themes. That is semantic use under a palette name. There are no `color.text.*`/`color.border.*` semantic tokens and no component tier. | palette → semantic → component tiers; components use semantic tokens only |
| UX-22 | a token is added by changing the export first (T-1/T-3 force it) | met for `:root`; extend T-3 to every selector |
| PR-1/PR-3 | drift and contrast tests exist | close the dark-selector gap (TOK-1) and add the UX-11 lint |

## How to change this part

1. **Change the design first.** Change the Figma variable (memory "Figma first, then live"), then update the export `docs/design/source/project/design/tokens/tokens.json` and `tokens.css`. That is the only allowed edit to the "immutable" export: a new design version, bumping `meta.version`.
2. Mirror the value in `tokens.ts` **and** `styles/tokens.css`. A new `:root` property also goes into the named list in `tokens.drift.test.ts:104-140`.
3. If it is a colour pairing, add it to `contrast.test.ts`.
4. Re-take only the VR shots that change (`packages/ui/vr`, `-g` per story).
5. **Files that change together:** `tokens.ts` ↔ `styles/tokens.css` ↔ `tests/tokens.drift.test.ts` ↔ `tests/contrast.test.ts` ↔ the export.
6. **Checks:** `pnpm --filter @tmanage/ui test` (drift, contrast, theme), the VR run for the touched stories, then `pnpm verify`.
7. **Never** write a literal colour in a component or a web file. Add or reuse a token.

## Tests and fitness checks

| File | Guards |
| --- | --- |
| `packages/ui/tests/tokens.drift.test.ts` | T-1, T-2, T-3 |
| `packages/ui/tests/contrast.test.ts` | T-4 law 1, T-5, the export's "verified pairings" (`:18`) |
| `packages/ui/tests/theme-and-direction.test.tsx` | the theme, contrast, density and `dir` application (`:75`, `:90`, `:105`) |
| `apps/web/tests/contrast.test.ts` | web-side pairings over the TS tokens |
| `packages/ui/vr/stories.spec.ts` (+ snapshots) | UX-18 visual baselines, light, dark and RTL |

Missing: a non-root selector drift check (TOK-1); a UX-11 literal-colour lint; a Figma ↔ export check (UX-13); a DTCG schema validation (UX-12).

## Open defects, decisions and risks

| Id | Class | Defect | Pri | Exit |
| --- | --- | --- | --- | --- |
| TOK-1 | DC-2 (one value decided in two places) | Dark `--success-600: #4cc690` exists only in `tokens.css:151`. The export and `colorDark` have no dark success, so TS consumers (charts, mail) get no dark success value, and T-3 does not see non-root additions. | P1 | add it to the export's dark block and `colorDark`; extend T-3 to every selector |
| TOK-2 | none | UX-11: about 176 literal hex colours outside the token files (counts in §8); no lint. | P1 | lint + ratchet baseline |
| TOK-3 | none | UX-21: no semantic or component tier. | P2 | ADR + staged rename (expand–contract: aliases first) |
| TOK-4 | none | UX-12: the export is not DTCG-conformant despite its `$schema`. | P2 | regenerate as DTCG 2025.10 |
| TOK-5 | risk | UX-13: there is no automated Figma ↔ code check, so drift between Figma and the export is invisible. | P2 | Figma variables export in the chain |

## Glossary

| Term | Meaning | AR (UI) |
| --- | --- | --- |
| Limeframe | the TManage visual system (lime accent on ink and paper) | n/a, brand name |
| Ink / paper / line | text, surface and stroke palettes | not shown in the UI |
| Lime | the accent for current, next or live | not shown in the UI |
| Density | row, control and radius composition: editorial, balanced or operational | the display preference labels in the i18n catalogs |
