import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'client';

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  /**
   * Mono type. Used for the version hash that `GovernedVersionTrack` must keep visible
   * next to any approve or publish action.
   */
  mono?: boolean;
  className?: string;
}

/** A short, static label. Not a state — that is `StateCapsule` — and not a control. */
export function Badge({ children, tone = 'neutral', mono = false, className }: BadgeProps) {
  const classes = [
    'tm-badge',
    tone === 'client' ? 'tm-badge--client' : null,
    mono ? 'tm-badge--mono' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return <span className={classes}>{children}</span>;
}
