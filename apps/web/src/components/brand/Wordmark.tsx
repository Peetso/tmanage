export interface WordmarkProps {
  /** `wordmark` for the full logotype, `icon` for the orbital mark alone. */
  variant?: 'wordmark' | 'icon';
  /** The accessible name. Defaults to the product name; a portal may override it. */
  label?: string;
  className?: string;
}

/**
 * The TManage mark.
 *
 * Rendered as a CSS mask over `currentColor` rather than as an `<img>` with a baked-in fill.
 * The design export ships three colour variants of the same wordmark — ink, lime, paper —
 * and choosing between them in markup means every screen has to know which theme it is in.
 * A mask inherits the surrounding text colour instead, so the mark is correct in light,
 * dark and high contrast without a single conditional, and `[data-contrast="high"]` gets
 * the promoted ink for free.
 *
 * `role="img"` with an `aria-label` because the element has no text content. The label is a
 * prop rather than a constant: `ID-03` shows a client organization's invitation, and a
 * client portal is branded as the client's, not as TManage's.
 */
export function Wordmark({ variant = 'wordmark', label = 'TManage', className }: WordmarkProps) {
  return (
    <span
      role="img"
      aria-label={label}
      className={['tm-mark', `tm-mark--${variant}`, className].filter(Boolean).join(' ')}
    />
  );
}
