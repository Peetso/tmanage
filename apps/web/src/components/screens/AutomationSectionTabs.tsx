import Link from 'next/link';
import type { ReactNode } from 'react';
import '../../styles/screens/automations.css';

export type AutomationSection = 'library' | 'runs' | 'schedules';

const SECTIONS: readonly { id: AutomationSection; label: string; suffix: string }[] = [
  { id: 'library', label: 'Library', suffix: '' },
  { id: 'runs', label: 'Runs', suffix: '/runs' },
  { id: 'schedules', label: 'Schedules', suffix: '/schedules' },
];

export interface AutomationSectionTabsProps {
  organizationSlug: string;
  current: AutomationSection;
  /** The count capsule after the current tab's label (AUT-01: "Library 11"). */
  count?: number;
  /** The filter capsules at the end of the tab row. */
  end?: ReactNode;
}

/**
 * The tab row under the automations headline (AUT-01: Library · Templates · Runs · Guardrails).
 * Each tab is a real route; the current one carries `aria-current="page"`.
 */
export function AutomationSectionTabs({
  organizationSlug,
  current,
  count,
  end,
}: AutomationSectionTabsProps) {
  return (
    <div className="tm-aut-tabs">
      <nav aria-label="Automations">
        <ul className="tm-aut-tabs__list">
          {SECTIONS.map((section) => {
            const isCurrent = section.id === current;
            return (
              <li key={section.id}>
                <Link
                  href={`/${organizationSlug}/automations${section.suffix}`}
                  className="tm-aut-tabs__link"
                  {...(isCurrent ? { 'aria-current': 'page' as const } : {})}
                >
                  {section.label}
                  {isCurrent && count !== undefined ? (
                    <span className="tm-aut-tabs__count">{count}</span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {end ? <div className="tm-aut-tabs__end">{end}</div> : null}
    </div>
  );
}
