/**
 * Peter 2026-11-09 — the company's own brand colour in place of the TManage lime.
 *
 * The owner picks one colour (Control › Organization › Brand colour); it is stored on the
 * organization's branding row (`PUT …/admin/branding`, `org.manage`) and every member's app
 * repaints its accent tokens with it. The lime tokens stay the single source the stylesheets read
 * (`--lime-500`, `--lime-600`, `--lime-100`), so one override reaches every accent surface, and
 * `--tm-on-lime` — the text drawn on the accent — is picked for contrast, dark or light.
 * `--tm-accent-on-ink` is the accent drawn as text or a glyph on the dark surfaces, lightened when
 * a dark brand colour would vanish there (FIX4 item 5).
 */

/** The TManage lime (`tokens.css` `--lime-500`). Saving it is "Reset to TManage lime". */
export const TMANAGE_LIME = '#b7ff57';

const ABSOLUTE_INK = '#090a09';
const ABSOLUTE_PAPER = '#ffffff';

/** `#RGB` / `#RRGGBB` → lower-case `#rrggbb`; `null` for anything else. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value.trim());
  if (!match?.[1]) return null;
  const raw = match[1].toLowerCase();
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  return `#${full}`;
}

function channels(hex: string): readonly [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG 2 relative luminance. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** The text colour for the accent: ink or white, whichever reads better (WCAG contrast). */
export function textOnAccent(accent: string): string {
  return contrastRatio(ABSOLUTE_INK, accent) >= contrastRatio(ABSOLUTE_PAPER, accent)
    ? ABSOLUTE_INK
    : ABSOLUTE_PAPER;
}

/** The darkest-but-one surface the accent is drawn on as a glyph or word (`--ink-800`). */
const DARK_SURFACE = '#232521';
const ACCENT_TEXT_CONTRAST = 4.5;

function mixWithWhite(hex: string, share: number): string {
  const mixed = channels(hex).map((value) => Math.round(value + (255 - value) * share));
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * FIX4 item 5. The accent as a *foreground* on the always-dark surfaces (the "+" orb of New work,
 * mono tags on ink capsules): the accent itself when it reads there (4.5:1 against `--ink-800`),
 * otherwise the accent lightened just enough to read. A navy brand colour made the "+" vanish.
 */
export function accentOnInk(accent: string): string {
  const hex = normalizeHex(accent) ?? TMANAGE_LIME;
  for (let step = 0; step <= 20; step += 1) {
    const candidate = mixWithWhite(hex, step / 20);
    if (contrastRatio(candidate, DARK_SURFACE) >= ACCENT_TEXT_CONTRAST) return candidate;
  }
  return ABSOLUTE_PAPER;
}

/** Whether a stored colour is the TManage lime (no override needed). */
export function isTmanageLime(accent: string): boolean {
  return normalizeHex(accent) === TMANAGE_LIME;
}

/**
 * The stylesheet that repaints the accent tokens. The selector is doubled so it outranks both
 * `:root` and `[data-theme='dark']` in `tokens.css`, whatever order the sheets load in; the tints
 * mix with the themed paper, so they stay light in the light theme and dark in the dark one.
 */
export function accentStylesheet(accent: string): string | null {
  const hex = normalizeHex(accent);
  if (hex === null || hex === TMANAGE_LIME) return null;
  const on = textOnAccent(hex);
  return (
    `:root:root,[data-theme][data-theme]{` +
    `--brand-accent:${hex};` +
    `--lime-500:${hex};` +
    `--lime-600:color-mix(in srgb,${hex} 82%,#000);` +
    `--lime-100:color-mix(in srgb,${hex} 22%,var(--paper-0));` +
    `--tm-on-lime:${on};` +
    `--tm-accent-on-ink:${accentOnInk(hex)};` +
    `--tm-accent-on-ink-deep:${accentOnInk(hex)};` +
    `}`
  );
}
