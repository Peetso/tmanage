import Link from 'next/link';
import type { ReactNode } from 'react';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/automations.css';

export type AutomationSection = 'library' | 'runs' | 'schedules';

/** VR2 fix 2: the tab names come from the catalogs, so an Arabic member reads Arabic tabs. */
const SECTIONS: readonly { id: AutomationSection; labelKey: MessageKey; suffix: string }[] = [
  { id: 'library', labelKey: 'AutomationSectionTabs.library', suffix: '' },
  { id: 'runs', labelKey: 'AutomationSectionTabs.runs', suffix: '/runs' },
  { id: 'schedules', labelKey: 'AutomationSectionTabs.schedules', suffix: '/schedules' },
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
  const t = useT();
  return (
    <div className="tm-aut-tabs">
      <nav aria-label={t('AutomationSectionTabs.navLabel')}>
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
                  {t(section.labelKey)}
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
