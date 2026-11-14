'use client';

import { useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { clientOnlyRead } from '../../lib/portal-preview';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { PortalFigmaLinks } from '../viewer/FigmaLinks';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import { listPortalFiles, listPortalProjects, portalFileDownloadPath } from '../../lib/api/portal';
import type { PortalFile } from '../../lib/api/portal';
import { PORTAL_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { shortDay } from './PortalParts';
import { PortalOpenComments, PortalReviewLink } from './PortalReviewLink';
import { CheckedLabel } from './CheckedLabel';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import './download-scan-policy.css';

export interface PortalFilesScreenProps {
  organizationSlug: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **Files** — the sixth destination on the client portal nav (`22-SCREEN-BY-SCREEN` §1),
 * FILE-003 · WEB-006.
 *
 * The UI over the FILE-002 download surface. The client's projects come first (`CL-01`'s scope),
 * and each one's downloadable files are read from `GET /portal/projects/:projectId/files` — the
 * list the download door would actually serve, so a file shown here is a file that downloads. The
 * per-file link points at the existing authenticated door (`portalFileDownloadPath`); nothing here
 * widens the short-lived scoped grant that door issues.
 *
 * ## What is honestly not here
 *
 * A client's files are request attachments today — the only purpose `12-PERMISSION-MATRIX` lets a
 * client download (`purpose-policy.ts`). Published deliverables are `DEL-001`/CL-05, unbuilt, so
 * they are named in `BackendPending` rather than drawn empty. Uploading from the portal is the
 * next scope (NS-13); this screen reads, it does not write.
 *
 * ## A file the virus scan has not checked yet (C4)
 *
 * The list carries the company owner's "downloads before a virus scan" policy per file. Under
 * "Allow, marked Not scanned" the row keeps Download and shows the same Not scanned label as the
 * work item Files row. Under "Block until scanned" it shows Being checked, Download is disabled,
 * and the row says why. A rejected or infected file never reaches this list.
 *
 * ## The empty state
 *
 * A client with no files needs to know the tab works and nothing is waiting — the same job the
 * actions screen's empty state does. It says so plainly rather than looking broken.
 */
export function PortalFilesScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: PortalFilesScreenProps) {
  const describe = useDescribeApiError(PORTAL_LINES);
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const t = useT();
  const [search, setSearch] = useState('');

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const projectList = projects.data ?? [];

  // One query per project the client can see: files are a project's, never the tenant's, so the
  // list route names a project. `useQueries` keeps them independent — one project failing does not
  // blank the rest.
  const queryClient = useQueryClient();
  // 2026-10-31 live-test fix: a staff preview reads the client's empty list, not the API's 403.
  const fileQueries = useQueries({
    queries: projectList.map((project) => ({
      queryKey: ['portal-files', organizationSlug, project.id],
      queryFn: () =>
        clientOnlyRead(
          queryClient,
          organizationSlug,
          [] as Awaited<ReturnType<typeof listPortalFiles>>,
          () => listPortalFiles(api, organizationSlug, project.id),
        ),
    })),
  });

  const anyFilesLoading = projects.isPending || fileQueries.some((query) => query.isPending);
  const anyFilesError = fileQueries.some((query) => query.isError);
  const totalFiles = fileQueries.reduce((sum, query) => sum + (query.data?.length ?? 0), 0);
  const needle = search.trim().toLowerCase();

  const rows = projectList.flatMap((project, index) =>
    (fileQueries[index]?.data ?? [])
      .filter((file) => needle === '' || file.name.toLowerCase().includes(needle))
      .map((file) => ({ file, project })),
  );

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="files"
      title={t('PortalFilesScreen.title')}
      eyebrow={`${t('PortalFilesScreen.eyebrowPrefix')} · ${totalFiles} ${
        totalFiles === 1 ? t('PortalFilesScreen.itemWord') : t('PortalFilesScreen.itemsWord')
      }`}
      headerAside={
        totalFiles > 0 ? (
          <label className="tm-pt-aside-row">
            <span className="tm-pt-visually-hidden">{t('PortalFilesScreen.searchLabel')}</span>
            <input
              type="search"
              className="tm-pt-search"
              placeholder={t('PortalFilesScreen.searchLabel')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        ) : undefined
      }
    >
      <div className="tm-pt tm-pt--compact">
        <PortalFigmaLinks organizationSlug={organizationSlug} client={api} />
        {projects.isError ? (
          <InlineAlert tone="danger" title={t('PortalFilesScreen.loadErrorTitle')} live>
            {describe(projects.error)}
          </InlineAlert>
        ) : null}

        {anyFilesError && !projects.isError ? (
          <InlineAlert tone="danger" title={t('PortalFilesScreen.partialErrorTitle')} live>
            {t('PortalFilesScreen.partialErrorBody')}
          </InlineAlert>
        ) : null}

        {anyFilesLoading && !projects.isError ? (
          <LoadingRegion label={t('PortalFilesScreen.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!anyFilesLoading && !projects.isError && !anyFilesError && totalFiles === 0 ? (
          <div className="tm-pt-card tm-pt-card--dashed tm-pt-card--lg">
            <h2 className="tm-pt-card__title">{t('PortalFilesScreen.emptyTitle')}</h2>
            <p className="tm-pt-card__body">
              {t('PortalFilesScreen.emptyPrefix')} {providerName}{' '}
              {t('PortalFilesScreen.emptySuffix')}
            </p>
          </div>
        ) : null}

        {totalFiles > 0 ? (
          <div className="tm-pt-table-wrap">
            <table
              className="tm-pt-table"
              aria-label={`${t('PortalFilesScreen.filesFrom')} ${providerName}`}
            >
              <thead>
                <tr>
                  <th scope="col">{t('PortalFilesScreen.thFile')}</th>
                  <th scope="col">{t('PortalFilesScreen.thBelongsTo')}</th>
                  <th scope="col">{t('PortalFilesScreen.thShared')}</th>
                  <th scope="col">{t('Viewer.portal.commentsColumn')}</th>
                  <th scope="col">
                    <span className="tm-pt-visually-hidden">
                      {t('PortalFilesScreen.downloadLabel')}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ file, project }) => (
                  <tr key={file.id}>
                    <td>
                      <div className="tm-pt-file">
                        <span className="tm-pt-file__icon" aria-hidden="true" />
                        <div>
                          <p className="tm-pt-file__name">{file.name}</p>
                          <p className="tm-pt-mono">{describeFile(file)}</p>
                          {file.scanStatus === 'being_checked' ? (
                            <p className="tm-pt-mono" id={`tm-scan-why-${file.id}`}>
                              {t('DownloadScan.blocked')}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td>{project.name}</td>
                    <td>{shortDay(file.uploadedAt)}</td>
                    <td>
                      <PortalOpenComments openComments={file.openComments} />
                    </td>
                    <td>
                      <span className="tm-scan-row__actions">
                        {file.scanStatus === 'not_scanned' ? <CheckedLabel /> : null}
                        {file.scanStatus === 'being_checked' ? (
                          <StateCapsule state="waiting" className="tm-scan-capsule">
                            {t('WorkDetail.scanning')}
                          </StateCapsule>
                        ) : null}
                        {file.scanStatus === 'being_checked' ? (
                          <button
                            type="button"
                            className="tm-pt-btn tm-pt-btn--quiet"
                            disabled
                            aria-describedby={`tm-scan-why-${file.id}`}
                          >
                            {t('PortalFilesScreen.download')}
                          </button>
                        ) : (
                          <a
                            className="tm-pt-btn tm-pt-btn--quiet"
                            href={`${apiBaseUrl()}${portalFileDownloadPath(organizationSlug, file.id)}`}
                            download={file.name}
                          >
                            {t('PortalFilesScreen.download')}
                          </a>
                        )}
                        {file.reviewable && file.scanStatus !== 'being_checked' ? (
                          <PortalReviewLink
                            organizationSlug={organizationSlug}
                            fileId={file.id}
                            fileName={file.name}
                            openComments={file.openComments}
                            showCount={false}
                          />
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      {t('PortalFilesScreen.noMatch')} “{search}”.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}

        <p className="tm-pt-eyebrow">
          ⊘ {t('PortalFilesScreen.footPrefix')} {providerName} {t('PortalFilesScreen.footMid')}{' '}
          {clientName} {t('PortalFilesScreen.footSuffix')}
        </p>
      </div>
    </ClientPortalShell>
  );
}

function describeFile(file: PortalFile): string {
  const kind = file.contentType.split('/').pop()?.split(/[.+-]/).pop() ?? '';
  return kind ? `${kind} · ${formatBytes(file.sizeBytes)}` : formatBytes(file.sizeBytes);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} bytes`;
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
