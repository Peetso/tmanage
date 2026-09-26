'use client';

import { use } from 'react';
import { DecisionRegisterScreen } from '../../../components/screens/DecisionRegisterScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Decision register** — DEC-01's cross-meeting register (x113).
 *
 * Under `[orgSlug]/decisions`: the slug is the claim the API's `TenantContextGuard` resolves against
 * a membership row. The screen chooses a project and reads `GET …/decisions?projectId=` and writes
 * `POST …/decisions`, both gated on the server by the calendar's `meeting.read` / `meeting.write`, so
 * a member without the capability sees the API's refusal rather than a blank page.
 */
export default function DecisionsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <DecisionRegisterScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
