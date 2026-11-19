'use client';

import Link from 'next/link';
import { NavIcon } from '../icons/phone';
import { useMenuPopup } from './use-menu-popup';
// The More menu draws with the one-page menu styles (`tm-act-menu*`), as the Activity chips do.
import '../../styles/screens/activity.css';

export interface OverviewTab {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  /** How many items sit behind the tab (Figma Tabs/Item "Count"); omitted draws none. */
  readonly count?: string;
}

/** D5: the sections behind one "More" menu after the row's own tabs. */
export interface OverviewMoreTabs {
  /** "More". */
  readonly label: string;
  /** "More: {name}", when the current page is one of these. */
  readonly currentLabel: (name: string) => string;
  readonly tabs: readonly OverviewTab[];
}

export interface OverviewTabsProps {
  readonly tabs: readonly OverviewTab[];
  readonly current: string;
  /** The navigation landmark's name. */
  readonly label: string;
  readonly more?: OverviewMoreTabs;
}

/**
 * ONEPAGE — the in-page tab row of both one-page screens (Figma Tabs/Item 169:162): text tabs on
 * one line, the current one inked with the lime indicator. Every tab is a real route. On a phone
 * the row keeps one line and scrolls sideways, each tab 44 px high (review FIGMA-C fix 2). A
 * screen with more sections than the frame's tabs puts the rest behind "More" (D5), which carries
 * the indicator and reads "More: Risks" while one of them is the current page.
 */
export function OverviewTabs({ tabs, current, label, more }: OverviewTabsProps) {
  return (
    <nav className="tm-ov-tabs" aria-label={label}>
      <ul className="tm-ov-tabs__list">
        {tabs.map((tab) => (
          <li key={tab.id}>
            <Link
              className="tm-ov-tabs__item"
              href={tab.href}
              {...(tab.id === current ? { 'aria-current': 'page' as const } : {})}
            >
              <span>{tab.label}</span>
              {tab.count !== undefined ? (
                <>
                  {/* Keeps the accessible name "Work 18", not "Work18"; flex drops it visually. */}{' '}
                  <span className="tm-ov-tabs__count">{tab.count}</span>
                </>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
      {more && more.tabs.length > 0 ? <MoreTabs more={more} current={current} /> : null}
    </nav>
  );
}

function MoreTabs({
  more,
  current,
}: {
  readonly more: OverviewMoreTabs;
  readonly current: string;
}) {
  const { menuId, root, trigger, open, toggle, close, onMenuKey } = useMenuPopup('menuitem');
  const chosen = more.tabs.find((tab) => tab.id === current);
  return (
    <div ref={root} className="tm-ov-tabs__more">
      <button
        ref={trigger}
        type="button"
        className="tm-ov-tabs__item"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-current={chosen !== undefined}
        onClick={toggle}
      >
        <span>{chosen === undefined ? more.label : more.currentLabel(chosen.label)}</span>
        <NavIcon name="chevronDown" size={16} />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-label={more.label}
          className="tm-act-menu__list"
          onKeyDown={onMenuKey}
        >
          {more.tabs.map((tab) => (
            <Link
              key={tab.id}
              role="menuitem"
              className="tm-act-menu__item"
              href={tab.href}
              {...(tab.id === current ? { 'aria-current': 'page' as const } : {})}
              onClick={close}
            >
              {tab.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
