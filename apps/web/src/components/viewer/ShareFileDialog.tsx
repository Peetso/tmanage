'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { listProjectShares } from '../../lib/api/clients';
import {
  addDeliverableVersion,
  createDeliverable,
  shareWithClient,
} from '../../lib/api/deliverables';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { ApiRequestError } from '../../lib/api/errors';
import { useTOr } from '../../lib/i18n/use-t-or';
import { WorkDialogFrame } from '../work/DueDatePicker';
import { PreviewAsClientLink } from '../screens/PreviewAsClientLink';

export interface ShareFileDialogProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly file: { readonly id: string; readonly name: string; readonly projectId: string };
  /** The viewer was opened from a deliverable version: that deliverable is where it is shared. */
  readonly fromDeliverable: boolean;
  readonly onClose: () => void;
}

type Done = { readonly deliverableId: string };

/** The deliverable's title from the file name, without its extension ("Logo final.pdf" → "Logo final"). */
function titleFrom(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = (dot > 0 ? name.slice(0, dot) : name).trim();
  return (base === '' ? name : base).slice(0, 200);
}

/**
 * **Share with client (UX-1, live UX test 69836a13 O-P0-1).** The viewer's Share was a grey button
 * that never said why. A file reaches a client through a deliverable — the one thing the portal
 * shows and the one record approvals hang off — so Share puts this file in a new deliverable and
 * shares it, in one step. Before that, it says plainly when no client can open the project yet,
 * with the way to fix it; after, it says what the client now sees, with "Preview as client".
 * The API decides every step (`deliverable.create`, `deliverable.publish`, the sharing rule).
 */
export function ShareFileDialog({
  api,
  organizationSlug,
  file,
  fromDeliverable,
  onClose,
}: ShareFileDialogProps) {
  const tOr = useTOr();
  const titleId = useId();
  const describe = useDescribeApiError();
  const queryClient = useQueryClient();
  const [done, setDone] = useState<Done | null>(null);
  const projectHref = `/${organizationSlug}/projects/${encodeURIComponent(file.projectId)}`;

  const shares = useQuery({
    queryKey: ['project-shares', organizationSlug, file.projectId],
    queryFn: () => listProjectShares(api, organizationSlug, file.projectId),
    enabled: !fromDeliverable,
  });

  const share = useMutation({
    mutationFn: async (): Promise<Done> => {
      const deliverable = await createDeliverable(api, organizationSlug, {
        projectId: file.projectId,
        title: titleFrom(file.name),
        description: null,
      });
      const version = await addDeliverableVersion(api, organizationSlug, deliverable.id, {
        fileAssetId: file.id,
        note: null,
      });
      await shareWithClient(api, organizationSlug, deliverable.id, version.id);
      return { deliverableId: deliverable.id };
    },
    onSuccess: (result) => {
      setDone(result);
      void queryClient.invalidateQueries({
        queryKey: ['deliverables', organizationSlug, file.projectId],
      });
    },
  });

  const failure = (error: unknown): string => {
    if (error instanceof ApiRequestError && error.status === 403) {
      return tOr(
        'ShareFile.notAllowed',
        'Only the owner or a project manager can share files with clients.',
      );
    }
    if (error instanceof ApiRequestError && error.status === 422) {
      return tOr(
        'ShareFile.notUsable',
        'This file belongs to a task or a message, so it cannot be sent on its own. Upload it to a deliverable instead.',
      );
    }
    return describe(error);
  };

  const noClient = shares.isSuccess && shares.data.length === 0;

  return (
    <WorkDialogFrame labelledBy={titleId} onClose={onClose}>
      <h2 id={titleId} className="tm-wk-dialog__title">
        {tOr('ShareFile.title', 'Share “{name}” with your client').split('{name}').join(file.name)}
      </h2>
      {done ? (
        <>
          <InlineAlert tone="success" title={tOr('ShareFile.doneTitle', 'Shared')} live>
            {tOr(
              'ShareFile.doneBody',
              'Your client can now open this file in the portal. Nobody was e-mailed.',
            )}
          </InlineAlert>
          <div className="tm-wk-dialog__actions">
            <Link
              className="tm-button tm-button--outline tm-button--accessible"
              href={`${projectHref}/deliverables/${encodeURIComponent(done.deliverableId)}`}
            >
              {tOr('ShareFile.openDeliverable', 'Open the deliverable')}
            </Link>
            <PreviewAsClientLink
              organizationSlug={organizationSlug}
              projectId={file.projectId}
              compact={false}
            />
            <Button tone="ink" size="accessible" onClick={onClose}>
              {tOr('ShareFile.close', 'Done')}
            </Button>
          </div>
        </>
      ) : fromDeliverable ? (
        <>
          <p className="tm-wk-dialog__lede">
            {tOr(
              'ShareFile.fromDeliverable',
              'This file is a version of a deliverable. Share it from the deliverable page, where you can also ask for approval.',
            )}
          </p>
          <div className="tm-wk-dialog__actions">
            <Button tone="outline" size="accessible" onClick={onClose}>
              {tOr('ShareFile.cancel', 'Cancel')}
            </Button>
            <Link
              className="tm-button tm-button--ink tm-button--accessible"
              href={`${projectHref}/deliverables`}
            >
              {tOr('ShareFile.openDeliverables', 'Open deliverables')}
            </Link>
          </div>
        </>
      ) : shares.isPending ? (
        <LoadingRegion label={tOr('ShareFile.loading', 'Checking who can see this project')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : noClient ? (
        <>
          <p className="tm-wk-dialog__lede">
            {tOr(
              'ShareFile.noClient',
              'No client can open this project yet. Add the client company to the project and invite someone from it; then you can share files with them.',
            )}
          </p>
          <div className="tm-wk-dialog__actions">
            <Button tone="outline" size="accessible" onClick={onClose}>
              {tOr('ShareFile.cancel', 'Cancel')}
            </Button>
            <Link
              className="tm-button tm-button--ink tm-button--accessible"
              href={`/${organizationSlug}/clients`}
            >
              {tOr('ShareFile.inviteClient', 'Invite someone from the client')}
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="tm-wk-dialog__lede">
            {tOr(
              'ShareFile.body',
              'Your client will see this file in the portal as a new deliverable, and can open and comment on it. Nobody is e-mailed. Want a sign-off too? Ask for approval from the deliverable afterwards.',
            )}
          </p>
          {share.isError ? (
            <InlineAlert tone="danger" title={tOr('ShareFile.failed', 'Not shared')} live>
              {failure(share.error)}
            </InlineAlert>
          ) : null}
          <div className="tm-wk-dialog__actions">
            <Button tone="outline" size="accessible" onClick={onClose}>
              {tOr('ShareFile.cancel', 'Cancel')}
            </Button>
            <Button
              tone="ink"
              size="accessible"
              loading={share.isPending}
              loadingLabel={tOr('ShareFile.sharing', 'Sharing…')}
              onClick={() => share.mutate()}
            >
              {tOr('ShareFile.confirm', 'Share with client')}
            </Button>
          </div>
        </>
      )}
    </WorkDialogFrame>
  );
}
