import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface FieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'aria-invalid' | 'aria-describedby'
> {
  /** A real `<label>`, always rendered and always associated. Never a placeholder. */
  label: ReactNode;
  /** Persistent help text. Associated by `aria-describedby`, so it is read with the field. */
  hint?: ReactNode;
  /**
   * The validation message. Its presence is what sets `aria-invalid`, so a field cannot be
   * styled as invalid without saying why.
   */
  error?: ReactNode;
}

/**
 * The text field.
 *
 * Three rules are enforced here rather than left to each screen:
 *
 * 1. The label is a required prop and is rendered as a `<label>`. A placeholder is not a
 *    label — it disappears on the first keystroke and is invisible to autofill.
 * 2. `aria-invalid` is derived from `error`, never passed in. A field that looks wrong and
 *    announces nothing is worse than one that looks fine.
 * 3. Hint and error are both wired into `aria-describedby`, in that order, so the reason
 *    and the fix are read together.
 *
 * The error is not a live region. It is associated with the control instead, because a
 * `role="alert"` on every keystroke of client-side validation is how a screen reader
 * becomes unusable; the announcement belongs to the submit path, which is `InlineAlert`.
 */
export function Field({ label, hint, error, className, required, ...rest }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className={['tm-field', className].filter(Boolean).join(' ')}>
      <label className="tm-field__label" htmlFor={id}>
        {label}
        {required === true ? (
          <span className="tm-field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      <input
        {...rest}
        id={id}
        required={required}
        className="tm-field__control"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
      />

      {hint ? (
        <span className="tm-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}

      {error ? (
        <span className="tm-field__error" id={errorId}>
          <span className="tm-inline-alert__glyph" aria-hidden="true">
            !
          </span>
          {error}
        </span>
      ) : null}
    </div>
  );
}
