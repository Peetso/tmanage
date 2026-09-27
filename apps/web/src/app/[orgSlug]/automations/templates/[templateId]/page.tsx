'use client';

import { use } from 'react';
import { AutomationTemplateEditScreen } from '../../../../../components/screens/AutomationTemplateEditScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Automations & integrations — edit a workflow template (module 17, x189).**
 *
 * The template is named by the path, so the URL is a link an admin can be sent. The screen reads the
 * org-scoped template list, prefills the edit form, and writes `PATCH …/automations/templates/:id`
 * behind `org.manage`; an unknown or cross-tenant id is a 404 from the API, rendered as a not-found
 * state. The organization name is still a fixture, for the sibling automations page's reason: no
 * endpoint returns the current organization's profile by slug.
 */
export default function AutomationTemplateEditPage({
  params,
}: {
  params: Promise<{ orgSlug: string; templateId: string }>;
}) {
  const { orgSlug, templateId } = use(params);

  return (
    <AutomationTemplateEditScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      templateId={templateId}
    />
  );
}
