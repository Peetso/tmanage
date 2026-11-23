'use client';

import { useId } from 'react';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import type { UploadAttachmentOptions } from '../../lib/api/uploads';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import { useA6T } from '../work/DueDatePicker';
import { NewWorkForm } from '../work/create/NewWorkForm';
import { useNewWork } from '../work/create/use-new-work';
import type { CaptureDraft } from '../work/create/new-work-model';

export interface QuickCaptureScreenProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  /** Prefill from the share-target payload (`?title=`/`?text=`/`?url=`). */
  readonly draft?: CaptureDraft;
  /** The project to open on (`?project=`), when it is one of the caller's projects. */
  readonly initialProjectId?: string;
  readonly client?: ApiClient;
  /** Test seam for the upload's part PUTs and idempotency keys. */
  readonly uploadOptions?: UploadAttachmentOptions;
  readonly now?: Date;
}

/**
 * **New work as a page** (`/{org}/capture`; modules 22/23, W-WEB-3). Full create (Figma `WV2-04`
 * phone page `935:98783`) for the three ways that land here without a screen behind them: the
 * phone's "+", the palette's `capture-new` and the installed app's share target, whose payload
 * prefills the name and the description (`buildCaptureDraft`). It is the same form as the
 * New work dialog; after Create it stays, cleared, with a link to the work it made.
 */
export function QuickCaptureScreen({
  organizationSlug,
  organizationName,
  draft,
  initialProjectId,
  client,
  uploadOptions,
  now,
}: QuickCaptureScreenProps) {
  const api = client ?? browserApiClient();
  const t = useA6T();
  const describe = useDescribeApiError(OFFLINE_LINES);
  const titleId = useId();
  const work = useNewWork({
    api,
    organizationSlug,
    ...(draft ? { draft } : {}),
    ...(initialProjectId ? { initialProjectId } : {}),
    ...(uploadOptions ? { uploadOptions } : {}),
    ...(now === undefined ? {} : { now }),
    onCreated: (_result, another) => {
      if (!another) work.resetForNext();
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={t('NewWork.title')}
    >
      {work.projects.isPending ? (
        <LoadingRegion label={t('NewWork.loading')}>
          <Skeleton height="220px" radius="var(--r-card)" />
        </LoadingRegion>
      ) : work.projects.isError ? (
        <InlineAlert tone="danger" title={t('NewWork.loadFailed')}>
          {describe(work.projects.error)}
        </InlineAlert>
      ) : (
        <NewWorkForm
          api={api}
          organizationSlug={organizationSlug}
          work={work}
          mode="full"
          layout="page"
          titleId={titleId}
          {...(now === undefined ? {} : { now })}
        />
      )}
    </AppShell>
  );
}
