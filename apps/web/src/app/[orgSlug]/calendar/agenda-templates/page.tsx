'use client';

import { use } from 'react';
import { MeetingAgendaTemplatesView } from '../../../../components/screens/MeetingAgendaTemplatesView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **CAL agenda templates (x314).**
 *
 * The reusable-agenda manager beside the meetings list (`/calendar`): a tenant's agenda templates,
 * created/deleted here and applied to a meeting to seed its agenda items. No project id in the URL —
 * a template is org-scoped by definition.
 *
 * The organization name is still a fixture, for `CalendarPage`'s reason: no endpoint returns the
 * current organization's profile by slug.
 */
export default function CalendarAgendaTemplatesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <MeetingAgendaTemplatesView
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
