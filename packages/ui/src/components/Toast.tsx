import type { HTMLAttributes, ReactNode } from 'react';

/** Same vocabulary as `InlineAlert`, and the same glyph-plus-word rule. */
export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger';

const TONE_GLYPH: Record<ToastTone, string> = {
  neutral: 'i',
  success: '✓',
  warning: '!',
  danger: '✕',
};

export interface ToastRegionProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

/**
 * The live region toasts appear in — **the decision the next-task note asked for, made
 * here:** announcements live on the *region*, not on each toast.
 *
 * The region is `role="status"` (implicitly `aria-live="polite"`, `aria-atomic` off) and
 * must be mounted, empty, at the application root *before* the first toast is injected —
 * a live region created in the same tick as its first content is a coin toss on whether
 * anything is announced. That ordering cannot be enforced from inside a component, so it
 * is the contract: mount `ToastRegion` once in the shell, then render toasts into it.
 *
 * Polite, not assertive, because a toast is by definition peripheral — feedback about a
 * thing that already succeeded or failed *elsewhere on the screen*. Anything that must
 * interrupt belongs inline, next to what it interrupts (`InlineAlert`), not floating in a
 * corner. For the same reason the primitive owns **no timer**: auto-dismiss is an
 * application policy (and 2.2.1 requires it be extendable), so the primitive renders for
 * as long as it is rendered.
 */
export function ToastRegion({ children, className, ...rest }: ToastRegionProps) {
  return (
    <div
      {...rest}
      role="status"
      // `role="status"` is implicitly `aria-atomic="true"`, which would re-announce every
      // toast already on screen each time a new one arrives. Only the addition is news.
      aria-atomic={false}
      aria-label="Notifications"
      className={['tm-toast-region', className].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  );
}

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The sentence. Required — a toast with nothing to say should not appear. */
  children: ReactNode;
  tone?: ToastTone;
  /**
   * Dismissal, when offered, is a real labelled button. Omitting the handler omits the
   * button rather than rendering one that does nothing.
   */
  onDismiss?: () => void;
  /** The dismiss button's accessible name. */
  dismissLabel?: string;
}

/**
 * One toast. Paint only: the tone colours the border and the glyph, and the word stays
 * ink — the same AA reasoning as `InlineAlert`, whose vocabulary this reuses.
 */
export function Toast({
  children,
  tone = 'neutral',
  onDismiss,
  dismissLabel = 'Dismiss notification',
  className,
  ...rest
}: ToastProps) {
  return (
    <div
      {...rest}
      className={['tm-toast', `tm-toast--${tone}`, className].filter(Boolean).join(' ')}
    >
      <span className="tm-inline-alert__glyph" aria-hidden="true">
        {TONE_GLYPH[tone]}
      </span>
      <span className="tm-toast__body">{children}</span>
      {onDismiss ? (
        <button
          type="button"
          className="tm-toast__dismiss"
          aria-label={dismissLabel}
          onClick={onDismiss}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}
