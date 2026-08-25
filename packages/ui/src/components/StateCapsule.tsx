import type { ReactNode } from 'react';

/**
 * The states drawn in the design artifacts, plus the ones the state matrix requires and
 * the artifacts record as gaps (`stale`, `conflict`, `permission-limited`, `invalidated`).
 */
export type CapsuleState =
  'neutral' | 'current' | 'done' | 'blocked' | 'waiting' | 'client' | 'future' | 'archived';

/**
 * Each state carries a distinct shape as well as a distinct colour.
 *
 * This is law 3 of the token export — "Every state that uses colour also carries a word
 * and a shape" — and it is also what makes the capsule survive the high-contrast theme,
 * where several of the border colours collapse onto `line.700`.
 */
const GLYPH: Record<CapsuleState, string> = {
  neutral: '■',
  current: '◆',
  done: '✓',
  blocked: '✕',
  waiting: '◷',
  client: '◎',
  future: '○',
  archived: '▨',
};

export interface StateCapsuleProps {
  state?: CapsuleState;
  /**
   * The word. Required: a capsule that is only a colour and a shape says nothing to a
   * screen reader and very little to anyone else.
   */
  children: ReactNode;
  /** Override the shape when a screen has a more specific one. */
  glyph?: string;
  className?: string;
}

export function StateCapsule({ state = 'neutral', children, glyph, className }: StateCapsuleProps) {
  const classes = ['tm-state-capsule', `tm-state-capsule--${state}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes}>
      <span className="tm-state-capsule__glyph" aria-hidden="true">
        {glyph ?? GLYPH[state]}
      </span>
      {children}
    </span>
  );
}
