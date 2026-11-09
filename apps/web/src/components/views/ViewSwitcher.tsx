'use client';

import Link from 'next/link';
import { useRef } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { HelpTip } from '../help/HelpTip';
import './view-switcher.css';

export interface ViewOption<V extends string> {
  readonly id: V;
  readonly label: string;
  /** A view that lives on its own page (Work's Timeline, Calendar): choosing it navigates there. */
  readonly href?: string;
  /** FIX2 hover help: one plain sentence on what this view shows. */
  readonly tip?: string;
}

export interface ViewSwitcherProps<V extends string> {
  /** What the group switches, read by a screen reader ("Projects view"). */
  readonly label: string;
  readonly options: readonly ViewOption<V>[];
  readonly value: V;
  readonly onChange: (view: V) => void;
  readonly className?: string;
}

/**
 * **R38 G5-views** — the one view switcher every list page uses (Projects, Clients, People, Work):
 * a segmented control of List / Board / Grid / Timeline / Calendar, as in Figma "R38 G5-views".
 *
 * It is a radio group: one stop in the Tab order (the chosen view), the arrow keys move and choose,
 * Home and End jump to the ends. In Arabic the arrows follow the reading direction, so the
 * right arrow moves to the option drawn on the right.
 */
export function ViewSwitcher<V extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: ViewSwitcherProps<V>) {
  const groupRef = useRef<HTMLDivElement>(null);

  function focusAndChoose(index: number) {
    const option = options[index];
    if (!option) return;
    const element = groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[index];
    element?.focus();
    if (option.href !== undefined && option.id !== value) element?.click();
    else onChange(option.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = Math.max(
      0,
      options.findIndex((option) => option.id === value),
    );
    const rtl = groupRef.current?.closest('[dir]')?.getAttribute('dir') === 'rtl';
    const last = options.length - 1;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
        next = rtl ? current - 1 : current + 1;
        break;
      case 'ArrowLeft':
        next = rtl ? current + 1 : current - 1;
        break;
      case 'ArrowDown':
        next = current + 1;
        break;
      case 'ArrowUp':
        next = current - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    focusAndChoose((next + options.length) % options.length);
  }

  return (
    // The group is not a tab stop of its own: the chosen option is (a roving tab index).
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      className={className ? `tm-view-switcher ${className}` : 'tm-view-switcher'}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const checked = option.id === value;
        const withTip = (control: ReactElement) =>
          option.tip ? (
            <HelpTip key={option.id} tip={option.tip}>
              {control}
            </HelpTip>
          ) : (
            control
          );
        if (option.href !== undefined && !checked) {
          return withTip(
            <Link
              key={option.id}
              href={option.href}
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className="tm-view-switcher__option"
              data-view={option.id}
            >
              {option.label}
            </Link>,
          );
        }
        return withTip(
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className="tm-view-switcher__option"
            data-view={option.id}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>,
        );
      })}
    </div>
  );
}
