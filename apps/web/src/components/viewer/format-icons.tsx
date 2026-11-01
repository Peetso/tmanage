import type { ReactElement } from 'react';

/**
 * R4 slice 10 — the 16 px glyphs the PSD, ZIP, Office and "no preview" stages use, from the
 * Icon/* set (Figma Icon/Folder `459:22197`, Icon/File `459:22201`, Icon/Eye `459:22182`,
 * Icon/EyeOff `459:22185`, Icon/Chevron `459:22191`, Icon/Download `459:22188`,
 * Icon/Layers `459:22178`). Stroked in `currentColor`; always decorative.
 */
export type FormatIconName =
  'folder' | 'file' | 'eye' | 'eye-off' | 'chevron' | 'download' | 'layers' | 'prev' | 'next';

const PATHS: Record<FormatIconName, ReactElement> = {
  folder: (
    <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
  ),
  file: <path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3" />,
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M2.5 2.5l11 11" />
      <path d="M6.2 4A6.9 6.9 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11.5 11.5 0 0 1-1.9 2.4M10.1 11.9A6 6 0 0 1 8 12.5C4 12.5 1.5 8 1.5 8a11.7 11.7 0 0 1 2.4-2.8" />
    </>
  ),
  chevron: <path d="M4 6l4 4 4-4" />,
  download: <path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" />,
  layers: <path d="M8 2.5l6 3-6 3-6-3zM2 8.5l6 3 6-3M2 11l6 3 6-3" />,
  prev: <path d="M10 3.5L5.5 8l4.5 4.5" />,
  next: <path d="M6 3.5L10.5 8 6 12.5" />,
};

export function FormatIcon({
  name,
  className,
}: {
  readonly name: FormatIconName;
  readonly className?: string | undefined;
}) {
  return (
    <svg
      className={['tm-format-icon', className].filter(Boolean).join(' ')}
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
