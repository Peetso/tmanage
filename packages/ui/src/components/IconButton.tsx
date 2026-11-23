import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Figma `Header/Button · Kind=Icon`: `small` is the 28 × 28 icon button with a 16px glyph
 * (`929:910`, bound to `density/control-sm`), used for every icon-only action inside rows,
 * panels and tables; `header` is the 32 × 32 one that stands in a page header row beside
 * 32px text buttons (`918:1826`). Both have the header radius (14), not a circle: an `OrbButton`
 * is the navigation and feature orb, this is the quiet toolbar control (ADR-0016).
 *
 * Both sizes clear WCAG 2.2 SC 2.5.8 (24 × 24) without the spacing exception.
 */
export type IconButtonSize = 'small' | 'header';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label'
> {
  /** The accessible name; required, because the control has no visible text. */
  label: string;
  /** The glyph, hidden from assistive technology (the name comes from `label`). */
  icon: ReactNode;
  size?: IconButtonSize;
}

export function IconButton({
  label,
  icon,
  size = 'small',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const classes = ['tm-icon-button', `tm-icon-button--${size}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button {...rest} type={type} className={classes} aria-label={label}>
      <span className="tm-icon-button__glyph" aria-hidden="true">
        {icon}
      </span>
    </button>
  );
}
