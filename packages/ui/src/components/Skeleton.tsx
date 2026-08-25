export interface SkeletonProps {
  /** Any CSS length. Defaults to the full width of the container. */
  width?: string;
  /** Any CSS length. Defaults to one line of body text. */
  height?: string;
  radius?: string;
  className?: string;
}

/**
 * A loading placeholder.
 *
 * Always `aria-hidden`. A skeleton is a picture of text that does not exist yet, and
 * reading its shape aloud tells a screen-reader user nothing; the surrounding region owns
 * the announcement (`aria-busy` on the region, or one polite status message). This is the
 * restraint A11Y-06 asks for, expressed as a component that cannot be announced.
 */
export function Skeleton({
  width = '100%',
  height = 'var(--t-body-md-line)',
  radius,
  className,
}: SkeletonProps) {
  return (
    <span
      className={['tm-skeleton', className].filter(Boolean).join(' ')}
      aria-hidden="true"
      style={{ width, height, ...(radius === undefined ? {} : { borderRadius: radius }) }}
    />
  );
}
