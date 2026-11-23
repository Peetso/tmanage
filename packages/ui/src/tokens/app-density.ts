/**
 * Density v2: the app's size, space and type tokens, for code that computes with them
 * (layout checks, canvas, charts, tests). The DOM uses the custom properties in
 * `src/styles/density.css`; `tests/app-density.test.ts` fails if the two forms disagree.
 *
 * Source: Figma `ZdUCRiqBiT7s3u08HA28RO` page `0:1`, doc frame "DS · Density v2 — app default"
 * (`918:2052`); the variable ids are in the comments of `density.css` (ADR-0016). These are not
 * in the immutable design export, which is why they are a separate module from `tokens.ts`.
 */
export const appDensity = {
  control: 32,
  controlSm: 28,
  controlLg: 40,
  row: 36,
  panelRow: 32,
  headerRow: 56,
  targetMin: 24,
} as const;

/** Page gutter per Figma Layout mode (`915:911`). */
export const pageGutter = { desktop: 32, tablet: 24, phone: 16 } as const;

export const appLayout = {
  rail: 72,
  contextRail: 232,
  propertiesPanel: 360,
  panelLabel: 104,
  dialog: 560,
} as const;

/** Text insets (Figma Inset `915:918`). `textEdgeMin` is doc-frame rule 1. */
export const appInset = {
  control: 12,
  capsule: 16,
  cell: 12,
  card: 24,
  dialog: 24,
  textEdgeMin: 24,
} as const;

/** The 8 `App/` text styles (the `App AR/` set differs only in the page-title line, 36). */
export const appType = {
  pageTitle: { size: 24, line: 30, weight: 600 },
  section: { size: 18, line: 24, weight: 600 },
  cardTitle: { size: 15, line: 22, weight: 600 },
  body: { size: 14, line: 20, weight: 400 },
  ui: { size: 13, line: 18, weight: 500 },
  uiStrong: { size: 13, line: 18, weight: 600 },
  caption: { size: 12, line: 16, weight: 500 },
  overline: { size: 11, line: 14, weight: 500 },
} as const;

export const appTypeArabicPageTitleLine = 36;

/** Doc-frame rule 4: nothing on screen is set below this size. */
export const minTextSize = appType.overline.size;
