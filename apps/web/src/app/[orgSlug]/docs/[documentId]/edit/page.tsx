'use client';

import { use } from 'react';
import { DocumentEditorScreen } from '../../../../../components/screens/DocumentEditorScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **DOC-02 editor + DOC-03 version history/compare/restore.**
 *
 * A disjoint route from the DOC-01 hub (`/docs`) and the DOC-03 read (`/docs/[documentId]`, x106):
 * this is the write surface, reached from the read with an "Edit" link. The document id is in the
 * path; the screen loads the document and its versions.
 *
 * The organization name is still a fixture, for the reason the other internal routes give: no
 * endpoint returns the current organization's profile by slug.
 */
export default function DocumentEditorPage({
  params,
}: {
  params: Promise<{ orgSlug: string; documentId: string }>;
}) {
  const { orgSlug, documentId } = use(params);

  return (
    <DocumentEditorScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      documentId={documentId}
    />
  );
}
