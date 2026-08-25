/**
 * The token package.
 *
 * `docs/design/source/project/design/tokens/tokens.json` is the design export and is
 * immutable source material — it is never edited, and nothing here is allowed to drift
 * from it. `tests/tokens.drift.test.ts` reads that file at test time and fails on any
 * added, missing, or changed value, in both directions.
 *
 * This module exists because a stylesheet cannot be imported by a chart, a canvas, an
 * email template, or a test. Anything that renders in the DOM should use the custom
 * properties in `src/styles/tokens.css`; anything that has to compute with a token value
 * uses these.
 *
 * The values are the design phase's (`1.0.0-design`), not the planning pack's
 * (`contracts/design/tokens.foundation.json`, `0.4.0-planning`). Where the two disagree —
 * the orbital rail is 88px here and 72px there — the design export wins, because
 * `40-DESIGN-SYSTEM-TOKENS-AND-COMPONENTS.md` §1 calls its own values "executable starter
 * tokens" that the design phase may tune with evidence. The divergences are listed in
 * `docs/implementation-status.md`.
 */

export const colorLight = {
  ink: {
    '500': '#74786F',
    '650': '#4D5049',
    '800': '#232521',
    '950': '#090A09',
  },
  paper: {
    '0': '#FFFFFF',
    '50': '#F7F7F3',
    '150': '#E9E9E5',
    '250': '#D5D6D1',
    '350': '#E4E4DF',
  },
  line: {
    '300': '#C5C7C0',
    '700': '#2C2E29',
  },
  lime: {
    '100': '#E9FFD0',
    '500': '#B7FF57',
    '600': '#9CEA3F',
  },
  client: { '500': '#7755C7' },
  success: { '600': '#1D8A63' },
  warning: { '600': '#C96F18' },
  danger: { '600': '#D9474F' },
} as const;

export const colorDark = {
  canvas: '#121311',
  rail: '#171814',
  surface1: '#1B1D19',
  surface2: '#242720',
  line: '#3A3E35',
  ink: '#F5F6F0',
  muted: '#A7ACA0',
  lime: '#A9ED55',
  limePlane: '#29351D',
  client: '#A98AE5',
  warning: '#E9A85C',
  danger: '#FF7780',
} as const;

export const typeFamily = {
  latin: 'Manrope Variable',
  arabic: 'Alexandria Variable',
  mono: 'Geist Mono',
} as const;

/**
 * Desktop values. The mobile column of `40-DESIGN-SYSTEM` §3 is not in the export and is
 * therefore not asserted here; it belongs to the responsive work in WEB-001.
 */
export const typeScale = {
  'display.xl': { size: 72, line: 76, weight: 500, track: '-0.03em' },
  'display.lg': { size: 56, line: 62, weight: 500, track: '-0.025em' },
  'display.metric': { size: 64, line: 64, weight: 400, track: '-0.02em', numeric: 'tabular' },
  'heading.page': { size: 36, line: 42, weight: 600 },
  'heading.section': { size: 24, line: 31, weight: 600 },
  'heading.card': { size: 20, line: 27, weight: 600 },
  'body.lg': { size: 17, line: 25, weight: 400 },
  'body.md': { size: 15, line: 22, weight: 400 },
  'ui.md': { size: 14, line: 20, weight: 500 },
  'ui.sm': { size: 13, line: 18, weight: 500 },
  caption: { size: 12, line: 17, weight: 500 },
} as const;

export const typeArabic = {
  sizeFactor: 0.9,
  lineFactor: 1.34,
  tracking: '0',
} as const;

export const space = {
  '1': '4px',
  '2': '8px',
  '3': '12px',
  '4': '16px',
  '5': '20px',
  '6': '24px',
  '8': '32px',
  '10': '40px',
  '12': '48px',
  '16': '64px',
  '20': '80px',
  '24': '96px',
} as const;

export const radius = {
  micro: '10px',
  control: '14px',
  compactSurface: '18px',
  card: '24px',
  sheet: '28px',
  feature: '32px',
  capsule: '999px',
} as const;

export const orb = {
  compact: '32px',
  default: '40px',
  comfortable: '44px',
  navigation: '48px',
  feature: '56px',
  hero: '64px',
} as const;

export const border = {
  quiet: '1px',
  structural: '1.5px',
  expressive: '2px',
} as const;

export const focus = {
  ring: '2px solid #090A09',
  halo: '0 0 0 3px #B7FF57',
  darkRing: '2px solid #F5F6F0',
  darkHalo: '0 0 0 3px #A9ED55',
} as const;

export const layout = {
  orbitalRail: '88px',
  orbitalRailCompact: '72px',
  contextRail: '248px',
  contextRailMin: '200px',
  contextLens: '360px',
  readingWidth: '680px',
  docWidth: '820px',
} as const;

export const motion = {
  micro: '140ms',
  selection: '180ms',
  panel: '240ms',
  track: '300ms',
  easing: 'cubic-bezier(0.2,0.6,0.2,1)',
  reducedMotion: 'opacity 120ms only',
} as const;

export const density = {
  editorial: { row: '56px', control: '48px', radius: '32px' },
  balanced: { row: '42px', control: '40px', radius: '24px' },
  operational: { row: '38px', control: '36px', radius: '18px' },
} as const;

/** The three composition densities of `40-DESIGN-SYSTEM` §9. */
export type Density = keyof typeof density;

/** `40-DESIGN-SYSTEM` §2 and the themes note: light, dark, and a high-contrast overlay. */
export type Theme = 'light' | 'dark';
export type Contrast = 'normal' | 'high';
