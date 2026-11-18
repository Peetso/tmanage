import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { Announce } from './LiveAnnouncer.js';
import { useUiLabels } from './ui-labels.js';

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
   * A button that is waiting is inert *and* announced. `loadingLabel` is what a screen
   * reader says while it waits; the visible label does not change, so the control does not
   * resize under the pointer.
   *
   * A loading button is made inert with `aria-disabled` and a click guard, **not** the
   * `disabled` attribute. A `disabled` element is pulled out of the tab sequence, so a
   * keyboard user who presses a button that then starts working has focus silently thrown to
   * `<body>` — WCAG 2.2 **2.4.3 Focus Order**. `aria-disabled` keeps the control focusable
   * and keeps the person where they were; `aria-busy` toggling to `true` on the element they
   * are focused on is what announces the wait. The explicit `disabled` prop is still honoured
   * for a control that is genuinely unavailable rather than merely busy.
   */
  loading?: boolean;
  loadingLabel?: string;
}

export function Button({
  children,
  tone = 'ink',
  size = 'default',
  loading = false,
  loadingLabel: passedLoadingLabel,
  className,
  type = 'button',
  disabled,
  onClick,
  ...rest
}: ButtonProps) {
  const labels = useUiLabels();
  const loadingLabel = passedLoadingLabel ?? labels.working;
  const classes = ['tm-button', `tm-button--${tone}`, `tm-button--${size}`, className]
    .filter(Boolean)
    .join(' ');

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    // A busy button is focusable but does nothing: swallow the activation rather than let a
    // second press fire the handler or submit the form again.
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  }

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled === true}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={handleClick}
    >
      {children}
      {/*
       * WCAG 2.2 4.1.3. The wait is announced through the ambient `LiveAnnouncer`, not by
       * mounting a `role="status"` node together with its text — a region that arrives already
       * populated is routinely not announced at all (the I-02 defect). `Announce` writes
       * `loadingLabel` into the shell's always-mounted region from an effect, so it lands as a
       * mutation of an existing region. Outside a `LiveAnnouncer` `useAnnounce()` is a safe no-op,
       * so a bare `<Button loading>` still renders and stays inert; there `aria-busy` toggling on
       * the focused control carries the wait on its own.
       */}
      {loading ? <Announce message={loadingLabel} /> : null}
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
