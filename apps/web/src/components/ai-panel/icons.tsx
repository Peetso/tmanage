/**
 * The panel's glyphs, drawn from the design (Icon/AI assistant (generic), Icon/popout, Icon/close,
 * Icon/lock). They take `currentColor`, so each is painted by the token on its container.
 */

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** The generic AI sparkle — the design draws no assistant logos. */
export function SparkleIcon({ size = 18 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        {...STROKE}
        d="M7.875 2.8125C8.4375 5.7375 10.0125 7.3125 12.9375 7.875C10.0125 8.4375 8.4375 10.0125 7.875 12.9375C7.3125 10.0125 5.7375 8.4375 2.8125 7.875C5.7375 7.3125 7.3125 5.7375 7.875 2.8125Z"
      />
      <path
        {...STROKE}
        d="M14.0625 11.8125V13.5M14.0625 13.5V15.1875M14.0625 13.5H12.375M14.0625 13.5H15.75"
      />
    </svg>
  );
}

export function PopOutIcon({ size = 16 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        {...STROKE}
        d="M13.25 6.5V2.75H9.5M13.25 2.75L7.75 8.25M11.25 9.5V13.25H2.75V4.75H6.5"
      />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path {...STROKE} d="M4 4L8 8M8 8L12 12M8 8L12 4M8 8L4 12" />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path
        {...STROKE}
        d="M3.75 5.25H8.25C8.87132 5.25 9.375 5.75368 9.375 6.375V9C9.375 9.62132 8.87132 10.125 8.25 10.125H3.75C3.12868 10.125 2.625 9.62132 2.625 9V6.375C2.625 5.75368 3.12868 5.25 3.75 5.25Z"
      />
      <path
        {...STROKE}
        d="M4.125 5.25V3.9375C4.125 3.44022 4.32254 2.96331 4.67417 2.61167C5.02581 2.26004 5.50272 2.0625 6 2.0625C6.49728 2.0625 6.97419 2.26004 7.32583 2.61167C7.67746 2.96331 7.875 3.44022 7.875 3.9375V5.25"
      />
    </svg>
  );
}
