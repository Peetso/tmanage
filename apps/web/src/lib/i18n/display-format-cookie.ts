import {
  DISPLAY_DATE_FORMATS,
  DISPLAY_NUMERALS,
  type DisplayDateFormat,
  type DisplayNumerals,
} from '../api/display-preferences';
import type { DisplayFormat } from './display-format';

/**
 * FIX6 locale flash — the saved digit shapes and date layout as a first-party cookie, beside the
 * saved-locale cookie (`locale-cookie.ts`), so a per-request server render formats numbers and
 * dates the way the member chose and the browser starts from the same value: no frame with the
 * locale's own digits before the profile loads.
 *
 * A display preference, not a credential: readable by the page, `SameSite=Lax`, one year, `Secure`
 * on https. The value is `<numerals>.<dateFormat>` (either side may be empty), and each side is
 * checked against {@link DISPLAY_NUMERALS} / {@link DISPLAY_DATE_FORMATS} wherever it is read, so a
 * crafted value never reaches a formatter.
 */

export const DISPLAY_FORMAT_COOKIE_NAME = 'tmanage_display_format';

const MAX_AGE = 31_536_000;

const NUMERALS: ReadonlySet<string> = new Set(DISPLAY_NUMERALS);
const DATE_FORMATS: ReadonlySet<string> = new Set(DISPLAY_DATE_FORMATS);

function isNumerals(value: string): value is DisplayNumerals {
  return NUMERALS.has(value);
}

function isDateFormat(value: string): value is DisplayDateFormat {
  return DATE_FORMATS.has(value);
}

/** The allowlisted format a raw cookie value names; `{}` for anything else. */
export function displayFormatFromCookieValue(value: string | null | undefined): DisplayFormat {
  if (typeof value !== 'string') return {};
  const [numerals = '', dateFormat = '', ...rest] = value.split('.');
  if (rest.length > 0) return {};
  return {
    ...(isNumerals(numerals) ? { numerals } : {}),
    ...(isDateFormat(dateFormat) ? { dateFormat } : {}),
  };
}

/** The `document.cookie` assignment that saves `format`. */
export function displayFormatCookieString(format: DisplayFormat, secure: boolean): string {
  return (
    `${DISPLAY_FORMAT_COOKIE_NAME}=${format.numerals ?? ''}.${format.dateFormat ?? ''}; Path=/; ` +
    `Max-Age=${MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`
  );
}

/** Save `format` in the cookie. A browser that refuses cookies keeps the in-page format. */
export function writeDisplayFormatCookie(format: DisplayFormat): void {
  if (typeof globalThis.document === 'undefined') return;
  try {
    const secure = globalThis.location?.protocol === 'https:';
    globalThis.document.cookie = displayFormatCookieString(format, secure);
  } catch {
    // Cookies blocked: the next load formats with the locale's own digits until the profile loads.
  }
}

/** The format saved in this browser's cookie; `{}` when none (or on the server). */
export function readDisplayFormatCookie(): DisplayFormat {
  if (typeof globalThis.document === 'undefined') return {};
  try {
    for (const part of globalThis.document.cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1 || part.slice(0, eq).trim() !== DISPLAY_FORMAT_COOKIE_NAME) continue;
      return displayFormatFromCookieValue(part.slice(eq + 1).trim());
    }
  } catch {
    // Unreadable cookies: the locale's own digits and layout.
  }
  return {};
}
