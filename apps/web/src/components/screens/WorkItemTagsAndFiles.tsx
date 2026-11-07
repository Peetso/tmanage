'use client';

import { useQuery } from '@tanstack/react-query';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { listWorkItemFiles } from '../../lib/api/work-items';
import { listItemLabels } from '../../lib/api/work-labels';
import { WorkItemLabelChips } from './WorkItemLabelChips';
import { NotScannedDownload } from './NotScannedDownload';
import { useT } from '../../lib/i18n/use-t';
import './capture-extras.css';
import './work-item-tags-files.css';

export interface WorkItemTagsAndFilesProps {
  readonly organizationSlug: string;
  readonly workItemId: string;
  readonly client?: ApiClient;
  /** The API origin the download links point at; the browser client's own by default. */
  readonly downloadBase?: string;
}

/**
 * A work item's labels and attached files, read-only, on the item's overview — where the labels
 * and files chosen in the New work capsule show up afterwards. Each file opens through the
 * existing download route, which serves it only once it has been verified and scanned clean.
 * A section that failed to load says so in a line rather than looking empty.
 */
export function WorkItemTagsAndFiles({
  organizationSlug,
  workItemId,
  client,
  downloadBase,
}: WorkItemTagsAndFilesProps) {
  const t = useT();
  const api = client ?? browserApiClient();

  const labels = useQuery({
    queryKey: ['work-item-labels', organizationSlug, workItemId],
    queryFn: () => listItemLabels(api, organizationSlug, workItemId),
  });
  const files = useQuery({
    queryKey: ['work-item-files', organizationSlug, workItemId],
    queryFn: () => listWorkItemFiles(api, organizationSlug, workItemId),
  });

  const base = downloadBase ?? apiBaseUrl();

  return (
    <section className="tm-wk-card tm-stack" aria-labelledby="tm-work-tags-files">
      <h2 id="tm-work-tags-files" className="tm-wk-card__eyebrow">
        {t('WorkItemTagsAndFiles.heading')}
      </h2>

      <div className="tm-capture-extra">
        <span className="tm-capture-extra__label">{t('WorkItemTagsAndFiles.labels')}</span>
        {labels.isPending ? (
          <p className="tm-capture-extra__hint">{t('WorkItemTagsAndFiles.loadingLabels')}</p>
        ) : labels.isError ? (
          <p className="tm-capture-extra__hint">{t('WorkItemTagsAndFiles.labelsError')}</p>
        ) : (
          <WorkItemLabelChips labels={labels.data} />
        )}
      </div>

      <div className="tm-capture-extra">
        <span className="tm-capture-extra__label">{t('WorkItemTagsAndFiles.attachments')}</span>
        {files.isPending ? (
          <p className="tm-capture-extra__hint">{t('WorkItemTagsAndFiles.loadingAttachments')}</p>
        ) : files.isError ? (
          <p className="tm-capture-extra__hint">{t('WorkItemTagsAndFiles.attachmentsError')}</p>
        ) : files.data.length === 0 ? (
          <p className="tm-capture-extra__hint">{t('WorkItemTagsAndFiles.noFiles')}</p>
        ) : (
          <ul className="tm-capture-extra__chips tm-capture-extra__list tm-work-files">
            {files.data.map((file) =>
              file.availability === 'ready' ? (
                // Ready: a download link, as before. A link to the scan route is offered only
                // once the file is servable, so clicking never lands on a raw-JSON refusal.
                <li key={file.id}>
                  <a
                    className="tm-chip tm-chip--compact"
                    href={`${base}/v1/organizations/${encodeURIComponent(organizationSlug)}/files/${encodeURIComponent(file.fileAssetId)}/content`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className="tm-capture-extra__file-name" title={file.fileName}>
                      {file.fileName}
                    </span>
                  </a>
                </li>
              ) : file.availability === 'scanning' ? (
                // C4. Not scanned yet: the same Not scanned label and Download as the work item
                // Files row. Under "Block until scanned" the API refuses it and Download is
                // disabled with the reason.
                <li key={file.id} className="tm-scan-row">
                  <span className="tm-chip tm-chip--compact" aria-disabled="true">
                    <span className="tm-capture-extra__file-name" title={file.fileName}>
                      {file.fileName}
                    </span>
                  </span>
                  <NotScannedDownload
                    href={`${base}/v1/organizations/${encodeURIComponent(organizationSlug)}/files/${encodeURIComponent(file.fileAssetId)}/content`}
                    fileName={file.fileName}
                  />
                </li>
              ) : (
                // Not servable: the file's name with the reason, never a dead link.
                <li key={file.id}>
                  <span className="tm-chip tm-chip--compact" aria-disabled="true">
                    <span className="tm-capture-extra__file-name" title={file.fileName}>
                      {file.fileName}
                    </span>
                  </span>
                  <span className="tm-capture-extra__hint" role="status">
                    {t('WorkItemTagsAndFiles.unavailable')}
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
        <p className="tm-capture-extra__hint">{t('WorkItemTagsAndFiles.scanHint')}</p>
      </div>
    </section>
  );
}
