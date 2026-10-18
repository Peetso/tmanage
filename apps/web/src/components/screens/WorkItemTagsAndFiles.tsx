'use client';

import { useQuery } from '@tanstack/react-query';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { listWorkItemFiles } from '../../lib/api/work-items';
import { listItemLabels } from '../../lib/api/work-labels';
import { WorkItemLabelChips } from './WorkItemLabelChips';
import './capture-extras.css';

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
        Labels and attachments
      </h2>

      <div className="tm-capture-extra">
        <span className="tm-capture-extra__label">Labels</span>
        {labels.isPending ? (
          <p className="tm-capture-extra__hint">Loading labels…</p>
        ) : labels.isError ? (
          <p className="tm-capture-extra__hint">The labels could not be loaded.</p>
        ) : (
          <WorkItemLabelChips labels={labels.data} />
        )}
      </div>

      <div className="tm-capture-extra">
        <span className="tm-capture-extra__label">Attachments</span>
        {files.isPending ? (
          <p className="tm-capture-extra__hint">Loading attachments…</p>
        ) : files.isError ? (
          <p className="tm-capture-extra__hint">The attachments could not be loaded.</p>
        ) : files.data.length === 0 ? (
          <p className="tm-capture-extra__hint">No files attached.</p>
        ) : (
          <ul className="tm-capture-extra__chips tm-capture-extra__list">
            {files.data.map((file) => (
              <li key={file.id}>
                <a
                  className="tm-chip tm-chip--compact"
                  href={`${base}/v1/organizations/${encodeURIComponent(organizationSlug)}/files/${encodeURIComponent(file.fileAssetId)}/content`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span className="tm-capture-extra__file-name">{file.fileName}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        <p className="tm-capture-extra__hint">
          A new file opens once it has been checked for viruses, usually within a minute.
        </p>
      </div>
    </section>
  );
}
