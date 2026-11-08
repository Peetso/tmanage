'use client';

import { use } from 'react';
import { ContactsImportScreen } from '../../../../components/screens/ContactsImportScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Clients → Import contacts** (r46 · 54-11, Figma 587:33749): a CSV or vCard file into the
 * caller's own invite list, with column matching, a row-by-row check, an error report and the
 * option to add the file's new companies as client companies.
 */
export default function ContactsImportPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <ContactsImportScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
