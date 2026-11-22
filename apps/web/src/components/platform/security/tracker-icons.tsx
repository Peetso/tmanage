import type { ReactElement } from 'react';

/**
 * The four 16 px glyphs the Attack tracker draws, from the TManage Icon/* set as the Figma frames
 * use them (Icon/Refresh 840:1669, Icon/More 840:1721, Icon/Trash in the Allowlist rows, Icon/Close
 * on the side sheet and dialogs). Stroked in `currentColor`; always decorative, the control around
 * a glyph carries its name.
 */
export type TrackerIconName = 'refresh' | 'more' | 'trash' | 'close';

const PATHS: Readonly<Record<TrackerIconName, ReactElement>> = {
  refresh: <path d="M13.33 7.33a5.33 5.33 0 1 0-1.53 3.8M13.33 7.33V2.67M13.33 7.33H8.67" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="0.8" fill="currentColor" />
      <circle cx="8" cy="8" r="0.8" fill="currentColor" />
      <circle cx="12.5" cy="8" r="0.8" fill="currentColor" />
    </>
  ),
  trash: <path d="M2.5 4.5h11M6 4.5v-2h4v2M4 4.5l.7 9h6.6l.7-9" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
};

export function TrackerIcon({ name }: { readonly name: TrackerIconName }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
