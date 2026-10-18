'use client';

import { use, useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { WorkCalendarScreen } from '../../../../components/screens/WorkCalendarScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';
import type { CalendarRange } from '../../../../lib/work-calendar-range';

/**
 * **WK-05 Work calendar.**
 *
 * The project can arrive in the query string, which is how a project screen hands off to its
 * calendar: the link carries `?project=`, and the calendar opens on it. A custom range rides along
 * as `?from=&to=` (both `YYYY-MM-DD`), and the screen writes every valid range it moves to back
 * here — returning to this month drops them — so a range is a link a colleague can be sent. A
 * malformed range in a link is shown with its problem rather than silently replaced.
 *
 * The organization name is still a fixture, for `WorkPage`'s reason: no endpoint returns the
 * current organization's profile by slug.
 */
export default function WorkCalendarPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const project = search.get('project');
  const from = search.get('from');
  const to = search.get('to');

  const onRangeChange = useCallback(
    (range: CalendarRange | null) => {
      const next = new URLSearchParams(search.toString());
      if (range === null) {
        next.delete('from');
        next.delete('to');
      } else {
        next.set('from', range.from);
        next.set('to', range.to);
      }
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, search],
  );

  return (
    <WorkCalendarScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      {...(project === null ? {} : { initialProjectId: project })}
      {...(from !== null && to !== null ? { initialFrom: from, initialTo: to } : {})}
      onRangeChange={onRangeChange}
    />
  );
}
