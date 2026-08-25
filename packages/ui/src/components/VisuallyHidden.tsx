import type { ElementType, ReactNode } from 'react';

export interface VisuallyHiddenProps {
  children: ReactNode;
  /** Defaults to `span`. Use `div` when the hidden content contains block elements. */
  as?: ElementType;
}

/**
 * Content that is removed from the visual layout but stays in the accessibility tree.
 *
 * The system leans on this rather than on `aria-label` wherever the hidden text is a
 * sentence rather than a name: `aria-label` is not translated by browser translation, is
 * invisible to a sighted keyboard user, and silently replaces the visible label instead of
 * extending it.
 */
export function VisuallyHidden({ children, as: Component = 'span' }: VisuallyHiddenProps) {
  return <Component className="tm-visually-hidden">{children}</Component>;
}
