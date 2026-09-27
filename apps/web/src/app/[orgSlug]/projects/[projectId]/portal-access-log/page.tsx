'use client';

import { use } from 'react';
import { PortalAccessLogScreen } from '../../../../../components/screens/PortalAccessLogScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Portal access log** — SEC / Client portal (module 13, x237).
 *
 * Under `[orgSlug]/projects/[projectId]/portal-access-log`: the slug and the project id are the
 * claims the API's `TenantContextGuard` and the access-log service resolve — the slug against a
 * membership row, the project id tenant-scoped before any read. The screen reads
 * `GET …/projects/:id/portal-access-log`, gated on the server by `project.manage`, so a member
 * without the capability sees the API's refusal rather than a blank page. This is the internal audit
 * view of what a client accessed; it is never shown to a client.
 */
export default function PortalAccessLogPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);

  return (
    <PortalAccessLogScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
