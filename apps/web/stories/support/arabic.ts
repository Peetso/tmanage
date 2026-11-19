import { activeLocale } from '../../src/lib/i18n/locale-store';

/**
 * T5 D10 — a story in real Arabic: the Arabic catalogue (`ar-EG`, preloaded in Storybook) and the
 * right-to-left direction together. The harness's own `rtl` variant mirrors the English catalogue
 * and so proves the mirroring only; a story spread with this shows the Arabic copy, the `<bdi>`
 * isolates and the locale's digits, which is what FIGMA-D fixes 9, 20, 21 and 40 are checked on.
 * The locale is put back when the story unmounts, so the next story is English again.
 */
export const ARABIC_STORY = {
  globals: { direction: 'rtl' },
  beforeEach: () => {
    activeLocale.set('ar-EG');
    return () => activeLocale.set('en-US');
  },
} as const;
