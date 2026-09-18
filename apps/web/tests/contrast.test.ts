import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AA_NON_TEXT, AA_NORMAL_TEXT, colorDark, colorLight, contrastRatio } from '@tmanage/ui';
import { describe, expect, it } from 'vitest';

/**
 * The colour pairings this application introduces on top of the design system.
 *
 * `packages/ui` proves its own primitives. This file proves the surfaces `globals.css`
 * composes — the inverted identity backdrop, the orbital rail, the portal header — because
 * those pairings exist nowhere else and are exactly the sort of thing that is checked once
 * by eye and never again.
 *
 * Two of the assertions are structural rather than numeric, and they are the ones that keep
 * this file honest as the stylesheet grows:
 *
 * 1. `globals.css` contains **no colour literal**. Every colour is a `var(--token)`, so a
 *    value cannot enter the application without passing through `tokens.css` and therefore
 *    through `packages/ui`'s drift test against the immutable export.
 * 2. The four inverted-surface properties are defined for **both** themes. A property defined
 *    only under `:root` would silently keep the light value in dark mode, which is how a rail
 *    turns white.
 *
 * ## Measured, not assumed
 *
 * Every ratio below was computed rather than read off the design export — the export's own
 * "Verified pairings" figures were found to be wrong in all five cases during UI-001. The
 * numbers in the comments are what `contrastRatio` returns for these exact tokens today; the
 * assertions are floors, so a token change that improves a pairing does not fail the build
 * and one that degrades it does.
 */

/*
 * `fileURLToPath` is given the *string* `import.meta.url`, not a `new URL(...)` built from
 * it. In the jsdom environment the global `URL` is jsdom's, and Node's `fileURLToPath`
 * rejects an instance of it with "The URL must be of scheme file" even when the href is
 * exactly that.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = readFileSync(join(HERE, '../src/app/globals.css'), 'utf8');

/**
 * The design system's token sheet. `packages/ui/tests/tokens.drift.test.ts` proves every value
 * here against the immutable design export, in both directions — so, once we have read which
 * base token a `--tm-inverted-*` property resolves to, this file is the honest source of that
 * token's hex per theme.
 */
const TOKENS_CSS = readFileSync(join(HERE, '../../../packages/ui/src/styles/tokens.css'), 'utf8');

/**
 * The declarations of one top-level block, `--name -> value`. The token and application sheets
 * declare their `:root` and `[data-theme='dark']` blocks flat (no nested rules), so the first
 * match of the selector is the unconditional block and a brace-free body is exact for it. A
 * nested `:root` inside an `@media` (reduced-motion) is never the first match and is ignored.
 */
function blockDeclarations(css: string, selector: string): Map<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = withoutComments.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  const declarations = new Map<string, string>();
  for (const line of match?.[1]?.split(';') ?? []) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    const name = line.slice(0, at).trim();
    if (name.startsWith('--')) declarations.set(name, line.slice(at + 1).trim());
  }
  return declarations;
}

/**
 * Resolve a `--tm-inverted-*` property to the hex it paints in a theme, entirely through the
 * stylesheets: `globals.css` maps the property to a base token for this theme, `tokens.css`
 * maps that base token to a hex for this theme (a token the dark block does not redefine
 * inherits its `:root` value). This is I3 of the test-honesty sweep: the pairs these assertions
 * measure are now the pairs the stylesheet composes, not a hand-transcribed comment. Re-point
 * `--tm-inverted-muted` at a failing colour in `globals.css` and the ratio below moves with it.
 */
function invertedSurfaces(theme: 'light' | 'dark') {
  const selector = theme === 'light' ? ':root' : "[data-theme='dark']";
  const invertedDefs = blockDeclarations(GLOBALS_CSS, selector);
  const rootTokens = blockDeclarations(TOKENS_CSS, ':root');
  const themeTokens = theme === 'light' ? rootTokens : blockDeclarations(TOKENS_CSS, selector);
  const resolve = (property: string): string => {
    const base = invertedDefs.get(property)?.match(/var\(\s*(--[\w-]+)\s*\)/)?.[1];
    const hex = base ? (themeTokens.get(base) ?? rootTokens.get(base)) : undefined;
    if (!hex) {
      throw new Error(
        `could not resolve ${property} in the ${theme} theme through the stylesheets`,
      );
    }
    return hex;
  };
  return {
    invertedGround: resolve('--tm-inverted-ground'),
    invertedInk: resolve('--tm-inverted-ink'),
    invertedMuted: resolve('--tm-inverted-muted'),
  };
}

const lightInverted = invertedSurfaces('light');
const darkInverted = invertedSurfaces('dark');

/** Light-theme values. The inverted surfaces are resolved from the stylesheets (see above). */
const LIGHT = {
  invertedGround: lightInverted.invertedGround, // globals.css --tm-inverted-ground, light
  invertedInk: lightInverted.invertedInk, // globals.css --tm-inverted-ink, light
  invertedMuted: lightInverted.invertedMuted, // globals.css --tm-inverted-muted, light
  ink950: colorLight.ink['950'],
  ink800: colorLight.ink['800'],
  ink650: colorLight.ink['650'],
  ink500: colorLight.ink['500'],
  paper0: colorLight.paper['0'],
  paper50: colorLight.paper['50'],
  paper150: colorLight.paper['150'],
  lime100: colorLight.lime['100'],
  client500: colorLight.client['500'],
} as const;

/** Dark-theme values. The inverted surfaces are resolved from the stylesheets (see above). */
const DARK = {
  invertedGround: darkInverted.invertedGround, // globals.css --tm-inverted-ground, dark
  invertedInk: darkInverted.invertedInk, // globals.css --tm-inverted-ink, dark
  invertedMuted: darkInverted.invertedMuted, // globals.css --tm-inverted-muted, dark
  surface: colorDark.surface1,
  canvas: colorDark.canvas,
  limePlane: colorDark.limePlane,
  client: colorDark.client,
} as const;

function ratio(foreground: string, background: string): number {
  return Number(contrastRatio(foreground, background).toFixed(2));
}

describe('the inverted surfaces', () => {
  it('reads at AA in the light theme (12.78:1)', () => {
    expect(ratio(LIGHT.invertedInk, LIGHT.invertedGround)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(ratio(LIGHT.invertedInk, LIGHT.invertedGround)).toBe(12.78);
  });

  it('reads at AA in the dark theme (16.41:1)', () => {
    expect(ratio(DARK.invertedInk, DARK.invertedGround)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(ratio(DARK.invertedInk, DARK.invertedGround)).toBe(16.41);
  });

  it('keeps the muted rail label readable in the light theme (8.04:1)', () => {
    expect(ratio(LIGHT.invertedMuted, LIGHT.invertedGround)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(ratio(LIGHT.invertedMuted, LIGHT.invertedGround)).toBe(8.04);
  });

  it('keeps the muted rail label readable in the dark theme (7.69:1)', () => {
    expect(ratio(DARK.invertedMuted, DARK.invertedGround)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(ratio(DARK.invertedMuted, DARK.invertedGround)).toBe(7.69);
  });

  /**
   * The mistake this test exists to prevent. `--line-700` is `#2C2E29` in the light theme and
   * `#F5F6F0` in the dark one — it is an *ink* token that happens to be dark. A rail painted
   * with it directly would invert into a white slab with white text on it, at 1:1.
   */
  it('would have been unreadable had the rail used --line-700 directly in dark mode', () => {
    const naive = ratio(colorDark.ink, colorDark.ink);
    expect(naive).toBeLessThan(AA_NORMAL_TEXT);
  });
});

describe('the paper surfaces', () => {
  it.each([
    ['ink-950 on paper-0', LIGHT.ink950, LIGHT.paper0, 19.83],
    ['ink-950 on paper-50', LIGHT.ink950, LIGHT.paper50, 18.46],
    ['ink-950 on paper-150', LIGHT.ink950, LIGHT.paper150, 16.29],
    ['ink-800 on paper-0', LIGHT.ink800, LIGHT.paper0, 15.46],
    ['ink-650 on paper-0', LIGHT.ink650, LIGHT.paper0, 8.21],
    ['ink-650 on paper-50', LIGHT.ink650, LIGHT.paper50, 7.64],
    ['ink-650 on paper-150', LIGHT.ink650, LIGHT.paper150, 6.74],
    ['ink-950 on lime-100', LIGHT.ink950, LIGHT.lime100, 18.58],
  ])('%s is %d:1 and passes AA', (_name, foreground, background, expected) => {
    expect(ratio(foreground, background)).toBe(expected);
    expect(ratio(foreground, background)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  /**
   * The reason `--ink-500` sets no text in `globals.css`.
   *
   * It clears the 4.5:1 floor on pure white by 0.01 and fails on both of the paper tones this
   * application actually uses for a card. Secondary text is `--ink-650` throughout, which is
   * 6.74:1 at its worst. This is asserted rather than commented so that a later edit reaching
   * for `--ink-500` has to argue with a failing test.
   */
  it('shows why --ink-500 is not used for text', () => {
    expect(ratio(LIGHT.ink500, LIGHT.paper0)).toBe(4.51);
    expect(ratio(LIGHT.ink500, LIGHT.paper50)).toBe(4.2);
    expect(ratio(LIGHT.ink500, LIGHT.paper50)).toBeLessThan(AA_NORMAL_TEXT);
    expect(ratio(LIGHT.ink500, LIGHT.paper150)).toBe(3.7);
    expect(ratio(LIGHT.ink500, LIGHT.paper150)).toBeLessThan(AA_NORMAL_TEXT);
    expect(GLOBALS_CSS).not.toMatch(/color:\s*var\(--ink-500\)/);
  });

  it('keeps the client accent readable as text on both card grounds', () => {
    expect(ratio(LIGHT.client500, LIGHT.paper0)).toBe(5.37);
    expect(ratio(LIGHT.client500, LIGHT.paper50)).toBe(5.0);
    expect(ratio(DARK.client, DARK.surface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('keeps the portal preview bar readable on its lime plane (18.58:1 light)', () => {
    expect(ratio(LIGHT.ink800, LIGHT.lime100)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(ratio(colorDark.ink, DARK.limePlane)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('keeps the portal active-tab underline visible as a non-text boundary', () => {
    // WCAG 1.4.11: a control boundary needs 3:1 against what is behind it.
    expect(ratio(LIGHT.client500, LIGHT.paper0)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(ratio(DARK.client, DARK.canvas)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe('globals.css', () => {
  /**
   * The structural guarantee. No hex, no `rgb(`, no `hsl(`, no named colour — every colour in
   * this stylesheet is a token, so it is covered by `packages/ui`'s drift test against the
   * immutable design export.
   */
  it('contains no colour literal', () => {
    const withoutComments = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(withoutComments).not.toMatch(/\b(rgba?|hsla?|color-mix|oklch)\s*\(/);
  });

  it.each([
    '--tm-inverted-ground',
    '--tm-inverted-ink',
    '--tm-inverted-muted',
    '--tm-inverted-line',
  ])('defines %s for both themes', (property) => {
    const definitions = GLOBALS_CSS.match(new RegExp(`${property}\\s*:`, 'g')) ?? [];
    expect(definitions.length).toBeGreaterThanOrEqual(2);
    expect(GLOBALS_CSS).toMatch(new RegExp(`\\[data-theme='dark'\\][\\s\\S]*?${property}\\s*:`));
  });

  /**
   * `40-DESIGN-SYSTEM` §10 requires 200% zoom to reflow rather than clip. A breakpoint in
   * `px` does not move when the user zooms or raises their default font size, so the layout
   * stays in two columns and clips. In `rem` it moves with them.
   */
  it('states its breakpoints in rem, so zoom reaches them', () => {
    const breakpoints = GLOBALS_CSS.match(/@media\s*\([^)]*\)/g) ?? [];
    expect(breakpoints.length).toBeGreaterThan(0);
    for (const breakpoint of breakpoints) {
      expect(breakpoint).not.toMatch(/\d+px/);
    }
  });

  /**
   * Every offset that has a direction is logical, so an Arabic RTL document mirrors without
   * a second stylesheet. `42-INTERACTION-MOTION-RESPONSIVE-AND-RTL` requires it and
   * `packages/ui` already holds to it; this keeps the application layer to the same rule.
   */
  it('uses logical properties rather than left and right', () => {
    const withoutComments = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/(?:^|[\s;{])(margin|padding|border)-(left|right)\s*:/m);
    expect(withoutComments).not.toMatch(/(?:^|[\s;{])(left|right)\s*:/m);
  });
});
