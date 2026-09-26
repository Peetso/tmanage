'use client';

import { use } from 'react';
import { ProjectPortfolioScreen } from '../../../../components/screens/ProjectPortfolioScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Project portfolio** — PROJ / module 8 (x137).
 *
 * Under `[orgSlug]/projects/portfolio`: `portfolio` is a static segment, so Next.js matches it before
 * the sibling `[orgSlug]/projects/[projectId]` and never reads it as a project id. The slug is the
 * claim the API's `TenantContextGuard` resolves against a membership row; the screen reads
 * `GET …/projects/portfolio`, gated on the server by `work.read`, so a member without the capability
 * sees the API's refusal rather than a blank page.
 */
export default function ProjectPortfolioPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <ProjectPortfolioScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
