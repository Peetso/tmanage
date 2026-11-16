import '../../styles/screens/six-digit-code.css';

/**
 * The six-box code field: ONE `<input inputmode="numeric" autocomplete="one-time-code">` with six
 * cells painted under it and hidden from assistive technology. One field gets platform autofill
 * (including a code read from the mail app), paste, and a single screen-reader announcement.
 * Codes are digits in every locale, so the field stays left-to-right in an Arabic page.
 *
 * Used by the sign-in challenge (ID-02) and by turning on the e-mail method (MFAOPTIONS). The
 * caller owns the label (`htmlFor={id}`) and the hint (`describedBy`).
 */
export function SixDigitCode({
  id,
  value,
  onChange,
  disabled,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const digits = value.replace(/\D/gu, '').slice(0, 6);
  const cells = Array.from({ length: 6 }, (_, index) => digits.charAt(index));
  const active = Math.min(digits.length, 5);
  return (
    <div className="tm-id-code__frame">
      <input
        id={id}
        className="tm-id-code__input"
        name="code"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        dir="ltr"
        aria-describedby={describedBy}
        disabled={disabled}
      />
      <div className="tm-id-code__cells" aria-hidden="true" dir="ltr">
        {cells.map((digit, index) => (
          <span
            key={index}
            className={[
              'tm-id-code__cell',
              digit === '' ? 'tm-id-code__cell--empty' : null,
              index === active ? 'tm-id-code__cell--active' : null,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {digit === '' ? '·' : digit}
          </span>
        ))}
      </div>
    </div>
  );
}
