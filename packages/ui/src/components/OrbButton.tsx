import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** `40-DESIGN-SYSTEM` §4: 32 compact, 40 default, 44 accessible, 48 navigation, 56 feature, 64 hero. */
export type OrbSize = 'compact' | 'default' | 'comfortable' | 'navigation' | 'feature' | 'hero';

export type OrbTone = 'plain' | 'ink' | 'lime' | 'outline';

export interface OrbButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label'
> {
  /**
   * The accessible name, and a required prop rather than an optional one.
   *
   * An orb is an icon in a circle. Every icon-only control that shipped without this is
   * the same defect, and a type error is the cheapest possible place to catch it.
   */
  label: string;
  /** The glyph. Marked `aria-hidden` for you — the name comes from `label`. */
  icon: ReactNode;
  size?: OrbSize;
  tone?: OrbTone;
}

export function OrbButton({
  label,
  icon,
  size = 'default',
  tone = 'plain',
  className,
  type = 'button',
  ...rest
}: OrbButtonProps) {
  const classes = [
    'tm-orb-button',
    `tm-orb-button--${size}`,
    tone === 'plain' ? null : `tm-orb-button--${tone}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button {...rest} type={type} className={classes} aria-label={label}>
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}
