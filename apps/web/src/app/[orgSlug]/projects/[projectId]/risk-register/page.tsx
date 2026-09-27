'use client';

import { use } from 'react';
import { ProjectRiskRegisterScreen } from '../../../../../components/screens/ProjectRiskRegisterScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Project risk register** — PROJ / module 8 (x209).
 *
 * Under `[orgSlug]/projects/[projectId]/risk-register`: the slug and the project id are the claims the
 * API's `TenantContextGuard` and the risk-register service resolve — the slug against a membership
 * row, the project id tenant-scoped before any read or write. The screen reads
 * `GET …/projects/:id/risk-register` and writes `POST …/risk-register` / `PATCH …/risk-register/:id`,
 * gated on the server by `project.manage` / `work.read`, so a member without the capability sees the
 * API's refusal rather than a blank page. This is the internal register, never shown to a client.
 */
export default function ProjectRiskRegisterPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);

  return (
    <ProjectRiskRegisterScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
