'use client';

import { use } from 'react';
import { DocumentViewScreen } from '../../../../components/screens/DocumentViewScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **DOC-03 Document view (read side).**
 *
 * Both identifiers come from the path. The document id is not a credential — the API answers 404
 * for a document in another tenant, in a project the caller is not a member of, or one that does
 * not exist, all the same way (x91, resolved tenant-scoped before the relation check) — so it is
 * safe in a URL and a link to a document is a link a colleague can follow.
 */
export default function DocumentPage({
  params,
}: {
  params: Promise<{ orgSlug: string; documentId: string }>;
}) {
  const { orgSlug, documentId } = use(params);

  return (
    <DocumentViewScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      documentId={documentId}
    />
  );
}
