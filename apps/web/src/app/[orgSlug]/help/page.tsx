'use client';

import { use } from 'react';
import { GetHelpScreen } from '../../../components/support/GetHelpScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Get help** — `/{orgSlug}/help` (plan row 57-10, Figma 614:35008). `?from=` is the page the
 * help menu was opened on; `?request=` opens one request (the reply e-mail's link).
 */
export default function GetHelpPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ from?: string | string[]; request?: string | string[] }>;
}) {
  const { orgSlug } = use(params);
  const { from, request } = use(searchParams);
  return (
    <GetHelpScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      from={typeof from === 'string' ? from : undefined}
      request={typeof request === 'string' ? request : undefined}
    />
  );
}
