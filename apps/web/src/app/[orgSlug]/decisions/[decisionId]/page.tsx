'use client';

import { use } from 'react';
import { DecisionDetailScreen } from '../../../../components/screens/DecisionDetailScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Decision detail page** (A15, Figma 384:3835 / 384:4073).
 *
 * Under `[orgSlug]/decisions/[decisionId]`: the screen reads `GET …/decisions/:id` and its linked
 * work, both gated on the server, so a member who may not see the decision gets the API's
 * not-found rather than a blank page. Reached from the register's rows and the decisions column.
 */
export default function DecisionDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; decisionId: string }>;
}) {
  const { orgSlug, decisionId } = use(params);

  return (
    <DecisionDetailScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      decisionId={decisionId}
    />
  );
}
