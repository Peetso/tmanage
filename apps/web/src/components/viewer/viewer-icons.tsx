import type { ReactElement } from 'react';

/**
 * The 16 px viewer glyphs from the Icon/* set (Figma `459:22158` … `459:22339`): Cursor, Pin, Box,
 * Download, Back, Chevron, Minus, Plus, Refresh, Lock, Eye, At, Close, Comment, Check. Stroked in
 * `currentColor`, so a glyph takes the colour of the control it sits in; always decorative — the
 * control around it carries the words.
 */
export type ViewerIconName =
  | 'cursor'
  | 'pin'
  | 'box'
  | 'download'
  | 'back'
  | 'chevron'
  | 'minus'
  | 'plus'
  | 'refresh'
  | 'lock'
  | 'eye'
  | 'at'
  | 'close'
  | 'comment'
  | 'check';

const PATHS: Record<ViewerIconName, ReactElement> = {
  cursor: <path d="M3.5 2.5l9 4.2-3.9 1.1-1.1 3.9z" />,
  pin: (
    <>
      <path d="M8 14.5s4.5-4.1 4.5-7.6a4.5 4.5 0 1 0-9 0c0 3.5 4.5 7.6 4.5 7.6z" />
      <circle cx="8" cy="6.9" r="1.6" />
    </>
  ),
  box: <path d="M3 5V3h2M11 3h2v2M13 11v2h-2M5 13H3v-2M7 3h2M7 13h2M3 7v2M13 7v2" />,
  download: <path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" />,
  back: <path d="M10 3.5L5.5 8l4.5 4.5" />,
  chevron: <path d="M6 3.5L10.5 8 6 12.5" />,
  minus: <path d="M3.5 8h9" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  refresh: <path d="M12.5 5.5A5 5 0 1 0 13 9M12.5 2.5v3h-3" />,
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  at: (
    <>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M10.5 8v1a1.75 1.75 0 0 0 3.5 0V8a6 6 0 1 0-2.4 4.8" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  comment: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  check: <path d="M3 8.5l3 3 7-7" />,
};

export function ViewerIcon({
  name,
  className,
}: {
  readonly name: ViewerIconName;
  readonly className?: string;
}) {
  return (
    <svg
      className={['tm-viewer-icon', className].filter(Boolean).join(' ')}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
