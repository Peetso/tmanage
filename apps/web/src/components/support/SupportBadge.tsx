import type { ReactNode } from 'react';
import type { BadgeTone } from '../../lib/support-sla-text';

const GLYPH: Readonly<Record<BadgeTone, string>> = {
  late: '×',
  due: '◷',
  answered: '✓',
  neutral: '',
};

/** 57-10 · the outlined status pill of the support screens (Figma 614:35008 / 614:35191). */
export function SupportBadge({
  tone,
  children,
}: {
  readonly tone: BadgeTone;
  readonly children: ReactNode;
}) {
  return (
    <span className={`tm-sla-badge tm-sla-badge--${tone}`}>
      {GLYPH[tone] === '' ? null : (
        <span className="tm-sla-badge__glyph" aria-hidden="true">
          {GLYPH[tone]}
        </span>
      )}
      {children}
    </span>
  );
}
