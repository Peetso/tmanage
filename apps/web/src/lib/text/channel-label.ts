/** Unicode FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE. */
const FSI = '\u2068';
const PDI = '\u2069';

/**
 * FIX2 item 14 — a channel's display label, `#name`, isolated for bidi.
 *
 * In an Arabic (RTL) line a Latin, hyphenated name such as `atlas-website-relaunch` was reordered
 * around its `#` and hyphens: the header drew "atlas-website- #" over "relaunch", and the composer
 * hint ended "…relaunch#". Wrapping the label in FSI…PDI keeps `#` and the name together in their
 * own direction (Latin names left-to-right, Arabic names right-to-left) whatever surrounds them.
 * Plain text, so it works in headings, `title`, `placeholder` and `aria-label` alike, where a
 * `<bdi>` element cannot go.
 */
export function channelLabel(name: string): string {
  return `${FSI}#${name}${PDI}`;
}

/** Any user-supplied name in running text, isolated the same way (no `#`). */
export function isolate(text: string): string {
  return `${FSI}${text}${PDI}`;
}
