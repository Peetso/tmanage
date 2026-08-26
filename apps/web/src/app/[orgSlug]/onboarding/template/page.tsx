'use client';

import { use } from 'react';
import { OperatingTemplateScreen } from '../../../../components/screens/OperatingTemplateScreen';
import { FIXTURE_SIGNED_IN_AS } from '../../../../lib/fixtures';

/**
 * **ON-02 Choose operating template.**
 *
 * Under `[orgSlug]` for the same reason `ON-03` is, even though nothing it collects is saved
 * yet: the template is a property of an organization, so the URL should say which one from
 * the start rather than being moved later.
 */
export default function OperatingTemplatePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  // Read so the route is honest about what it receives; the screen saves nothing yet.
  use(params);
  return <OperatingTemplateScreen signedInAs={FIXTURE_SIGNED_IN_AS} />;
}
