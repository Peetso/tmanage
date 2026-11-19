import Link from 'next/link';

export interface OverviewTab {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  /** How many items sit behind the tab (Figma Tabs/Item "Count"); omitted draws none. */
  readonly count?: string;
}

export interface OverviewTabsProps {
  readonly tabs: readonly OverviewTab[];
  readonly current: string;
  /** The navigation landmark's name. */
  readonly label: string;
}

/**
 * ONEPAGE — the in-page tab row of both one-page screens (Figma Tabs/Item 169:162): text tabs on
 * one line, the current one inked with the lime indicator. Every tab is a real route. On a phone
 * the row keeps one line and scrolls sideways, each tab 44 px high (review FIGMA-C fix 2).
 */
export function OverviewTabs({ tabs, current, label }: OverviewTabsProps) {
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
    </nav>
  );
}
