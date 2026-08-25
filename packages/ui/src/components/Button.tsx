import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { VisuallyHidden } from './VisuallyHidden.js';

/**
 * The inventory names five buttons — InkButton, LimeButton, OutlineButton, TextButton,
 * DestructiveButton. They are one component with a `tone`, because they differ only in
 * paint: the semantics, the keyboard behaviour, the loading state and the disabled rule
 * are identical, and five copies of that would be five places for them to diverge. The
 * inventory's names are kept as bound exports at the foot of this file so design and code
 * still use the same word for the same thing.
 */
export type ButtonTone = 'ink' | 'lime' | 'outline' | 'text' | 'destructive';

/** `40-DESIGN-SYSTEM` §4: controls are 36 compact, 40 default, 44 accessible, 48 feature. */
export type ControlSize = 'compact' | 'default' | 'accessible' | 'feature';

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-busy'
> {
  /**
   * Required, and deliberately not optional. An icon-only control is `OrbButton`, which
   * demands a label of its own; a `Button` with no text has no accessible name.
   */
  children: ReactNode;
  tone?: ButtonTone;
  size?: ControlSize;
  /**
   * A button that is waiting is disabled *and* announced. `loadingLabel` is what a screen
   * reader says while it waits; the visible label does not change, so the control does not
   * resize under the pointer.
   */
  loading?: boolean;
  loadingLabel?: string;
}

export function Button({
  children,
  tone = 'ink',
  size = 'default',
  loading = false,
  loadingLabel = 'Working',
  className,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  const classes = ['tm-button', `tm-button--${tone}`, `tm-button--${size}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
    >
      {children}
      {loading ? (
        <VisuallyHidden>
          <span role="status">{loadingLabel}</span>
        </VisuallyHidden>
      ) : null}
    </button>
  );
}

function withTone(tone: ButtonTone) {
  return function ToneBoundButton(props: Omit<ButtonProps, 'tone'>) {
    return <Button {...props} tone={tone} />;
  };
}

export const InkButton = withTone('ink');
export const LimeButton = withTone('lime');
export const OutlineButton = withTone('outline');
export const TextButton = withTone('text');
export const DestructiveButton = withTone('destructive');
