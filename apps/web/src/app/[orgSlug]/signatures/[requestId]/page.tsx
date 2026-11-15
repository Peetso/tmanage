'use client';

import { use } from 'react';
import { SignatureRequestScreen } from '../../../../components/screens/esign/SignatureRequestScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/** **52-26 Signature request** — who signed, and each signer's sealed record. */
export default function SignatureRequestPage({
  params,
}: {
  params: Promise<{ orgSlug: string; requestId: string }>;
}) {
  const { orgSlug, requestId } = use(params);

  return (
    <SignatureRequestScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      requestId={requestId}
    />
  );
}
