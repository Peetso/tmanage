import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AA_NON_TEXT, AA_NORMAL_TEXT, contrastRatio, meetsAA } from '../src/a11y/contrast.js';
import { colorDark, colorLight } from '../src/tokens/tokens.js';

/**
 * The palette check the component harness cannot do.
 *
 * jsdom has no paint, so axe-core reports `color-contrast` as *incomplete* rather than as
 * a pass — see `tests/axe.ts`. These assertions compute the ratio from the token values
 * instead. That does not prove what a browser renders (a translucent overlay, a gradient,
 * or an inherited colour can still ruin a pairing at runtime, and 200% zoom and real
 * screen-reader passes remain open human-validation items), but it does prove the palette
 * the components are built from, which nothing had checked before UI-001.
 */

const ABSOLUTE_INK = '#090A09';

describe("the export's own 'Verified pairings' line", () => {
  /**
   * `docs/design/source/project/design/tokens/themes-light-dark-high-contrast.md` states
   * five ratios. All five hold as accessibility claims — but not one of the printed
   * figures is the ratio WCAG 2.2 actually produces, and every one of them is *lower* than
   * the real value. The assertion is therefore "at least as good as claimed", and the
   * measured value is recorded beside it so the discrepancy is visible rather than
   * quietly corrected.
   */
  const claims = [
    {
      name: 'ink on lime, light',
      fg: ABSOLUTE_INK,
      bg: colorLight.lime['500'],
      claimed: 12.9,
      measured: 16.48,
    },
    {
      name: 'ink on surface 1, dark',
      fg: colorDark.ink,
      bg: colorDark.surface1,
      claimed: 14.1,
      measured: 15.63,
    },
    {
      name: 'muted on surface 1, dark',
      fg: colorDark.muted,
      bg: colorDark.surface1,
      claimed: 6.4,
      measured: 7.32,
    },
    {
      name: 'lime on canvas, dark',
      fg: colorDark.lime,
      bg: colorDark.canvas,
      claimed: 11.6,
      measured: 13.25,
    },
    {
      name: 'warning on surface 1, dark',
      fg: colorDark.warning,
      bg: colorDark.surface1,
      claimed: 6.9,
      measured: 8.27,
    },
  ];

  it.each(claims)('$name is at least the claimed $claimed:1', ({ fg, bg, claimed, measured }) => {
    const actual = contrastRatio(fg, bg);
    expect(actual).toBeGreaterThanOrEqual(claimed);
    expect(actual).toBeCloseTo(measured, 1);
    expect(actual).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe('law 1 — text on lime is ink, and white on lime is prohibited', () => {
  it('ink on lime passes AA in both themes', () => {
    expect(meetsAA(ABSOLUTE_INK, colorLight.lime['500'])).toBe(true);
    expect(meetsAA(ABSOLUTE_INK, colorDark.lime)).toBe(true);
  });

  it('white on lime is nowhere near legible, which is why the law exists', () => {
    expect(contrastRatio(colorLight.paper['0'], colorLight.lime['500'])).toBeLessThan(2);
  });

  it('the themed ink token cannot be used on lime, because it inverts', () => {
    // In dark, `--ink-950` resolves to #F5F6F0. That is the trap `--tm-ink-absolute`
    // exists to close, and this is the number that proves the trap is real.
    expect(contrastRatio(colorDark.ink, colorDark.lime)).toBeLessThan(AA_NORMAL_TEXT);
  });
});

describe('every text pairing the primitives actually paint', () => {
  const pairings = [
    { name: 'body text on paper', fg: colorLight.ink['800'], bg: colorLight.paper['0'] },
    { name: 'body text on canvas', fg: colorLight.ink['800'], bg: colorLight.paper['150'] },
    { name: 'hint text on paper', fg: colorLight.ink['650'], bg: colorLight.paper['0'] },
    { name: 'placeholder on paper', fg: colorLight.ink['500'], bg: colorLight.paper['0'] },
    { name: 'ink button', fg: colorLight.paper['0'], bg: colorLight.ink['950'] },
    { name: 'lime button', fg: ABSOLUTE_INK, bg: colorLight.lime['500'] },
    { name: 'lime button, pressed', fg: ABSOLUTE_INK, bg: colorLight.lime['600'] },
    { name: 'destructive button', fg: ABSOLUTE_INK, bg: colorLight.danger['600'] },
    { name: 'outline button label', fg: colorLight.ink['800'], bg: colorLight.paper['0'] },
    { name: 'client badge', fg: colorLight.client['500'], bg: colorLight.paper['0'] },
    { name: 'state capsule label', fg: colorLight.ink['800'], bg: colorLight.paper['0'] },
    { name: 'field error message', fg: colorLight.ink['800'], bg: colorLight.paper['0'] },
    { name: 'ink button, dark', fg: colorDark.surface1, bg: colorDark.ink },
    { name: 'body text, dark', fg: colorDark.ink, bg: colorDark.surface1 },
    { name: 'muted text, dark', fg: colorDark.muted, bg: colorDark.surface1 },
    { name: 'destructive button, dark', fg: ABSOLUTE_INK, bg: colorDark.danger },
  ];

  it.each(pairings)('$name meets AA for normal text', ({ fg, bg }) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe('the tinted glyphs and borders, which are non-text and need 3:1', () => {
  const marks = [
    { name: 'success glyph on paper', fg: colorLight.success['600'], bg: colorLight.paper['0'] },
    { name: 'warning glyph on paper', fg: colorLight.warning['600'], bg: colorLight.paper['0'] },
    { name: 'danger glyph on paper', fg: colorLight.danger['600'], bg: colorLight.paper['0'] },
    { name: 'client ring on paper', fg: colorLight.client['500'], bg: colorLight.paper['0'] },
  ];

  it.each(marks)('$name meets the 3:1 non-text threshold', ({ fg, bg }) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  /**
   * Three of those four fail as *text*, which is the whole reason the component layer
   * moves the tint onto the glyph and leaves the word in ink. Asserting the failure keeps
   * the reason from being refactored away by someone who thinks the extra rule is noise.
   */
  it.each([
    { name: 'success', hex: colorLight.success['600'] },
    { name: 'warning', hex: colorLight.warning['600'] },
    { name: 'danger', hex: colorLight.danger['600'] },
  ])('$name is below AA as text on paper, and is therefore never used as text', ({ hex }) => {
    expect(contrastRatio(hex, colorLight.paper['0'])).toBeLessThan(AA_NORMAL_TEXT);
  });

  /**
   * The live dot is lime, and lime on paper is 1.20:1 — invisible as a boundary. The dot
   * carries a 1px ink ring for exactly that reason, and the ring is what has to pass.
   */
  it('the lime status dot is unreadable without its ink ring', () => {
    expect(contrastRatio(colorLight.lime['500'], colorLight.paper['0'])).toBeLessThan(AA_NON_TEXT);
    expect(contrastRatio(colorLight.ink['950'], colorLight.paper['0'])).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
  });

  /**
   * A known gap, asserted so it cannot be forgotten: the quiet line is 1.71:1 on paper,
   * below the 3:1 that WCAG 1.4.11 asks of a control boundary. It is a property of the
   * design export's palette, not of this package, and the high-contrast theme promotes it
   * to `line.700` (13.73:1). Recorded in `docs/implementation-status.md`.
   */
  it('the quiet line does not meet 3:1, and high contrast is what fixes it', () => {
    expect(contrastRatio(colorLight.line['300'], colorLight.paper['0'])).toBeLessThan(AA_NON_TEXT);
    expect(contrastRatio(colorLight.line['700'], colorLight.paper['0'])).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
  });

  /**
   * The combobox's active option is a keyboard focus indicator — the *virtual* focus of
   * `aria-activedescendant` — so WCAG 1.4.11 owes it 3:1. The paper-150 background shift
   * alone is ~1.2:1 in both themes (found by the review fleet's token-law lens and
   * asserted here so the ring can never be dropped as decoration): the inset ink ring is
   * the carrier that passes.
   */
  it('the active-option paper shift is invisible; its ink ring is what passes 1.4.11', () => {
    expect(contrastRatio(colorLight.paper['150'], colorLight.paper['0'])).toBeLessThan(AA_NON_TEXT);
    expect(contrastRatio(colorDark.canvas, colorDark.surface1)).toBeLessThan(AA_NON_TEXT);
    expect(contrastRatio(colorLight.ink['950'], colorLight.paper['150'])).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
    expect(contrastRatio(colorDark.ink, colorDark.canvas)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe('the danger word (`--tm-danger-text`, SEC-TRACKER)', () => {
  /**
   * Read from the style sheet itself, so a change to the value there is measured here: the light
   * value (`:root`), the dark value (`[data-theme='dark']`) and the high-contrast value.
   */
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/styles/components.css'),
    'utf8',
  );
  const values = [...css.matchAll(/--tm-danger-text:\s*(#[0-9a-f]{6})/giu)].map((m) => m[1] ?? '');
  const [light, dark, high] = values;

  it('is declared for light, dark and high contrast', () => {
    expect(values).toHaveLength(4);
    expect(values[3]).toBe(dark);
  });

  it.each([
    ['light, on paper', light, colorLight.paper['0']],
    ['light, on the selected row', light, colorLight.lime['100']],
    ['high contrast, on paper', high, colorLight.paper['0']],
    ['high contrast, on the selected row', high, colorLight.lime['100']],
    ['dark, on the card', dark, colorDark.surface2],
    ['dark, on paper', dark, colorDark.surface1],
    ['dark, on the selected row', dark, colorDark.limePlane],
  ])('%s meets AA for normal text', (_name, fg, bg) => {
    expect(contrastRatio(fg ?? '', bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe('the switch, on (Figma 8:129 / 732:793)', () => {
  it('draws a lime thumb that stands out from its ink track, in both themes', () => {
    expect(contrastRatio(colorDark.lime, ABSOLUTE_INK)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(contrastRatio(colorLight.lime['500'], ABSOLUTE_INK)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it('shows the ink track against the light paper', () => {
    expect(contrastRatio(ABSOLUTE_INK, colorLight.paper['0'])).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it('outlines the ink track in the themed ink, visible on the dark paper', () => {
    expect(contrastRatio(colorDark.ink, colorDark.surface1)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});
