'use client';

import { use } from 'react';
import { InviteAgenciesScreen } from '../../../../components/screens/InviteAgenciesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Invite agencies** — Control › People › Invite agencies (57-08 REFERRAL, Figma 724:39791). The
 * screen reads `GET …/referral`; the API answers only the workspace owner, and the screen says so
 * in words to anyone else.
 */
export default function InviteAgenciesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <InviteAgenciesScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
