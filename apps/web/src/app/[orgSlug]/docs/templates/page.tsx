'use client';

import { use } from 'react';
import { DocumentTemplatesScreen } from '../../../../components/screens/DocumentTemplatesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **DOC-04 template gallery + ADM-06 document templates.**
 *
 * A disjoint route from the DOC-01 hub (`/docs`) and the DOC-02/03 editor
 * (`/docs/[documentId]/edit`): this is the org-scoped templates surface — create a template, and
 * apply one to a project to seed a new document.
 *
 * The organization name is still a fixture, for the reason the other internal routes give: no
 * endpoint returns the current organization's profile by slug.
 */
export default function DocumentTemplatesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <DocumentTemplatesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
