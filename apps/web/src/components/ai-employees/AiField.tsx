'use client';

import { useId, useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { InfoButton } from '@tmanage/ui';
import { useTOr } from '../../lib/i18n/use-t-or';
import { ChevronDownIcon } from '../work/work-icons';

/**
 * The wizard's and Settings' fields, all the approved New team field (Fable fix 8): a label (with
 * an info icon where the design has one), then a 40-high box with a sunken fill and a quiet
 * border; only the focused field has the bright border.
 */
export function FieldLabel({
  htmlFor,
  id,
  label,
  info,
}: {
  readonly htmlFor?: string;
  readonly id?: string;
  readonly label: string;
  /** The info icon's text (EN + AR in the Figma report §7); none = no icon. */
  readonly info?: string;
}) {
  const tOr = useTOr();
  return (
    <span className="tm-aie-label">
      {htmlFor ? (
        <label htmlFor={htmlFor} id={id} className="tm-team-dialog__label">
          {label}
        </label>
      ) : (
        <span id={id} className="tm-team-dialog__label">
          {label}
        </span>
      )}
      {info ? (
        <InfoButton
          title={label}
          label={tOr('AiEmployees.aboutField', 'About {field}').replace('{field}', label)}
        >
          {info}
        </InfoButton>
      ) : null}
    </span>
  );
}

/** A native select drawn as the 40-high field with its chevron. */
export function SelectBox({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { readonly children: ReactNode }) {
  return (
    <span className={['tm-aie-select', className].filter(Boolean).join(' ')}>
      <select {...rest}>{children}</select>
      <span className="tm-aie-select__chevron" aria-hidden="true">
        <ChevronDownIcon />
      </span>
    </span>
  );
}

/**
 * A read-only value with Copy (the connector address, a new key): the value is selectable, Copy
 * writes it to the clipboard and says "Copied" to a screen reader. A key is never written into
 * the page's address or storage.
 */
export function CopyField({ label, value }: { readonly label: string; readonly value: string }) {
  const tOr = useTOr();
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div className="tm-team-dialog__field">
      <label htmlFor={id} className="tm-team-dialog__label">
        {label}
      </label>
      <span className="tm-aie-copy">
        <input
          id={id}
          className="tm-aie-copy__value"
          readOnly
          value={value}
          dir="ltr"
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="tm-aie-copy__button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(value)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? tOr('AiEmployees.copied', 'Copied') : tOr('AiEmployees.copy', 'Copy')}
        </button>
      </span>
      <span className="tm-visually-hidden" role="status">
        {copied ? tOr('AiEmployees.copiedLong', 'Copied to the clipboard.') : ''}
      </span>
    </div>
  );
}
