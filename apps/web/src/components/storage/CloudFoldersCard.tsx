'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { attachCloudFolder, listCloudFolders } from '../../lib/api/cloud-folders';
import { getStorageStatus } from '../../lib/api/google-drive';
import { getOneDriveStatus } from '../../lib/api/onedrive';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useT } from '../../lib/i18n/use-t';
import { HelpTip } from '../help/HelpTip';
import { CloudFolderList, cloudFoldersKey } from './CloudFolderList';
import { DriveAttachPicker } from './DriveAttachPicker';
import { OneDriveAttachPicker, oneDriveStatusKey } from './OneDriveAttachPicker';

export interface CloudFoldersCardProps {
  organizationSlug: string;
  client: ApiClient;
  workItemId: string;
  projectId: string;
}

/**
 * FIX6 C3. "Live folders" on the work item, in the files card's own look: add a Google Drive or
 * OneDrive folder with the providers' own pickers (folder mode), then show its files live. The
 * buttons render nothing while the company drive is not connected; the server refuses a person
 * who may not update the work item.
 */
export function CloudFoldersCard({
  organizationSlug,
  client,
  workItemId,
  projectId,
}: CloudFoldersCardProps) {
  const t = useT();
  const describe = useDescribeApiError();
  const queries = useQueryClient();
  // The same cached reads the pickers and the list make: with no drive connected and no folder
  // attached there is nothing to show, so the card stays out of the way.
  const drive = useQuery({
    queryKey: ['storage-status', organizationSlug],
    queryFn: () => getStorageStatus(client, organizationSlug),
    staleTime: 60_000,
  });
  const oneDrive = useQuery({
    queryKey: oneDriveStatusKey(organizationSlug),
    queryFn: () => getOneDriveStatus(client, organizationSlug),
    staleTime: 60_000,
  });
  const folders = useQuery({
    queryKey: cloudFoldersKey(organizationSlug, workItemId, 'member'),
    queryFn: () => listCloudFolders(client, organizationSlug, workItemId, 'member'),
  });
  const attach = useMutation({
    mutationFn: (source: Parameters<typeof attachCloudFolder>[3]) =>
      attachCloudFolder(client, organizationSlug, workItemId, source),
    onSettled: () =>
      void queries.invalidateQueries({
        queryKey: cloudFoldersKey(organizationSlug, workItemId, 'member'),
      }),
  });

  const connected =
    drive.data?.googleDrive.status === 'connected' ||
    oneDrive.data?.oneDrive.status === 'connected';
  if (!connected && (folders.data ?? []).length === 0) return null;

  return (
    <section className="tm-wk-card" aria-labelledby="tm-wk-cloud-folders">
      <div className="tm-wk-card__head">
        <h2 id="tm-wk-cloud-folders" className="tm-wk-card__title">
          {t('CloudFolders.title')}
        </h2>
        <HelpTip tip={t('CloudFolders.tip')}>
          <span className="tm-row tm-row--wrap">
            <DriveAttachPicker
              organizationSlug={organizationSlug}
              client={client}
              picked={[]}
              onPick={(picked) => {
                const folder = picked[0];
                if (folder) attach.mutate({ provider: 'google_drive', folderId: folder.id });
              }}
              onRemove={() => undefined}
              projectId={projectId}
              disabled={attach.isPending}
              mode="folder"
              label={t('CloudFolders.attachDrive')}
            />
            <OneDriveAttachPicker
              organizationSlug={organizationSlug}
              client={client}
              picked={[]}
              onPick={(picked) => {
                const folder = picked[0];
                if (folder) {
                  attach.mutate({
                    provider: 'onedrive',
                    driveId: folder.driveId,
                    itemId: folder.itemId,
                  });
                }
              }}
              onRemove={() => undefined}
              projectId={projectId}
              disabled={attach.isPending}
              showList={false}
              mode="folder"
              label={t('CloudFolders.attachOneDrive')}
            />
          </span>
        </HelpTip>
      </div>
      {attach.isError ? (
        <InlineAlert tone="danger" title={t('CloudFolders.problem')} live>
          {describe(attach.error)}
        </InlineAlert>
      ) : null}
      <CloudFolderList
        organizationSlug={organizationSlug}
        client={client}
        workItemId={workItemId}
        door="member"
        canRemove
      />
    </section>
  );
}
