import type { ReactNode } from 'react';

export type StatusTone = 'neutral' | 'live' | 'success' | 'warning' | 'danger' | 'client';

export interface StatusDotProps {
  tone?: StatusTone;
  /**
   * The word beside the dot. Required — a bare coloured dot is exactly the pattern law 3
   * of the token export forbids.
   */
  children: ReactNode;
  className?: string;
}

/**
 * A small state marker with its word attached.
 *
 * `live` is the only tone that uses lime, and it means live: the semantic law reserves
 * lime for current / next / live and explicitly forbids reusing it as a generic success.
 */
export function StatusDot({ tone = 'neutral', children, className }: StatusDotProps) {
  const classes = ['tm-status-dot', `tm-status-dot--${tone}`, className].filter(Boolean).join(' ');

  return (
    <span className={classes}>
      <span className="tm-status-dot__mark" aria-hidden="true" />
      {children}
    </span>
  );
}
