/**
 * WCAG 2.x contrast arithmetic.
 *
 * This exists because the one accessibility property the component harness cannot check
 * is the one the design system depends on most. jsdom has no layout and no paint, so
 * axe-core's `color-contrast` rule cannot run there — it reports the pairing as
 * "incomplete", not as a pass. Computing the ratio from the token values instead is not a
 * substitute for a real browser check of *rendered* text, but it does prove the palette
 * itself, which is what `docs/design/source/project/design/tokens/`'s "Verified pairings"
 * line asserts and nothing had yet verified.
 *
 * Formula: WCAG 2.2 relative luminance and contrast ratio.
 */

/** `#RGB` or `#RRGGBB`, with or without the hash. */
export function parseHex(hex: string): { r: number; g: number; b: number } {
  const raw = hex.trim().replace(/^#/, '');
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a hex colour: ${hex}`);
  }

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function channelLuminance(value8Bit: number): number {
  const c = value8Bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** Contrast ratio between two opaque colours, 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * WCAG 2.2 AA thresholds. `40-DESIGN-SYSTEM` §10 sets AA as the target.
 *
 * Large text is 18.66px bold or 24px regular; the design system's `heading.*` and
 * `display.*` roles qualify, `body.*`, `ui.*` and `caption` do not.
 */
export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
export const AA_NON_TEXT = 3;

export function meetsAA(
  foreground: string,
  background: string,
  size: 'normal' | 'large' = 'normal',
): boolean {
  const required = size === 'large' ? AA_LARGE_TEXT : AA_NORMAL_TEXT;
  return contrastRatio(foreground, background) >= required;
}
