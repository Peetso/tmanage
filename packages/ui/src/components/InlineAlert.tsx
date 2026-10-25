import type { ReactNode } from 'react';

export type AlertTone = 'neutral' | 'success' | 'warning' | 'danger' | 'client';

const GLYPH: Record<AlertTone, string> = {
  neutral: 'i',
  success: '✓',
  warning: '!',
  danger: '✕',
  client: '◎',
};

export interface InlineAlertProps {
  tone?: AlertTone;
  /** Short heading. Optional, but a message with two sentences usually wants one. */
  title?: ReactNode;
  children: ReactNode;
  /**
   * Announce the alert when it appears.
   *
   * Off by default and deliberately so: A11Y-06 in `27-TEST-CATALOG` asks for live-region
   * *restraint*, and an alert rendered as part of the initial page is not news. Turn it on
   * for something that arrives in response to an action.
   */
  live?: boolean;
  className?: string;
}

export function InlineAlert({
  tone = 'neutral',
  title,
  children,
  live = false,
  className,
}: InlineAlertProps) {
  const classes = ['tm-inline-alert', `tm-inline-alert--${tone}`, className]
    .filter(Boolean)
    .join(' ');

  // `alert` is assertive and interrupts. Only failure earns that; everything else is
  // polite `status`.
  const role = live ? (tone === 'danger' ? 'alert' : 'status') : undefined;

  return (
    <div className={classes} role={role}>
      {/* The tone mark is drawn by CSS from `data-glyph`, so it is not a bare "i" or "✕" in the
          page text that a reader or copy-paste picks up. */}
      <span className="tm-inline-alert__glyph" aria-hidden="true" data-glyph={GLYPH[tone]} />
      <div>
        {title ? <div className="tm-inline-alert__title">{title}</div> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}
