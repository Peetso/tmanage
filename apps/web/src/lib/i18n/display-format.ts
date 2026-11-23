import type { DisplayDateFormat, DisplayNumerals } from '../api/display-preferences';
import { readDisplayFormatCookie, writeDisplayFormatCookie } from './display-format-cookie';
import { requestDisplay } from './request-display';

/**
 * FIX5 item 6b (B-N7) — the member's saved *display format*: digit shapes and date layout.
 *
 * The profile stores `numerals` (`latin` / `arabic_indic`) and `dateFormat` (`iso` / `us` / `eu`
 * / `long`), but every formatter used to read the locale alone, so an Arabic member who chose
 * Latin digits and ISO dates still read "٩/١١/٢٠٢٦". `ThemeSync` now publishes the saved values
 * here when the preference loads, exactly as it publishes the language to the locale store, and
 * the shared formatters (`format.ts`, `compact-time.ts`, `use-formatters.ts`) read them on every
 * call.
 *
 * Until the preference is published (signed-out pages, first paint, unit tests, Storybook) both
 * values are unset. The layout then stays the locale's own, but the digits are Latin (0-9) in every
 * locale (AR-DIGITS, manager decision 2026-11-23): every Figma frame, Arabic included, writes
 * Latin digits, so a locale whose own default is another system (`ar-EG` → Arabic-Indic, `fa` →
 * Persian) is drawn in Latin unless the member chose otherwise in Settings › Display.
 */

export interface DisplayFormat {
  readonly numerals?: DisplayNumerals | undefined;
  readonly dateFormat?: DisplayDateFormat | undefined;
}

type Listener = () => void;

/**
 * FIX6 locale flash: the application store is {@link persisted} — it boots from the saved-format
 * cookie in the browser, saves every change there, and on the server answers with the request's
 * own cookie (`request-display.ts`), so the first HTML already shows the member's digits and the
 * browser hydrates from the same value. Stores built without it (tests) keep plain memory.
 */
export class DisplayFormatStore {
  private current: DisplayFormat;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly persisted = false) {
    this.current = persisted ? readDisplayFormatCookie() : {};
  }

  get(): DisplayFormat {
    return (this.persisted ? requestDisplay()?.format : undefined) ?? this.current;
  }

  set(next: DisplayFormat): void {
    if (next.numerals === this.current.numerals && next.dateFormat === this.current.dateFormat) {
      return;
    }
    this.current = { ...next };
    if (this.persisted) writeDisplayFormatCookie(this.current);
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const displayFormat = new DisplayFormatStore(true);

const NUMBERING: Record<DisplayNumerals, string> = { latin: 'latn', arabic_indic: 'arab' };

/** Whether `locale` already names its digit system (`-u-nu-…`), as a caller's explicit choice. */
function namesNumbering(locale: string): boolean {
  return /-u(?:-[a-z0-9]{2,8})*-nu-[a-z0-9]{3,8}/iu.test(locale);
}

const NATIVE_DEFAULT = new Map<string, boolean>();

/**
 * Whether `Intl` would draw `locale` in a digit system other than Latin when no `nu` is given
 * (CLDR's default numbering: `ar-EG` → `arab`, `fa` → `arabext`, `bn` → `beng`; `en`, `ur-PK`,
 * `ar-MA` → `latn`). Asked of the engine itself, so the answer follows its CLDR data and the
 * result digits are Latin on every engine; a tag `Intl` rejects is left for the caller to report.
 */
function defaultsToNativeDigits(locale: string): boolean {
  const known = NATIVE_DEFAULT.get(locale);
  if (known !== undefined) return known;
  let native = false;
  try {
    native = new Intl.NumberFormat(locale).resolvedOptions().numberingSystem !== 'latn';
  } catch {
    native = false;
  }
  NATIVE_DEFAULT.set(locale, native);
  return native;
}

/**
 * The BCP-47 tag to hand to `Intl` for `locale`: the one place the app decides which digits a
 * date, time or number is written in.
 *
 * - Saved numerals (Settings › Display) are forced through the Unicode `-u-nu-` extension
 *   (`ar-EG` + latin → `ar-EG-u-nu-latn`, + arabic_indic → `ar-EG-u-nu-arab`), replacing any `nu`
 *   the caller put on the tag and keeping other `-u-` keywords.
 * - Nothing saved: Latin digits by default (AR-DIGITS). A tag whose locale defaults to another
 *   system gets `-u-nu-latn`; a tag that already names its `nu`, or whose default is already
 *   Latin, is returned unchanged.
 */
export function withNumerals(
  locale: string,
  numerals: DisplayNumerals | undefined = displayFormat.get().numerals,
): string {
  if (numerals === undefined) {
    if (namesNumbering(locale) || !defaultsToNativeDigits(locale)) return locale;
    return withNumerals(locale, 'latin');
  }
  const system = NUMBERING[numerals];
  const stripped = locale.replace(/-nu-[a-z0-9]{3,8}/giu, '').replace(/-u$/iu, '');
  const at = stripped.toLowerCase().indexOf('-u-');
  if (at === -1) return `${stripped}-u-nu-${system}`;
  return `${stripped.slice(0, at)}-u-nu-${system}${stripped.slice(at + 2)}`;
}

/** Re-shapes ASCII digits for the saved numerals (used where a string is assembled by hand). */
export function shapeDigits(
  text: string,
  numerals: DisplayNumerals | undefined = displayFormat.get().numerals,
): string {
  if (numerals !== 'arabic_indic') return text;
  return text.replace(/[0-9]/gu, (digit) => String.fromCharCode(0x0660 + Number(digit)));
}

/**
 * The saved numeric day layout for an instant, or `undefined` when the layout is the locale's own
 * (unset, or `long`, which keeps the locale's month words). `iso` is `yyyy-mm-dd`, `us`
 * `mm/dd/yyyy`, `eu` `dd/mm/yyyy`; the day is read in `timeZone` when one is given.
 */
export function numericDay(
  at: Date,
  timeZone?: string,
  format: DisplayFormat = displayFormat.get(),
): string | undefined {
  const layout = format.dateFormat;
  if (layout === undefined || layout === 'long') return undefined;
  const parts = new Intl.DateTimeFormat('en-US-u-nu-latn', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  const [yyyy, mm, dd] = [part('year'), part('month'), part('day')];
  const text =
    layout === 'us'
      ? `${mm}/${dd}/${yyyy}`
      : layout === 'eu'
        ? `${dd}/${mm}/${yyyy}`
        : `${yyyy}-${mm}-${dd}`;
  return format.numerals === 'arabic_indic' ? shapeDigits(text, 'arabic_indic') : text;
}
