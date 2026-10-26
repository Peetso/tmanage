'use client';

import { use } from 'react';
import { MeetingFormScreen } from '../../../../components/meetings/MeetingFormScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/** **New meeting** (approved Figma 417:9827). `?project=<id>` preselects the project. */
export default function NewMeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ project?: string | string[] }>;
}) {
  const { orgSlug } = use(params);
  const { project } = use(searchParams);
  return (
    <MeetingFormScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      {...(typeof project === 'string' ? { initialProjectId: project } : {})}
    />
  );
}
