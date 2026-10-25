'use client';

import { use } from 'react';
import { PrivacyScreen } from '../../../../components/screens/PrivacyScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Privacy** — Control › Trust › Privacy (D5, Figma F5): the company export, one member's personal
 * data, and the company deletion request. The screen reads `GET …/admin/privacy`; the API answers
 * only an owner, and the screen says so in words to anyone else.
 */
export default function PrivacyPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return <PrivacyScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />;
}
