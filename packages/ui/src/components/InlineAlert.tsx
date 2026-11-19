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
  /**
   * The tone mark as an icon (the app's Icon/info line icon, decorative), in place of the drawn
   * glyph; the surface passes it because the icon set lives in the app.
   */
  icon?: ReactNode;
  className?: string;
}

export function InlineAlert({
  tone = 'neutral',
  title,
  children,
  live = false,
  icon,
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
      {icon === undefined ? (
        <span className="tm-inline-alert__glyph" aria-hidden="true" data-glyph={GLYPH[tone]} />
      ) : (
        <span className="tm-inline-alert__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div>
        {title ? <div className="tm-inline-alert__title">{title}</div> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}
