import type { ReactElement } from 'react';

/**
 * Web/Icon — the website's 16 px line icons (Website components §00).
 *
 * Drawn on a 16 px grid in `currentColor`; the stroke weight is `--b-expressive` and is set in
 * `website.css`, so no value here is a one-off. Direction-bearing glyphs (arrow, chevron-end)
 * carry `tm-web-icon--flip` and mirror under `dir="rtl"`.
 */
export type WebIconName =
  | 'chevron-down'
  | 'menu'
  | 'close'
  | 'play'
  | 'work'
  | 'flag'
  | 'bolt'
  | 'chat'
  | 'calendar'
  | 'doc'
  | 'portal'
  | 'check'
  | 'chart'
  | 'grid'
  | 'briefcase'
  | 'building'
  | 'trend'
  | 'person'
  | 'list'
  | 'book'
  | 'layers'
  | 'pencil'
  | 'help'
  | 'pulse'
  | 'shield'
  | 'linkedin'
  | 'video'
  | 'mail'
  | 'plus'
  | 'minus'
  | 'arrow-right'
  | 'arrow-down'
  | 'search'
  | 'quote'
  | 'globe'
  | 'link'
  | 'lock'
  | 'id';

const FLIPS: ReadonlySet<WebIconName> = new Set(['arrow-right']);

const PATHS: Record<WebIconName, ReactElement> = {
  'chevron-down': <path d="M4 6l4 4 4-4" />,
  menu: <path d="M3.5 4.5h9M3.5 8h9M3.5 11.5h9" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  play: <path className="tm-web-icon__fill" d="M5 3.25v9.5L12.5 8z" />,
  work: (
    <>
      <path d="M2.5 5h5M10.5 5h3M2.5 11h2M7.5 11h6" />
      <circle cx="9" cy="5" r="1.5" />
      <circle cx="6" cy="11" r="1.5" />
    </>
  ),
  flag: <path d="M4 14.5V2.5h8l-1.75 3 1.75 3H4" />,
  bolt: <path className="tm-web-icon__fill" d="M9.25 1.5L3.5 9h4L6.75 14.5 12.5 7h-4z" />,
  chat: <path d="M2.5 3h11v8H7.5l-3 2.5V11h-2z" />,
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 7h11M5.5 2v3M10.5 2v3" />
    </>
  ),
  doc: <path d="M4 1.75h5.25l2.75 2.75v9.75H4zM6.25 8h3.5M6.25 11h3.5" />,
  portal: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12M5 9.5h6" />
    </>
  ),
  check: <path d="M3.5 8.5l3 3 6-6.5" />,
  chart: <path d="M2.5 13.5h11M5 11V8M8 11V5M11 11V7" />,
  grid: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </>
  ),
  briefcase: (
    <>
      <rect x="2" y="5" width="12" height="8.5" rx="1.5" />
      <path d="M6 5V3h4v2M2 8.75h12" />
    </>
  ),
  building: <path d="M3 14V2.5h6V14M9 6.5h4V14M2 14h12M5 5h2M5 8h2M5 11h2" />,
  trend: <path d="M2.5 11.5l4-4 2.5 2.5 4.5-5M10 5h3.5v3.5" />,
  person: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5" />
    </>
  ),
  list: <path d="M6 4h7.5M6 8h7.5M6 12h7.5M2.75 4h.5M2.75 8h.5M2.75 12h.5" />,
  book: (
    <path d="M8 4.5v9M2 3.5h4a2 2 0 0 1 2 2 2 2 0 0 1 2-2h4v9h-4a2 2 0 0 0-2 1.5 2 2 0 0 0-2-1.5H2z" />
  ),
  layers: <path d="M8 2l6 3.25-6 3.25-6-3.25zM2 8.25l6 3.25 6-3.25M2 11.25l6 3.25 6-3.25" />,
  pencil: <path d="M10.5 2.5l3 3L6 13H3v-3z" />,
  help: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.25 6.25a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.75.6-.75 1.15v.5M8 11.5v.01" />
    </>
  ),
  pulse: <path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" />,
  shield: <path d="M8 1.75l5.25 2v4c0 3.25-2.25 5.5-5.25 6.5-3-1-5.25-3.25-5.25-6.5v-4z" />,
  linkedin: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 7v4.5M5 4.75v.01M7.75 11.5V7M7.75 9a1.75 1.75 0 0 1 3.5 0v2.5" />
    </>
  ),
  video: (
    <>
      <rect x="1.5" y="3.5" width="13" height="9" rx="2" />
      <path className="tm-web-icon__fill" d="M6.5 6v4L10 8z" />
    </>
  ),
  mail: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="M2.5 4.5L8 9l5.5-4.5" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  'arrow-right': <path d="M2.5 8h11M9.5 4l4 4-4 4" />,
  'arrow-down': <path d="M8 2.5v11M4 9.5l4 4 4-4" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5l3 3" />
    </>
  ),
  quote: (
    <path
      className="tm-web-icon__fill"
      d="M3 12.5V9.25C3 6.5 4.25 4.75 6.75 3.75l.5 1.25C6 5.6 5.4 6.6 5.35 8H7v4.5zm6 0V9.25c0-2.75 1.25-4.5 3.75-5.5l.5 1.25c-1.25.6-1.85 1.6-1.9 3H13v4.5z"
    />
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.75 1.75 2.5 3.75 2.5 6S9.75 12.25 8 14C6.25 12.25 5.5 10.25 5.5 8S6.25 3.75 8 2z" />
    </>
  ),
  link: (
    <path d="M7 9a2.5 2.5 0 0 0 3.5 0l2.25-2.25a2.5 2.5 0 0 0-3.5-3.5L8.5 4M9 7a2.5 2.5 0 0 0-3.5 0L3.25 9.25a2.5 2.5 0 0 0 3.5 3.5L7.5 12" />
  ),
  lock: (
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  id: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="6" cy="7.5" r="1.5" />
      <path d="M4 11c.4-1 1.1-1.5 2-1.5s1.6.5 2 1.5M10 6.5h2M10 9h2" />
    </>
  ),
};

export interface WebIconProps {
  name: WebIconName;
  /** Rendered size in px; the drawing stays on the 16 px grid. Defaults to 16. */
  size?: 12 | 14 | 16 | 20 | 24;
  className?: string;
}

export function WebIcon({ name, size = 16, className }: WebIconProps) {
  const classes = ['tm-web-icon', FLIPS.has(name) ? 'tm-web-icon--flip' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
