import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

/** `'YYYY-MM-DD'` or empty. The same shape the DATE migration carries end to end. */
export type CalendarDayString = string;

export interface DateFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type' | 'aria-invalid' | 'aria-describedby' | 'value' | 'defaultValue' | 'onChange'
> {
  /** A real `<label>`, always rendered and always associated. */
  label: ReactNode;
  /** Persistent help text, read with the control. */
  hint?: ReactNode;
  /** The validation message. Its presence is what sets `aria-invalid`, as on `Field`. */
  error?: ReactNode;
  /** The day as `'YYYY-MM-DD'`, or `''` for none. Never a `Date`, never an instant. */
  value?: CalendarDayString;
  defaultValue?: CalendarDayString;
  /**
   * Called with the day as `'YYYY-MM-DD'`, or `''` when cleared. The `Date` object never
   * appears in this API in either direction.
   */
  onValueChange?: (day: CalendarDayString) => void;
}

/**
 * The date field — a calendar day, never an instant.
 *
 * This is the DATE-migration convention (`projects.committed_at`,
 * `client_requests.desired_at`: `'YYYY-MM-DD'` strings end to end, `parseTargetDate`
 * refusing anything with a time in it) surfacing in the component layer. The native
 * `<input type="date">` already speaks exactly that dialect: its `value` IS the
 * `'YYYY-MM-DD'` string, its picker is the platform's own, localised and accessible, and
 * it has no timezone to get wrong. The component therefore adds no parsing, no
 * formatting and no `Date` anywhere — `onValueChange` hands the string on, and a screen
 * that wants a JS `Date` has taken a wrong turn the API refuses to pave.
 */
export function DateField({
  label,
  hint,
  error,
  className,
  required,
  onValueChange,
  ...rest
}: DateFieldProps) {
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
        type="date"
        required={required}
        className="tm-field__control tm-date-field__control"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        onChange={(event) => onValueChange?.(event.currentTarget.value)}
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

export interface TimeFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type' | 'aria-invalid' | 'aria-describedby' | 'value' | 'defaultValue' | 'onChange'
> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** The time of day as `'HH:MM'` (24-hour), or `''` for none. Wall-clock, no zone. */
  value?: string;
  defaultValue?: string;
  /** Called with `'HH:MM'`, or `''` when cleared. */
  onValueChange?: (time: string) => void;
}

/**
 * The time field — a wall-clock time of day, `'HH:MM'`, the temporal twin of `DateField`:
 * a value with no date and no zone, carried as the string the native control already
 * speaks. Pairing one of each is how a screen asks "which day, and roughly when" without
 * ever manufacturing an instant on the client.
 */
export function TimeField({
  label,
  hint,
  error,
  className,
  required,
  onValueChange,
  ...rest
}: TimeFieldProps) {
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
        type="time"
        required={required}
        className="tm-field__control tm-date-field__control"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        onChange={(event) => onValueChange?.(event.currentTarget.value)}
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
