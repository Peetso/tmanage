import type { DisplayDateFormat, DisplayNumerals } from '../api/display-preferences';

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
 * Until the preference is published (signed-out pages, unit tests) both values are unset and the
 * formatters keep the locale's own digits and layout, which is what those pages always showed.
 */

export interface DisplayFormat {
  readonly numerals?: DisplayNumerals | undefined;
  readonly dateFormat?: DisplayDateFormat | undefined;
}

type Listener = () => void;

export class DisplayFormatStore {
  private current: DisplayFormat = {};
  private readonly listeners = new Set<Listener>();

  get(): DisplayFormat {
    return this.current;
  }

  set(next: DisplayFormat): void {
    if (next.numerals === this.current.numerals && next.dateFormat === this.current.dateFormat) {
      return;
    }
    this.current = { ...next };
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const displayFormat = new DisplayFormatStore();

const NUMBERING: Record<DisplayNumerals, string> = { latin: 'latn', arabic_indic: 'arab' };

/**
 * The BCP-47 tag to hand to `Intl` for `locale` with the saved digit shapes forced through the
 * Unicode `-u-nu-` extension (`ar-EG` + latin → `ar-EG-u-nu-latn`). Any `nu` the caller already
 * put on the tag is replaced; other `-u-` keywords are kept. Unset numerals leave the tag alone.
 */
export function withNumerals(
  locale: string,
  numerals: DisplayNumerals | undefined = displayFormat.get().numerals,
): string {
  if (numerals === undefined) return locale;
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
