'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { QuickCaptureScreen } from '../../../components/screens/QuickCaptureScreen';
import { buildCaptureDraft } from '../../../components/work/create/new-work-model';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **New work as a page (modules 22/23, W-WEB-3).**
 *
 * The share-target payload arrives in the query string (`?title=`/`?text=`/`?url=`), exactly as the
 * manifest's `share_target` declares, and full create opens prefilled from it. The same route is the
 * target of the palette's `capture-new` command and the manifest shortcut, which carry no query and
 * so open an empty capture. `?project=` opens it on that project — the work list's New work button
 * passes the project it is showing.
 *
 * The organization name is still a fixture, for the reason every internal page here uses one: no
 * endpoint returns the current organization's profile by slug.
 */
export default function CapturePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const search = useSearchParams();

  const draft = buildCaptureDraft({
    title: search.get('title'),
    text: search.get('text'),
    url: search.get('url'),
  });

  const project = search.get('project');

  return (
    <QuickCaptureScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      draft={draft}
      {...(project ? { initialProjectId: project } : {})}
    />
  );
}
