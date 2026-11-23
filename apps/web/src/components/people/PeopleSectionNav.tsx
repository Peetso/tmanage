'use client';

import Link from 'next/link';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import '../../styles/screens/people-section-nav.css';

export type PeopleSection =
  'directory' | 'teams' | 'org-chart' | 'availability' | 'time-off' | 'allocations';

const SECTIONS: readonly { id: PeopleSection; key: MessageKey; path: string }[] = [
  { id: 'directory', key: 'PeopleNav.directory', path: '' },
  { id: 'teams', key: 'PeopleNav.teams', path: '/teams' },
  { id: 'org-chart', key: 'PeopleNav.orgChart', path: '/org-chart' },
  { id: 'availability', key: 'PeopleNav.availability', path: '/availability' },
  { id: 'time-off', key: 'PeopleNav.timeOff', path: '/time-off' },
  { id: 'allocations', key: 'PeopleNav.allocations', path: '/allocations' },
];

/**
 * The People area's own menu (Figma `WV2-05` context rail: PEOPLE · Directory, Teams, Org chart,
 * Availability, Time off, Allocations). It is the menu entry the owner found missing for Teams:
 * every People page it is drawn on reaches Teams in one press, and the page that is open is
 * marked with `aria-current="page"`. Rendered inside the shell's context rail, whose `<nav>`
 * already carries the landmark, so this is a labelled list, not a second navigation landmark.
 */
export function PeopleSectionNav({
  organizationSlug,
  current,
}: {
  organizationSlug: string;
  current: PeopleSection;
}) {
  const t = useT();
  return (
    <div className="tm-people-nav">
      <h2 className="tm-people-nav__heading" id="tm-people-nav-heading">
        {t('PeopleNav.label')}
      </h2>
      <ul className="tm-people-nav__list" aria-labelledby="tm-people-nav-heading">
        {SECTIONS.map((section) => (
          <li key={section.id}>
            <Link
              href={`/${organizationSlug}/people${section.path}`}
              className="tm-people-nav__link"
              {...(section.id === current ? { 'aria-current': 'page' as const } : {})}
            >
              {t(section.key)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
