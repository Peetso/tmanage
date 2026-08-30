import { useEffect, useId, useRef, type InputHTMLAttributes, type ReactNode } from 'react';

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type' | 'aria-invalid' | 'aria-describedby' | 'children'
> {
  /** A real `<label>`, always rendered and always associated. */
  label: ReactNode;
  /** Persistent help text, read with the control via `aria-describedby`. */
  hint?: ReactNode;
  /** The validation message. Its presence is what sets `aria-invalid`, as on `Field`. */
  error?: ReactNode;
  /**
   * The mixed state, for a header checkbox standing over a partly-selected list (the work
   * list's bulk-select seam in the inventory). It is a property of the DOM element rather
   * than an attribute, so it is applied by effect; the browser then reports
   * `aria-checked="mixed"` itself.
   */
  indeterminate?: boolean;
}

/**
 * The checkbox — selection-of-many, which is exactly the meaning law 2 forbids lime to
 * carry. The checked box is therefore ink, and the mark inside it is paper: the same
 * pairing as `InkButton`, already proven AA in both themes by `tests/contrast.test.ts`.
 *
 * The control is the native `<input type="checkbox">` with `appearance: none` — never a
 * repainted `<div>` — so the keyboard, the form, autofill and the accessibility tree all
 * come from the platform rather than from a reimplementation.
 */
export function Checkbox({
  label,
  hint,
  error,
  indeterminate = false,
  className,
  ...rest
}: CheckboxProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className={['tm-choice', className].filter(Boolean).join(' ')}>
      <span className="tm-choice__row">
        <input
          {...rest}
          ref={inputRef}
          id={id}
          type="checkbox"
          className="tm-checkbox"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
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

      {error ? (
        <span className="tm-choice__error" id={errorId}>
          <span className="tm-inline-alert__glyph" aria-hidden="true">
            !
          </span>
          {error}
        </span>
      ) : null}
    </div>
  );
}
