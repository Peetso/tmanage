'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { StatusDot } from '@tmanage/ui';
import type { StatusTone } from '@tmanage/ui';

/**
 * D5 (Figma F5) — the dialog frame all four Privacy dialogs share: a scrim, a 560px sheet, the
 * title and lede, a body, and the actions row at the end. Escape closes it; focus starts on the
 * first control so a keyboard user lands inside.
 */
export function PrivacyDialog({
  title,
  lede,
  onClose,
  children,
  actions,
}: {
  title: string;
  lede: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  actions: ReactNode;
}) {
  const titleId = useId();
  const ledeId = useId();
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    panelRef.current
      ?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), button')
      ?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="prv-dialog-scrim">
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={ledeId}
        className="prv-dialog"
      >
        <div className="prv-dialog__head">
          <h2 id={titleId} className="prv-dialog__title">
            {title}
          </h2>
          <p id={ledeId} className="prv-dialog__lede">
            {lede}
          </p>
        </div>
        {children}
        <div className="prv-dialog__actions">{actions}</div>
      </section>
    </div>
  );
}

/** One bullet of a "What to know" list: a toned dot and its sentence. */
export interface PrivacyPoint {
  readonly tone: StatusTone;
  readonly text: string;
}

/** The dialogs' bullet list, optionally under the mono "WHAT TO KNOW" label. */
export function PrivacyPoints({
  label,
  points,
}: {
  label?: string;
  points: readonly PrivacyPoint[];
}) {
  return (
    <div className="prv-points">
      {label ? (
        <p className="prv-caption" aria-hidden="true">
          {label}
        </p>
      ) : null}
      <ul className="prv-points__list" aria-label={label}>
        {points.map((point) => (
          <li key={point.text} className="prv-points__item">
            <StatusDot tone={point.tone} className="prv-points__dot">
              {point.text}
            </StatusDot>
          </li>
        ))}
      </ul>
    </div>
  );
}
