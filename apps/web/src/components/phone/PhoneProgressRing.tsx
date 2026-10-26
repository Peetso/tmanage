export interface PhoneProgressRingProps {
  /** 0–100; rounded and clamped before it is drawn. */
  percent: number;
  /** 64 on the dark project card, 56 on the white one (Figma 407:6531 / 407:6552). */
  size: 56 | 64;
  /** What the number means, for assistive technology ("62% done"). */
  label: string;
}

/**
 * The phone redesign's progress ring: a quiet track, the done arc in the card's accent and the
 * percentage in the middle. Colours come from the surrounding card through `currentColor` and
 * the `--tm-ring-*` custom properties set in `styles/phone/work.css`.
 */
export function PhoneProgressRing({ percent, size, label }: PhoneProgressRingProps) {
  const value = clampPercent(percent);
  const stroke = size === 64 ? 6 : 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <span className="tm-phone-ring" data-size={size} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          className="tm-phone-ring__track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="tm-phone-ring__done"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(circumference * value) / 100} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="tm-phone-ring__value" aria-hidden="true">
        {value}%
      </span>
    </span>
  );
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
