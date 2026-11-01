import type { ReactElement } from 'react';

/**
 * R4 slice 9 — the 16 px media glyphs from the Icon/* set (Figma Icon/Play `459:22168`,
 * Icon/Pause `459:22171`, Icon/Waveform `459:22174`, Icon/Volume `459:22208`,
 * Icon/FrameStep `459:22214`, Icon/Comment `459:22217`, Icon/Download `459:22188`), drawn the same
 * way as `viewer-icons.tsx`: stroked in `currentColor`, always decorative — the control around a
 * glyph carries the words.
 */
export type MediaIconName =
  | 'play'
  | 'pause'
  | 'waveform'
  | 'volume'
  | 'muted'
  | 'frame-step'
  | 'comment'
  | 'download'
  | 'plus';

const PATHS: Record<MediaIconName, ReactElement> = {
  play: <path d="M5 3.2v9.6L12.5 8z" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  waveform: <path d="M2.5 7v2M5 5v6M7.5 3v10M10 5.5v5M12.5 7v2" />,
  volume: (
    <>
      <path d="M2.5 6h2.5L8.5 3v10L5 10H2.5z" />
      <path d="M11 5.5a3.5 3.5 0 0 1 0 5" />
    </>
  ),
  muted: (
    <>
      <path d="M2.5 6h2.5L8.5 3v10L5 10H2.5z" />
      <path d="M11 6l3 4M14 6l-3 4" />
    </>
  ),
  'frame-step': <path d="M4 3.5L9.5 8 4 12.5zM12 3.5v9" />,
  comment: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  download: <path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
};

export function MediaIcon({
  name,
  className,
}: {
  readonly name: MediaIconName;
  readonly className?: string;
}) {
  return (
    <svg
      className={['tm-media-icon', className].filter(Boolean).join(' ')}
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
