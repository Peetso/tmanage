'use client';

import { use } from 'react';
import { InsightsPortfolioScreen } from '../../../components/screens/InsightsPortfolioScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Insights** — the eighth destination on the internal rail (`22-SCREEN-BY-SCREEN` §1), now the
 * portfolio overview (INS-01). It was the deferred stub: x109 built the per-project dashboards under
 * `insights/projects/[projectId]` and left the org index needing a project selector. This route now
 * lands on the portfolio roll-up — each accessible project's headline figures and a drill-in link to
 * its dashboard — reading `GET …/insights/portfolio` (gated on the server by `work.read`).
 */
export default function InsightsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <InsightsPortfolioScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
