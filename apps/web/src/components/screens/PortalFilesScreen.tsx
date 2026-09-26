'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { BackendPending } from './BackendPending';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import { listPortalFiles, listPortalProjects, portalFileDownloadPath } from '../../lib/api/portal';
import type { PortalFile } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
 * ## The empty state
 *
 * A client with no files needs to know the tab works and nothing is waiting — the same job the
 * actions screen's empty state does. It says so plainly rather than looking broken.
 */
export function PortalFilesScreen({
  organizationSlug,
  clientName,
  providerName,
  client,
}: PortalFilesScreenProps) {
  const api = client ?? browserApiClient();

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const projectList = projects.data ?? [];

  // One query per project the client can see: files are a project's, never the tenant's, so the
  // list route names a project. `useQueries` keeps them independent — one project failing does not
  // blank the rest.
  const fileQueries = useQueries({
    queries: projectList.map((project) => ({
      queryKey: ['portal-files', organizationSlug, project.id],
      queryFn: () => listPortalFiles(api, organizationSlug, project.id),
    })),
  });

  const firstProject = projectList[0];
  const anyFilesLoading = projects.isPending || fileQueries.some((query) => query.isPending);
  const anyFilesError = fileQueries.some((query) => query.isError);
  const totalFiles = fileQueries.reduce((sum, query) => sum + (query.data?.length ?? 0), 0);

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      {...(firstProject ? { projectName: firstProject.name } : {})}
      activeNavigationId="files"
      title="Files"
      description={`Files ${providerName} has shared with you.`}
    >
      {projects.isError ? (
        <InlineAlert tone="danger" title="Could not load your files" live>
          {describe(projects.error)}
        </InlineAlert>
      ) : null}

      {anyFilesError && !projects.isError ? (
        <InlineAlert tone="danger" title="Some files could not be loaded" live>
          Part of your files list did not load. Try again shortly.
        </InlineAlert>
      ) : null}

      {anyFilesLoading && !projects.isError ? (
        <LoadingRegion label="Loading your files.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!anyFilesLoading && !projects.isError && !anyFilesError && totalFiles === 0 ? (
        <InlineAlert tone="neutral" title="No files yet">
          <p className="tm-prose">
            When {providerName} shares a file with you it will appear here, grouped by project. You
            do not have to keep checking — you will be told when something arrives.
          </p>
        </InlineAlert>
      ) : null}

      {projectList.map((project, index) => {
        const files = fileQueries[index]?.data ?? [];
        if (files.length === 0) return null;
        return (
          <section
            key={project.id}
            className="tm-stack tm-stack--tight"
            aria-label={`Files for ${project.name}`}
          >
            <h2 className="tm-heading-3">{project.name}</h2>
            <ul className="tm-stack tm-list" aria-label={`Files in ${project.name}`}>
              {files.map((file) => (
                <li key={file.id} className="tm-panel tm-row tm-row--wrap">
                  <div className="tm-stack tm-stack--tight">
                    <p className="tm-prose">
                      <strong>{file.name}</strong>
                    </p>
                    <p className="tm-prose">{describeFile(file)}</p>
                  </div>
                  <a
                    className="tm-button tm-button--outline"
                    href={`${apiBaseUrl()}${portalFileDownloadPath(organizationSlug, file.id)}`}
                    download={file.name}
                  >
                    Download
                  </a>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <BackendPending ticket="DEL-001 · NS-13">
        The files here are attachments on your requests. Published deliverables and uploading a file
        from the portal are not built yet — they are missing rather than shown empty.
      </BackendPending>
    </ClientPortalShell>
  );
}

function describeFile(file: PortalFile): string {
  const uploaded = new Date(file.uploadedAt);
  const when = Number.isNaN(uploaded.getTime())
    ? file.uploadedAt
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(uploaded);
  return `${formatBytes(file.sizeBytes)} · shared ${when}`;
}

/** A plain byte count in the largest unit that keeps it readable. */
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

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
