'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { InviteTeamScreen } from '../../../../components/screens/InviteTeamScreen';

/**
 * **ON-04 Invite internal team.**
 *
 * Under `[orgSlug]` because an invitation is into one organization, and as of `TEN-003` the
 * slug is used rather than merely awaited: the screen posts to
 * `/v1/organizations/:slug/invitations`.
 *
 * No endpoint lists the people in an organization or returns its own mail domain, so the
 * browser-side duplicate and outside-domain checks have nothing to compare against and stay
 * off (they used the design's sample company before, which warned real owners about their own
 * colleagues). Neither decides anything: the API refuses a duplicate on its own, with a 409.
 */
export default function InviteTeamPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  // ON-03 hands over `?project=created` when it made the project; a typed URL shows it as skipped.
  const projectCreated = useSearchParams().get('project') === 'created';

  return (
    <InviteTeamScreen
      signedInAs=""
      organizationSlug={orgSlug}
      organizationDomain=""
      existingMembers={[]}
      completedSteps={projectCreated ? ['ON-02', 'ON-03'] : ['ON-02']}
    />
  );
}
