'use client';

import Link from 'next/link';
import { useTOr } from '../../../lib/i18n/use-t-or';
import '../../../styles/screens/people-capacity.css';

export type PeopleCapacitySection = 'capacity' | 'time-off' | 'allocations' | 'heatmap';

const SECTIONS: readonly {
  id: PeopleCapacitySection;
  key: string;
  english: string;
  path: string;
}[] = [
  { id: 'capacity', key: 'PeopleCapacityTabs.capacity', english: 'Capacity', path: '/capacity' },
  { id: 'time-off', key: 'PeopleCapacityTabs.timeOff', english: 'Time off', path: '/time-off' },
  {
    id: 'allocations',
    key: 'PeopleCapacityTabs.allocations',
    english: 'Allocations',
    path: '/allocations',
  },
  {
    id: 'heatmap',
    key: 'PeopleCapacityTabs.heatmap',
    english: 'Heatmap',
    path: '/capacity/heatmap',
  },
];

/**
 * The tab row under the People capacity headline (R31 L05 Figma section 513:30129): Capacity ·
 * Time off · Allocations · Heatmap. Each tab is a real route; the current one is `aria-current`.
 */
export function PeopleCapacityTabs({
  organizationSlug,
  current,
}: {
  organizationSlug: string;
  current: PeopleCapacitySection;
}) {
  const tOr = useTOr();
  return (
    <nav className="ppl-cap-tabs" aria-label={tOr('PeopleCapacityTabs.label', 'Capacity sections')}>
      <ul className="ppl-cap-tabs__list">
        {SECTIONS.map((section) => (
          <li key={section.id}>
            <Link
              href={`/${organizationSlug}/people${section.path}`}
              className="ppl-cap-tabs__link"
              {...(section.id === current ? { 'aria-current': 'page' as const } : {})}
            >
              {tOr(section.key, section.english)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
