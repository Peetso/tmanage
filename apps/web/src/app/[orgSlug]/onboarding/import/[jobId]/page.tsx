'use client';

import { use } from 'react';
import { ImportReceiptScreen } from '../../../../../components/screens/ImportReceiptScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Import receipt** — ON-09 ("progress" / partial failure) / ADM-10 ("receipt"). The screen for
 * a committed import job's per-row receipt.
 *
 * Under `[orgSlug]/onboarding/import/[jobId]` for the reason every tenant-scoped route is: the
 * slug in the path is the claim the API's `TenantContextGuard` resolves against a membership row
 * before any handler runs, and the job id names the committed job whose receipt to read. It is
 * not on the internal rail (`22-SCREEN-BY-SCREEN` §1), like the billing screen, so no nav entry
 * is added.
 */
export default function ImportReceiptPage({
  params,
}: {
  params: Promise<{ orgSlug: string; jobId: string }>;
}) {
  const { orgSlug, jobId } = use(params);

  return (
    <ImportReceiptScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      jobId={jobId}
    />
  );
}
