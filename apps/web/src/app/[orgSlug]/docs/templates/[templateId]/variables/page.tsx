'use client';

import { use } from 'react';
import { DocumentTemplateVariablesScreen } from '../../../../../../components/screens/DocumentTemplateVariablesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../../lib/fixtures';

/**
 * **DOC-04 template variables (x130).**
 *
 * A disjoint route from the template gallery (`/docs/templates`): this is one template's variables
 * surface — add a variable, list them, and remove one.
 *
 * The organization name is still a fixture, for the reason the other internal routes give: no
 * endpoint returns the current organization's profile by slug.
 */
export default function DocumentTemplateVariablesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; templateId: string }>;
}) {
  const { orgSlug, templateId } = use(params);

  return (
    <DocumentTemplateVariablesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      templateId={templateId}
    />
  );
}
