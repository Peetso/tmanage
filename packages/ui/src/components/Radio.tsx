import {
  createContext,
  useContext,
  useId,
  type FieldsetHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

interface RadioGroupContextValue {
  readonly name: string;
  readonly disabled: boolean;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps extends Omit<
  FieldsetHTMLAttributes<HTMLFieldSetElement>,
  'aria-invalid' | 'aria-describedby' | 'aria-labelledby'
> {
  /** A real `<legend>`, always rendered — the group's accessible name. */
  legend: ReactNode;
  /**
   * The shared `name` that makes the radios one group. Generated when omitted, so two
   * groups on one screen can never silently merge by both leaving it off.
   */
  name?: string;
  /** Persistent help text for the whole group. */
  hint?: ReactNode;
  /** The validation message. A choice is required or refused as a group, never per option. */
  error?: ReactNode;
  children: ReactNode;
}

/**
 * The radio group. Radios are meaningless alone — checking one is only defined against
 * its siblings — so the group is the component and `Radio` refuses to render outside one.
 *
 * The element is a `<fieldset>` with an explicit `role="radiogroup"`: the fieldset
 * contributes the legend and the disabled cascade, and the role is what permits
 * `aria-invalid` on the group (ARIA allows it on `radiogroup`, not on `group`), which is
 * where a "pick one" error belongs — on the choice, not on an arbitrary option.
 */
export function RadioGroup({
  legend,
  name,
  hint,
  error,
  disabled = false,
  className,
  children,
  ...rest
}: RadioGroupProps) {
  const id = useId();
  const legendId = `${id}-legend`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const generatedName = `${id}-group`;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <fieldset
      {...rest}
      role="radiogroup"
      className={['tm-radio-group', className].filter(Boolean).join(' ')}
      disabled={disabled}
      aria-labelledby={legendId}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy === '' ? undefined : describedBy}
    >
      <legend className="tm-radio-group__legend" id={legendId}>
        {legend}
      </legend>

      <RadioGroupContext.Provider value={{ name: name ?? generatedName, disabled }}>
        {children}
      </RadioGroupContext.Provider>

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
    </fieldset>
  );
}

export interface RadioProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type' | 'name' | 'children'
> {
  /** A real `<label>`, always rendered and always associated. */
  label: ReactNode;
  /** Optional per-option detail, read with the option. */
  hint?: ReactNode;
}

/**
 * One option. The checked dot is ink on paper — selection, so never lime, by law 2.
 */
export function Radio({ label, hint, className, ...rest }: RadioProps) {
  const group = useContext(RadioGroupContext);
  if (group === null) {
    throw new Error('Radio must be rendered inside a RadioGroup.');
  }

  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className={['tm-choice', className].filter(Boolean).join(' ')}>
      <span className="tm-choice__row">
        <input
          {...rest}
          id={id}
          type="radio"
          name={group.name}
          className="tm-radio"
          aria-describedby={hint ? hintId : undefined}
        />
        <label className="tm-choice__label" htmlFor={id}>
          {label}
        </label>
      </span>

      {hint ? (
        <span className="tm-choice__hint tm-choice__hint--option" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
