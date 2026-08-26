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
 * Under `[orgSlug]`, and still sending nothing: invitations are `TEN-003`, which built the
 * storage half only. The domain and the existing-member list are fixtures for the same
 * reason `ON-03`'s owner is — there is no endpoint that lists the people in an organization.
 */
export default function InviteTeamPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  use(params);
  return (
    <InviteTeamScreen
      signedInAs={FIXTURE_SIGNED_IN_AS}
      organizationDomain={FIXTURE_ORGANIZATION_DOMAIN}
      existingMembers={FIXTURE_EXISTING_MEMBERS}
    />
  );
}
