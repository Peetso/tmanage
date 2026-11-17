'use client';

import { useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { clientOnlyRead } from '../../lib/portal-preview';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { PortalFigmaLinks } from '../viewer/FigmaLinks';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import { listPortalFiles, listPortalProjects, portalFileDownloadPath } from '../../lib/api/portal';
import { PORTAL_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { shortDay } from './PortalParts';
import { PortalOpenComments, PortalReviewLink } from './PortalReviewLink';
import { CheckedLabel } from './CheckedLabel';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { useA6T } from '../work/DueDatePicker';
import {
  DropArea,
  UploadProblemCard,
  UploadingRow,
  WhichProjectDialog,
  useFileDrop,
  usePortalFileUpload,
} from './PortalFileUpload';
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
 * ## Sending a file (55-14a, Figma 644:35633)
 *
 * "Upload a file" (or a file dropped on the list) sends one file to the studio through the
 * existing client upload door (`PortalFileUpload.tsx`). A file the client sent says "You sent it";
 * one sent in this visit also says "Uploaded by you · just now". The "Which project?" sheet only
 * appears when the client has more than one project.
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
 * A client with no files needs to know the tab works and nothing is waiting, and that they can
 * send the first one. It says so plainly rather than looking broken.
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
  const ta = useA6T();
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

  const upload = usePortalFileUpload(api, organizationSlug, projectList);
  const canUpload = projectList.length > 0 && upload.uploading === null;
  const drop = useFileDrop(upload.take, canUpload);
  const uploadingProject = projectList.find(
    (project) => project.id === upload.uploading?.projectId,
  );
  const showTable = totalFiles > 0 || upload.uploading !== null;
  const uploadButton = (
    <button
      type="button"
      className="tm-pt-btn tm-pt-btn--ink tm-pfu-upload"
      onClick={upload.choose}
      disabled={!canUpload}
    >
      {ta('PortalFilesScreen.upload')}
    </button>
  );

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
      eyebrow={`${ta('PortalFilesScreen.eyebrowShared', { studio: providerName })} · ${totalFiles} ${
        totalFiles === 1 ? t('PortalFilesScreen.itemWord') : t('PortalFilesScreen.itemsWord')
      }`}
      headerAside={
        showTable ? (
          <div className="tm-pt-aside-row tm-pfu-aside">
            {uploadButton}
            <label className="tm-pfu-search">
              <span className="tm-pt-visually-hidden">{t('PortalFilesScreen.searchLabel')}</span>
              <input
                type="search"
                className="tm-pt-search"
                placeholder={t('PortalFilesScreen.searchLabel')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
        ) : undefined
      }
    >
      <div className="tm-pt tm-pt--compact tm-pfu" {...drop.handlers}>
        {upload.picker}
        <p className="tm-pt-visually-hidden" role="status">
          {upload.sentName
            ? ta('PortalFilesScreen.sentAnnounce', { name: upload.sentName, studio: providerName })
            : ''}
        </p>
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

        {upload.problems.map((problem) => (
          <UploadProblemCard
            key={problem.id}
            problem={problem}
            organizationSlug={organizationSlug}
            providerName={providerName}
            onChooseAgain={upload.chooseAgain}
          />
        ))}

        {drop.over ? (
          <DropArea
            projectName={projectList.length === 1 ? (projectList[0]?.name ?? null) : null}
          />
        ) : null}

        {!drop.over && !anyFilesLoading && !projects.isError && !anyFilesError && !showTable ? (
          <div className="tm-pt-card tm-pt-card--dashed tm-pt-card--lg tm-pfu-empty">
            <h2 className="tm-pt-card__title">{t('PortalFilesScreen.emptyTitle')}</h2>
            <p className="tm-pt-card__body">
              {ta('PortalFilesScreen.emptyBody', { studio: providerName })}
            </p>
            {projectList.length > 0 ? uploadButton : null}
          </div>
        ) : null}

        {!drop.over && showTable ? (
          <div className="tm-pt-table-wrap">
            <table
              className="tm-pt-table tm-pfu-table"
              aria-label={`${t('PortalFilesScreen.filesFrom')} ${providerName}`}
            >
              <thead>
                <tr>
                  <th scope="col">{t('PortalFilesScreen.thFile')}</th>
                  <th scope="col">{t('PortalFilesScreen.thBelongsTo')}</th>
                  <th scope="col">{t('PortalFilesScreen.thShared')}</th>
                  <th scope="col">{t('Viewer.portal.commentsColumn')}</th>
                  <th scope="col">{ta('PortalFilesScreen.thStatus')}</th>
                  <th scope="col">
                    <span className="tm-pt-visually-hidden">
                      {t('PortalFilesScreen.downloadLabel')}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {upload.uploading ? (
                  <UploadingRow
                    uploading={upload.uploading}
                    projectName={uploadingProject?.name ?? ''}
                    onCancel={upload.cancel}
                  />
                ) : null}
                {rows.map(({ file, project }) => {
                  const fresh = upload.fresh.has(file.id);
                  return (
                    <tr
                      key={file.id}
                      className={fresh ? 'tm-pfu-row tm-pfu-row--fresh' : 'tm-pfu-row'}
                    >
                      <td className="tm-pfu-cell--file">
                        <p className="tm-pt-file__name">{file.name}</p>
                        <p className="tm-pt-mono">
                          {fresh
                            ? ta('PortalFilesScreen.uploadedByYou')
                            : formatBytes(file.sizeBytes)}
                        </p>
                        {file.scanStatus === 'being_checked' ? (
                          <p className="tm-pt-mono" id={`tm-scan-why-${file.id}`}>
                            {t('DownloadScan.blocked')}
                          </p>
                        ) : null}
                      </td>
                      <td className="tm-pfu-cell--project">{project.name}</td>
                      <td className="tm-pfu-cell--day">{shortDay(file.uploadedAt)}</td>
                      <td className="tm-pfu-cell--comments">
                        <PortalOpenComments openComments={file.openComments} />
                      </td>
                      <td className="tm-pfu-cell--status">
                        <StateCapsule state="neutral">
                          {file.sentByClient
                            ? ta('PortalFilesScreen.statusSent')
                            : ta('PortalFilesScreen.statusShared')}
                        </StateCapsule>
                      </td>
                      <td className="tm-pfu-cell--actions">
                        <span className="tm-scan-row__actions">
                          {file.scanStatus === 'not_scanned' ? <CheckedLabel withNote /> : null}
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
                  );
                })}
                {rows.length === 0 && totalFiles > 0 ? (
                  <tr>
                    <td colSpan={6}>
                      {t('PortalFilesScreen.noMatch')} “{search}”.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}

        <p className="tm-pfu-foot">
          {ta(showTable ? 'PortalFilesScreen.footReview' : 'PortalFilesScreen.footEmpty', {
            studio: providerName,
          })}
        </p>
      </div>
      {upload.asking ? (
        <WhichProjectDialog
          file={upload.asking}
          projects={projectList}
          onUpload={upload.confirmProject}
          onCancel={upload.dismissAsking}
        />
      ) : null}
    </ClientPortalShell>
  );
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
