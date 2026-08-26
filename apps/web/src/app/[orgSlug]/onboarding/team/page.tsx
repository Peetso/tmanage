'use client';

import { use } from 'react';
import { InviteTeamScreen } from '../../../../components/screens/InviteTeamScreen';
import {
  FIXTURE_EXISTING_MEMBERS,
  FIXTURE_ORGANIZATION_DOMAIN,
  FIXTURE_SIGNED_IN_AS,
} from '../../../../lib/fixtures';

/**
 * **ON-04 Invite internal team.**
 *
 * Under `[orgSlug]` because an invitation is into one organization, and as of `TEN-003` the
 * slug is used rather than merely awaited: the screen posts to
 * `/v1/organizations/:slug/invitations`.
 *
 * Two fixtures remain, and both are the same gap `ON-03`'s owner field records. There is no
 * endpoint that lists the people in an organization, so the duplicate check runs against an
 * invented list, and none that returns the organization's own mail domain, so the
 * outside-domain check compares against an invented one. Both checks are advisory in the
 * browser and neither decides anything: the API refuses a duplicate on its own, with a 409.
 */
export default function InviteTeamPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <InviteTeamScreen
      signedInAs={FIXTURE_SIGNED_IN_AS}
      organizationSlug={orgSlug}
      organizationDomain={FIXTURE_ORGANIZATION_DOMAIN}
      existingMembers={FIXTURE_EXISTING_MEMBERS}
    />
  );
}
