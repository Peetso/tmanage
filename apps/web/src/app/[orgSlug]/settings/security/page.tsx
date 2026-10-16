'use client';

import { use } from 'react';
import { SecurityScreen } from '../../../../components/screens/SecurityScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Security — personal access tokens (module 20 Preferences & accessibility).**
 *
 * The member's own API tokens for the TManage MCP server and other programmatic clients, at
 * `/{orgSlug}/settings/security`. The organization name is still a fixture, the reason every
 * sibling settings screen gives: no endpoint returns the current organization's profile by slug.
 */
export default function SecurityPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return <SecurityScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />;
}
