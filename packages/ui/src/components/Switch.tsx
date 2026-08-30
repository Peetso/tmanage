import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface SwitchProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type' | 'role' | 'aria-describedby' | 'children'
> {
  /** A real `<label>`, always rendered and always associated. */
  label: ReactNode;
  /** Persistent help text, read with the control. */
  hint?: ReactNode;
}

/**
 * The switch — an on/off setting that takes effect the moment it is flipped, which is
 * what separates it from `Checkbox`: a checkbox states an answer a form will submit, a
 * switch *is* the action. That is also why it has no `error` prop — a setting that could
 * not be applied is a failed action and belongs to `InlineAlert` on the submit path, not
 * to a validation message under the control.
 *
 * The element is a native `<input type="checkbox" role="switch">`: the platform maps the
 * checked state to `aria-checked` itself, and the keyboard (space to flip) comes free.
 * The "on" track is ink, not lime. Law 2 restricts lime to current / next / live, and a
 * setting that happens to be enabled is none of those — it is a chosen value, the same
 * meaning the checked checkbox carries, so it uses the same ink-and-paper pairing.
 */
export function Switch({ label, hint, className, ...rest }: SwitchProps) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className={['tm-choice', className].filter(Boolean).join(' ')}>
      <span className="tm-choice__row">
        <input
          {...rest}
          id={id}
          type="checkbox"
          role="switch"
          className="tm-switch"
          aria-describedby={hint ? hintId : undefined}
        />
        <label className="tm-choice__label" htmlFor={id}>
          {label}
        </label>
      </span>

      {hint ? (
        <span className="tm-choice__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
