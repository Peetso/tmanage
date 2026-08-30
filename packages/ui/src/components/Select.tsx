import { useId, type ReactNode, type SelectHTMLAttributes } from 'react';

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'id' | 'aria-invalid' | 'aria-describedby'
> {
  /** A real `<label>`, always rendered and always associated. */
  label: ReactNode;
  /** Persistent help text, read with the control. */
  hint?: ReactNode;
  /** The validation message. Its presence is what sets `aria-invalid`, as on `Field`. */
  error?: ReactNode;
  /** The `<option>` / `<optgroup>` elements. */
  children: ReactNode;
}

/**
 * The select — a native `<select>` under `Field`'s exact contract. The inventory places
 * it in the work-list header, where a filter must be operable from the keyboard, from a
 * touch screen and from a screen reader on the day it ships; the native element does all
 * three, and the platform picker (which on a phone is the platform's own wheel) is a
 * feature, not a styling defect. The chevron is drawn by the component because
 * `appearance: none` removes the native one; it is `aria-hidden`, since "this is a
 * dropdown" is already what the role says.
 */
export function Select({
  label,
  hint,
  error,
  className,
  required,
  children,
  ...rest
}: SelectProps) {
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

      <span className="tm-select">
        <select
          {...rest}
          id={id}
          required={required}
          className="tm-field__control tm-select__control"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
        >
          {children}
        </select>
        <span className="tm-select__glyph" aria-hidden="true">
          ▾
        </span>
      </span>

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
