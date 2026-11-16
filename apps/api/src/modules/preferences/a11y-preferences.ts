import { ApiError } from '../../common/http/errors.js';
import { A11Y_FONT_SCALES } from '../../common/database/schema.js';
import type { A11yFontScale, A11yPreferences } from '../../common/database/schema.js';

/**
 * A11Y-183 accessibility preferences — the shape, defaults and validation shared by the member
 * route (`a11y.controller.ts`) and the client portal route (`portal-a11y.controller.ts`), so the two
 * audiences cannot drift apart on what a valid setting is.
 *
 * PUT is a full replacement over a fixed-key allowlist: an unknown key (including any attempt to
 * name a membership), a font scale off the closed vocabulary, or a non-boolean toggle is a 400 and
 * nothing is written.
 */

/** What the GET/PUT routes exchange: the three accessibility settings, without row identity. */
export interface A11yPreferencesView {
  readonly fontScale: A11yFontScale;
  readonly reduceMotion: boolean;
  readonly highContrast: boolean;
}

/** The shipped defaults an unsaved person is reached by: medium type, motion and contrast normal. */
export const DEFAULT_A11Y_PREFERENCES: A11yPreferencesView = {
  fontScale: 'md',
  reduceMotion: false,
  highContrast: false,
};

/** The only keys a PUT body may carry — anything else is a 400 (fixed-key allowlist). */
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['fontScale', 'reduceMotion', 'highContrast']);

export function a11yViewOf(settings: A11yPreferences): A11yPreferencesView {
  return {
    fontScale: settings.fontScale,
    reduceMotion: settings.reduceMotion,
    highContrast: settings.highContrast,
  };
}

export function parseA11yPreferences(body: unknown): A11yPreferences {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  // Fixed-key allowlist: a key the store has no column for is the client's error, not a silent drop.
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      details.push({ field: key, message: 'is not a known preference' });
    }
  }

  const scale = value['fontScale'];
  if (!(A11Y_FONT_SCALES as readonly unknown[]).includes(scale)) {
    details.push({
      field: 'fontScale',
      message: `must be one of ${A11Y_FONT_SCALES.join(', ')}`,
    });
  }

  const bool = (field: string): boolean => {
    const raw = value[field];
    if (typeof raw !== 'boolean') {
      details.push({ field, message: 'must be a boolean' });
      return false;
    }
    return raw;
  };

  const reduceMotion = bool('reduceMotion');
  const highContrast = bool('highContrast');

  if (details.length > 0) {
    throw new ApiError(
      400,
      'validation_failed',
      'The accessibility preferences are invalid',
      details,
    );
  }

  return { fontScale: scale as A11yFontScale, reduceMotion, highContrast };
}
