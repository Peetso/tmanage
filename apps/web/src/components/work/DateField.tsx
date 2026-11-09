'use client';

import { useState } from 'react';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { DueDatePicker, formatChipDay } from './DueDatePicker';

export interface DateFieldProps {
  /** The button's id, so a `<label htmlFor>` names it. */
  readonly id?: string;
  /** The picker's heading and, without a label, the button's name. */
  readonly heading: string;
  /** `YYYY-MM-DD`, or `''` for none. */
  readonly value: string;
  readonly onChange: (day: string) => void;
  /** "Pick a date" text while empty. */
  readonly placeholder: string;
  readonly disabled?: boolean;
  /** A required date ignores the picker's "Clear date". */
  readonly required?: boolean;
  readonly min?: string;
  readonly className?: string;
  readonly ariaLabel?: string;
}

/**
 * The app's date picker as a form field (live check a6f66e47, M3): a button showing the day the
 * way the rest of TManage writes it ("Mon 10 Nov"), opening the same picker Convert to work uses,
 * instead of the browser's US-style `mm/dd/yyyy` box.
 */
export function DateField({
  id,
  heading,
  value,
  onChange,
  placeholder,
  disabled = false,
  required = false,
  min,
  className,
  ariaLabel,
}: DateFieldProps) {
  const locale = useActiveLocale();
  const [open, setOpen] = useState(false);
  return (
    <div className="tm-wk-popover-anchor">
      <button
        type="button"
        id={id}
        className={className}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {value === '' ? placeholder : formatChipDay(value, locale)}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open ? (
        <DueDatePicker
          heading={heading}
          value={value}
          {...(min === undefined ? {} : { min })}
          onSet={(day) => {
            if (day !== null || !required) onChange(day ?? '');
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
