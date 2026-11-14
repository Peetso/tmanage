'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/docs.css';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { listProjects } from '../../lib/api/projects';
import { listProjectFiles } from '../../lib/api/file-folders';
import type { ProjectFile } from '../../lib/api/file-folders';
import { formatBytes } from '../../lib/api/uploads';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { formatInstant } from '../../lib/work-item-presentation';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useT } from '../../lib/i18n/use-t';
import { useDeleteFile } from '../viewer/DeleteFileDialog';
import { CheckedLabel } from './CheckedLabel';

export interface FilesHubScreenProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  /** Preselect a project (`?project=`); none is "All projects". */
  readonly initialProjectId?: string;
  readonly client?: ApiClient;
}

/**
 * **FIL-01 Files hub (FIX3 item 11, live check a6f66e47 F2).**
 *
 * The rail's "Files" (Figma "TManage Screens — Files and Approvals", FIL-01): every ready file of
 * the projects the person can read, newest change first, each opening in its viewer
 * (`/files/:id` — images, PDFs, video, audio, code, CSV, CAD and the other agency formats).
 * "All projects" by default, a project capsule narrows it. Internal members only; the API decides
 * (`file.download` on each project) and a project it refuses is simply not listed.
 */
export function FilesHubScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
}: FilesHubScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();
  const describeError = useDescribeApiError();
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const queryClient = useQueryClient();
  // FIX5 item 5 (B-N5): a deleted file leaves the list at once; Undo (restore) brings it back.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const refreshFiles = () =>
    void queryClient.invalidateQueries({ queryKey: ['project-files', organizationSlug] });
  const fileDelete = useDeleteFile({
    api,
    organizationSlug,
    onDeleted: (fileId) => {
      setRemoved((current) => new Set(current).add(fileId));
      refreshFiles();
    },
    onRestored: (fileId) => {
      setRemoved((current) => {
        const next = new Set(current);
        next.delete(fileId);
        return next;
      });
      refreshFiles();
    },
  });

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const available = useMemo(() => projects.data ?? [], [projects.data]);
  const scope = useMemo(
    () => (projectId === '' ? available.map((project) => project.id) : [projectId]),
    [available, projectId],
  );

  const files = useQuery({
    queryKey: ['project-files', organizationSlug, scope.join(',')],
    queryFn: async () => {
      const lists = await Promise.all(
        scope.map((id) =>
          listProjectFiles(api, organizationSlug, id).catch(() => [] as readonly ProjectFile[]),
        ),
      );
      return lists.flat().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
    enabled: scope.length > 0,
  });

  const projectName = (id: string) => available.find((project) => project.id === id)?.name ?? '';
  const rows = (files.data ?? []).filter((file) => !removed.has(file.id));
  const anyDeletable = rows.some((file) => file.canDelete);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="files"
      title={t('nav.files')}
      description={tOr(
        'FilesHub.valueLine',
        'Every file your projects have produced, newest first. Open one to view it, comment on it or download it.',
      )}
    >
      <div className="tm-dx">
        <div
          className="tm-dx-chips"
          role="group"
          aria-label={tOr('FilesHub.projectsAria', 'Show files for')}
        >
          <button
            type="button"
            className="tm-chip"
            aria-pressed={projectId === ''}
            onClick={() => setProjectId('')}
          >
            {tOr('FilesHub.allProjects', 'All projects')}
          </button>
          {available.map((project) => (
            <button
              key={project.id}
              type="button"
              className="tm-chip"
              aria-pressed={project.id === projectId}
              onClick={() => setProjectId(project.id)}
            >
              {project.name}
            </button>
          ))}
        </div>

        {projects.isError || files.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('FilesHub.loadError', 'The files did not load')}
            live
          >
            {describeError(projects.error ?? files.error)}
          </InlineAlert>
        ) : null}

        {projects.isPending || (scope.length > 0 && files.isPending) ? (
          <LoadingRegion label={tOr('FilesHub.loading', 'Loading files')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {(projects.isSuccess && scope.length === 0) || (files.isSuccess && rows.length === 0) ? (
          <div className="tm-dx-empty">
            <p className="tm-dx-empty__title">{tOr('FilesHub.emptyTitle', 'No files yet')}</p>
            <p className="tm-dx-empty__body">
              {tOr(
                'FilesHub.emptyBody',
                'Files attached to work, chat messages, docs and deliverables show here.',
              )}
            </p>
          </div>
        ) : null}

        {files.isSuccess && rows.length > 0 ? (
          <div
            className="tm-dx-table-card"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label={tOr('FilesHub.tableAria', 'Files')}
          >
            <table className="tm-dx-table">
              <thead>
                <tr>
                  <th scope="col">{tOr('FilesHub.thFile', 'File')}</th>
                  <th scope="col">{tOr('FilesHub.thProject', 'Project')}</th>
                  <th scope="col">{tOr('FilesHub.thSize', 'Size')}</th>
                  <th scope="col" className="tm-dx-table__end">
                    {tOr('FilesHub.thChanged', 'Changed')}
                  </th>
                  {anyDeletable ? (
                    <th scope="col" className="tm-dx-table__end">
                      <span className="tm-visually-hidden">
                        {tOr('FilesHub.thActions', 'Actions')}
                      </span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((file) => (
                  <tr key={file.id}>
                    <th scope="row" className="tm-dx-table__title">
                      <Link href={`/${organizationSlug}/files/${encodeURIComponent(file.id)}`}>
                        <span dir="auto">{file.name}</span>
                      </Link>
                      {file.scanStatus === 'not_scanned' ? <CheckedLabel /> : null}
                    </th>
                    <td className="tm-dx-table__quiet">{projectName(file.projectId)}</td>
                    <td className="tm-dx-table__quiet tm-dx-table__mono">
                      {file.sizeBytes === null ? '—' : formatBytes(file.sizeBytes)}
                    </td>
                    <td className="tm-dx-table__end">
                      <time className="tm-dx-table__mono" dateTime={file.updatedAt}>
                        {formatInstant(file.updatedAt)}
                      </time>
                    </td>
                    {anyDeletable ? (
                      <td className="tm-dx-table__end">
                        {file.canDelete ? (
                          <button
                            type="button"
                            className="tm-button tm-button--text tm-button--compact"
                            aria-label={t('FileDelete.actionAria').split('{name}').join(file.name)}
                            onClick={() => fileDelete.ask({ id: file.id, name: file.name })}
                          >
                            {t('FileDelete.action')}
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {fileDelete.dialog}
      </div>
    </AppShell>
  );
}
