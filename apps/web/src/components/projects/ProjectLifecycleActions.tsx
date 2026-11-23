'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { PROJECT_NAME_MAX } from '@tmanage/domain';
import { Field } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  deleteProject,
  renameProject,
  setProjectArchived,
  type ProjectSummary,
} from '../../lib/api/projects';
import { useTOr } from '../../lib/i18n/use-t-or';
import { ConfirmActionButton, conflictReason, isConflict } from '../screens/ConfirmActionButton';
import { portfolioHref } from '../overview/overview-links';

export interface ProjectLifecycleActionsProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  /** The project as last read; nothing is drawn until it is known. */
  readonly project: ProjectSummary | undefined;
  /** `project.manage`: rename, archive and restore. */
  readonly mayManage: boolean;
  /** `project.delete`: delete an empty project. */
  readonly mayDelete: boolean;
}

/** Put a changed project into every cache that shows it. */
function useRememberProject(organizationSlug: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (saved: ProjectSummary) => {
      queryClient.setQueryData(['project', organizationSlug, saved.id], saved);
      void queryClient.invalidateQueries({
        queryKey: ['project-summary', organizationSlug, saved.id],
      });
      void queryClient.invalidateQueries({ queryKey: ['projects', organizationSlug] });
      void queryClient.invalidateQueries({ queryKey: ['project-portfolio', organizationSlug] });
    },
    [queryClient, organizationSlug],
  );
}

function named(template: string, name: string): string {
  return template.split('{name}').join(name);
}

/**
 * **Rename, archive, restore and delete a project** (fix lane C, 2026-11-23) — the project header's
 * lifecycle controls over `PATCH …/projects/:id`, `POST …/archive|unarchive` and `DELETE …`. Each
 * goes through one confirm step ({@link ConfirmActionButton}). Rename sends the `updatedAt` last
 * read, so a name someone else changed meanwhile is refused (and the project re-read), not
 * overwritten. Delete is for an empty project only; when the project still holds something the
 * dialog says so and offers Archive. The caller passes what the member's role allows; the API
 * decides every request.
 */
export function ProjectLifecycleActions({
  api,
  organizationSlug,
  project,
  mayManage,
  mayDelete,
}: ProjectLifecycleActionsProps) {
  if (!project) return null;
  return (
    <>
      {/* An archived project is read-only (the API answers 409): restore it first. */}
      {mayManage && project.archivedAt === null ? (
        <RenameProjectAction api={api} organizationSlug={organizationSlug} project={project} />
      ) : null}
      {mayManage ? (
        <ArchiveProjectAction api={api} organizationSlug={organizationSlug} project={project} />
      ) : null}
      {mayDelete ? (
        <DeleteProjectAction
          api={api}
          organizationSlug={organizationSlug}
          project={project}
          mayArchive={mayManage}
        />
      ) : null}
    </>
  );
}

interface ActionProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly project: ProjectSummary;
}

function RenameProjectAction({ api, organizationSlug, project }: ActionProps) {
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const remember = useRememberProject(organizationSlug);
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const tooLong = trimmed.length > PROJECT_NAME_MAX;

  return (
    <ConfirmActionButton
      tone="ink"
      triggerLabel={tOr('ProjectLifecycle.rename', 'Rename')}
      title={tOr('ProjectLifecycle.renameTitle', 'Rename project')}
      body={tOr(
        'ProjectLifecycle.renameBody',
        'The new name shows everywhere this project appears, for your team and your client.',
      )}
      confirmLabel={tOr('ProjectLifecycle.renameConfirm', 'Save name')}
      busyLabel={tOr('ProjectLifecycle.renaming', 'Saving…')}
      failedTitle={tOr('ProjectLifecycle.renameFailed', 'Name not saved')}
      confirmDisabled={trimmed === '' || tooLong || trimmed === project.name}
      onOpen={() => setName(project.name)}
      explainFailure={(failure) =>
        isConflict(failure)
          ? tOr(
              'ProjectLifecycle.renameStale',
              'Someone changed this project a moment ago. Close this, then try again.',
            )
          : null
      }
      onConfirm={async () => {
        try {
          remember(
            await renameProject(api, organizationSlug, project.id, {
              name: trimmed,
              expectedUpdatedAt: project.updatedAt,
            }),
          );
        } catch (failure) {
          // A stale `updatedAt`: read the project again so the next try sends the current one.
          if (isConflict(failure)) {
            void queryClient.invalidateQueries({
              queryKey: ['project', organizationSlug, project.id],
            });
          }
          throw failure;
        }
      }}
    >
      <Field
        label={tOr('ProjectLifecycle.nameLabel', 'Project name')}
        value={name}
        maxLength={PROJECT_NAME_MAX}
        required
        error={
          tooLong ? tOr('ProjectLifecycle.nameTooLong', 'Use 190 characters or fewer.') : undefined
        }
        onChange={(event) => setName(event.target.value)}
      />
    </ConfirmActionButton>
  );
}

function ArchiveProjectAction({ api, organizationSlug, project }: ActionProps) {
  const tOr = useTOr();
  const remember = useRememberProject(organizationSlug);
  if (project.archivedAt !== null) {
    return (
      <ConfirmActionButton
        tone="ink"
        triggerLabel={tOr('ProjectLifecycle.restore', 'Restore')}
        title={named(tOr('ProjectLifecycle.restoreTitle', 'Restore “{name}”?'), project.name)}
        body={tOr(
          'ProjectLifecycle.restoreBody',
          'It comes back into your project lists, just as it was.',
        )}
        confirmLabel={tOr('ProjectLifecycle.restoreConfirm', 'Restore project')}
        busyLabel={tOr('ProjectLifecycle.restoring', 'Restoring…')}
        failedTitle={tOr('ProjectLifecycle.restoreFailed', 'Not restored')}
        onConfirm={async () =>
          remember(await setProjectArchived(api, organizationSlug, project.id, false))
        }
      />
    );
  }
  return (
    <ConfirmActionButton
      tone="ink"
      triggerLabel={tOr('ProjectLifecycle.archive', 'Archive')}
      title={named(tOr('ProjectLifecycle.archiveTitle', 'Archive “{name}”?'), project.name)}
      body={tOr(
        'ProjectLifecycle.archiveBody',
        'It leaves your project lists. Nothing is erased, and you can restore it at any time.',
      )}
      confirmLabel={tOr('ProjectLifecycle.archiveConfirm', 'Archive project')}
      busyLabel={tOr('ProjectLifecycle.archiving', 'Archiving…')}
      failedTitle={tOr('ProjectLifecycle.archiveFailed', 'Not archived')}
      onConfirm={async () =>
        remember(await setProjectArchived(api, organizationSlug, project.id, true))
      }
    />
  );
}

function DeleteProjectAction({
  api,
  organizationSlug,
  project,
  mayArchive,
}: ActionProps & { readonly mayArchive: boolean }) {
  const tOr = useTOr();
  const router = useRouter();
  const queryClient = useQueryClient();
  const remember = useRememberProject(organizationSlug);
  const notEmpty = (failure: unknown) => conflictReason(failure) === 'project_not_empty';

  return (
    <ConfirmActionButton
      triggerLabel={tOr('ProjectLifecycle.delete', 'Delete')}
      title={named(tOr('ProjectLifecycle.deleteTitle', 'Delete “{name}”?'), project.name)}
      body={tOr(
        'ProjectLifecycle.deleteBody',
        'Only an empty project can be deleted. This cannot be undone.',
      )}
      confirmLabel={tOr('ProjectLifecycle.deleteConfirm', 'Delete project')}
      busyLabel={tOr('ProjectLifecycle.deleting', 'Deleting…')}
      failedTitle={tOr('ProjectLifecycle.deleteFailed', 'Not deleted')}
      explainFailure={(failure) =>
        notEmpty(failure)
          ? tOr(
              'ProjectLifecycle.notEmpty',
              'This project still has work, files or links. Archive it instead.',
            )
          : null
      }
      failureAction={(failure, run) =>
        notEmpty(failure) && mayArchive && project.archivedAt === null ? (
          <div className="tm-row">
            <button
              type="button"
              className="tm-button tm-button--ink tm-button--compact"
              onClick={() =>
                run(async () =>
                  remember(await setProjectArchived(api, organizationSlug, project.id, true)),
                )
              }
            >
              {tOr('ProjectLifecycle.archiveInstead', 'Archive it instead')}
            </button>
          </div>
        ) : null
      }
      onConfirm={() => deleteProject(api, organizationSlug, project.id)}
      onDone={() => {
        // Leave first: re-reading the gone project here would flash the 404 page.
        router.push(portfolioHref(organizationSlug));
        void queryClient.invalidateQueries({ queryKey: ['projects', organizationSlug] });
        void queryClient.invalidateQueries({ queryKey: ['project-portfolio', organizationSlug] });
      }}
    />
  );
}
