import type { ReactNode } from 'react';
import { useUiLabels } from './ui-labels.js';

export interface SkipLinkProps {
  /** The id of the main region, without the `#`. */
  targetId: string;
  children?: ReactNode;
  className?: string;
}

/**
 * The first focusable thing on every page.
 *
 * A11Y-01 in `27-TEST-CATALOG` requires landmarks, headings and a skip link. It is a
 * component rather than a snippet each screen copies, because the one that gets copied is
 * the one that gets forgotten on the screen with the longest rail.
 */
export function SkipLink({ targetId, children, className }: SkipLinkProps) {
  const { skipToMain } = useUiLabels();
  return (
    <a className={['tm-skip-link', className].filter(Boolean).join(' ')} href={`#${targetId}`}>
      {children ?? skipToMain}
    </a>
  );
}
