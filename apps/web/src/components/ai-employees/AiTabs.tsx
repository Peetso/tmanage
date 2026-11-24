'use client';

import { useRef, type KeyboardEvent } from 'react';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { withNumerals } from '../../lib/i18n/display-format';

export interface AiTab<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Drawn after the label in the quiet count style; none = no count. */
  readonly count?: number;
}

/**
 * The People and profile tabs (S1 Everyone / People / AI employees; S6 Overview / Connections),
 * built as the WAI-ARIA APG tabs pattern with automatic activation: one tab stop (the chosen tab),
 * the arrow keys move and choose in reading order (mirrored in Arabic), Home and End jump to the
 * ends, and the chosen tab names the panel it controls.
 */
export function AiTabs<T extends string>({
  label,
  tabs,
  current,
  onChange,
  idPrefix,
}: {
  readonly label: string;
  readonly tabs: readonly AiTab<T>[];
  readonly current: T;
  readonly onChange: (id: T) => void;
  /** The tab ids are `${idPrefix}-tab-${id}`; the panel is `${idPrefix}-panel`. */
  readonly idPrefix: string;
}) {
  const locale = useActiveLocale();
  const list = useRef<HTMLDivElement>(null);

  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.findIndex((tab) => tab.id === current);
    const rtl = list.current ? getComputedStyle(list.current).direction === 'rtl' : false;
    const step = (forward: boolean) => (forward !== rtl ? 1 : -1);
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = index + step(true);
    else if (event.key === 'ArrowLeft') next = index + step(false);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    if (!target) return;
    onChange(target.id);
    list.current?.querySelector<HTMLButtonElement>(`[data-tab="${target.id}"]`)?.focus();
  };

  return (
    <div ref={list} className="tm-aie-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => {
        const chosen = tab.id === current;
        return (
          <button
            key={tab.id}
            id={`${idPrefix}-tab-${tab.id}`}
            data-tab={tab.id}
            type="button"
            role="tab"
            className="tm-aie-tab"
            aria-selected={chosen}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={chosen ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={move}
          >
            <span className="tm-aie-tab__label">{tab.label}</span>
            {tab.count === undefined ? null : (
              <span className="tm-aie-tab__count">
                {tab.count.toLocaleString(withNumerals(locale))}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
