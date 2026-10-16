'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { CopilotAnswerView } from '../../../components/screens/CopilotAnswerView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **AI copilot answer view (Module 16).**
 *
 * The question can arrive in the URL (`?q=`) — how the Search screen's "Ask copilot" affordance
 * opens the panel straight onto an answer, seeded with the current search. The organization name is
 * still a fixture, for the reason every internal page here uses one: no endpoint returns the current
 * organization's profile by slug.
 */
export default function CopilotPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const search = useSearchParams();
  const q = search.get('q');

  return (
    <CopilotAnswerView
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      {...(q === null ? {} : { initialQuestion: q })}
    />
  );
}
