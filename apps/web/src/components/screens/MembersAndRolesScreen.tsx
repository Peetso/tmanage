'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isProjectRole, PROJECT_ROLES } from '@tmanage/domain';
import { Avatar, Button, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import {
  ShareWithClientDialog,
  describeProjectClientError,
  useProjectClientT,
} from '../projects/ShareWithClientDialog';
import { browserApiClient } from '../../lib/api/browser-client';
import { listMembers } from '../../lib/api/members';
import {
  addProjectMember,
  changeProjectMemberRole,
  listProjectMembers,
  removeProjectMember,
} from '../../lib/api/project-members';
import type { ProjectMemberSummary } from '../../lib/api/project-members';
import { getProject } from '../../lib/api/projects';
import { listClientOrganizationOptions, listProjectShares } from '../../lib/api/project-client';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { useRoleDescription } from '../../lib/use-role-description';
import type { ApiClient } from '../../lib/api/client';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useUndo } from '../../lib/undo/use-undo';
import { undoKey } from '../../lib/undo/undo-queue';

export interface MembersAndRolesScreenProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **ADM-02 Members and roles.**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` ADM-02 — who is on a project and in what role, with add,
 * change-role and remove behind `project.member.manage`. The write boundary is the API's: this
 * screen offers the project roles only (ADM-17; organization roles such as Owner and the admin
 * roles describe the organization, not one project), and the server refuses an assignment above the caller's own
 * ceiling, a caller changing their own role, and the removal of the last owner. The screen shows
 * the refusal rather than trying to pre-empt a decision that is not the browser's to make.
 *
 * ## Names come from the directory, not from this endpoint
 *
 * A project membership stores a `user_id` and no name. Rather than duplicate `display_name` onto
 * `project_memberships`, the roster is joined against the member directory (`GET …/members`, the
 * same list every picker uses) by `userId`. The directory is also where a person to add is
 * chosen, so an id is never typed.
 *
 * ADM-03 (the capability-matrix editor) and the affected-users preview are a separate ticket;
 * this screen assigns one of the fixed internal roles, it never edits what a role can do.
 */
/**
 * The roles a member's row offers: the project roles, plus the role they already hold when it is
 * an older organization-level one, so the current value still shows and can be changed away from.
 */
function roleChoices(current: string): readonly string[] {
  return isProjectRole(current) ? PROJECT_ROLES : [current, ...PROJECT_ROLES];
}

export function MembersAndRolesScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: MembersAndRolesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const tOr = useTOr();
  const undo = useUndo();
  const describeRole = useRoleDescription();
  const tc = useProjectClientT();
  const membersKey = ['project-members', projectId];
  const sharesKey = ['project-clients', organizationSlug, projectId];
  const [sharing, setSharing] = useState(false);

  const project = useQuery({
    queryKey: ['project', organizationSlug, projectId],
    queryFn: () => getProject(api, organizationSlug, projectId),
  });

  const shares = useQuery({
    queryKey: sharesKey,
    queryFn: () => listProjectShares(api, organizationSlug, projectId),
  });

  const clientOptions = useQuery({
    queryKey: ['client-organization-options', organizationSlug],
    queryFn: () => listClientOrganizationOptions(api, organizationSlug),
  });

  const currentClientId = shares.data?.[0]?.clientOrganizationId;
  const currentClientName =
    currentClientId === undefined
      ? undefined
      : (clientOptions.data?.find((option) => option.id === currentClientId)?.name ??
        currentClientId);

  const members = useQuery({
    queryKey: membersKey,
    queryFn: () => listProjectMembers(api, organizationSlug, projectId),
  });

  const directory = useQuery({
    queryKey: ['members-directory', organizationSlug],
    queryFn: () => listMembers(api, organizationSlug),
  });

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of directory.data?.members ?? []) map.set(member.userId, member.displayName);
    return map;
  }, [directory.data]);

  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<string>('member');
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: membersKey });
  const onError = (error: unknown) => setActionError(describe(t, error));

  const add = useMutation({
    mutationFn: () =>
      addProjectMember(api, organizationSlug, projectId, { userId: addUserId, role: addRole }),
    onSuccess: () => {
      setAddUserId('');
      setActionError(undefined);
      void invalidate();
    },
    onError,
  });

  const changeRole = useMutation({
    mutationFn: (input: { member: ProjectMemberSummary; role: string }) =>
      changeProjectMemberRole(api, organizationSlug, projectId, input.member.projectMembershipId, {
        role: input.role,
        expectedRole: input.member.role,
      }),
    onSuccess: () => {
      setActionError(undefined);
      void invalidate();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (member: ProjectMemberSummary) =>
      removeProjectMember(api, organizationSlug, projectId, member.projectMembershipId),
    onSuccess: () => {
      setActionError(undefined);
      void invalidate();
    },
    onError,
  });

  // Directory people not already on the project — the candidates to add.
  const candidates = useMemo(() => {
    const present = new Set((members.data ?? []).map((member) => member.userId));
    return (directory.data?.members ?? []).filter((member) => !present.has(member.userId));
  }, [members.data, directory.data]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      eyebrow={t('MembersAndRolesScreen.eyebrow')}
      title={t('MembersAndRolesScreen.title')}
      description={t('MembersAndRolesScreen.description')}
      topBar={
        <ProjectTabs organizationSlug={organizationSlug} projectId={projectId} current="team" />
      }
    >
      <div className="tm-prj tm-prj--sub">
        {actionError ? (
          <InlineAlert tone="danger" title={t('MembersAndRolesScreen.actionErrorTitle')} live>
            {actionError}
          </InlineAlert>
        ) : null}

        <div className="tm-prj__grid tm-prj__grid--even">
          <section className="tm-card tm-prj-card" aria-labelledby="tm-member-list">
            <h2 id="tm-member-list" className="tm-prj-eyebrow">
              {t('MembersAndRolesScreen.memberListHeading')}
              {members.isSuccess ? ` · ${members.data.length}` : ''}
            </h2>

            {members.isPending ? (
              <LoadingRegion
                label={t('MembersAndRolesScreen.loadingMembersLabel')}
                className="tm-stack tm-stack--tight"
              >
                <Skeleton height="58px" />
                <Skeleton height="58px" />
              </LoadingRegion>
            ) : null}

            {members.isError ? (
              <InlineAlert tone="danger" title={t('MembersAndRolesScreen.loadErrorTitle')} live>
                {describe(t, members.error)}
              </InlineAlert>
            ) : null}

            {members.isSuccess ? (
              members.data.length === 0 ? (
                <InlineAlert tone="neutral">{t('MembersAndRolesScreen.emptyMembers')}</InlineAlert>
              ) : (
                <ul className="tm-prj-people">
                  {members.data
                    .filter(
                      (member) =>
                        !undo.isPending(undoKey('project-member', member.projectMembershipId)),
                    )
                    .map((member) => {
                      const name = names.get(member.userId) ?? member.userId;
                      return (
                        <li key={member.projectMembershipId}>
                          <Avatar name={name} decorative />
                          <span className="tm-prj-people__who">
                            <span className="tm-prj-people__name">{name}</span>
                            <span className="tm-prj-people__role">
                              {describeRole(member.role).label} ·{' '}
                              {t('MembersAndRolesScreen.onProjectSuffix')}
                            </span>
                          </span>
                          <span className="tm-prj-people__end">
                            <Select
                              label={`${t('MembersAndRolesScreen.roleForPrefix')} ${name}`}
                              name={`role-${member.projectMembershipId}`}
                              value={member.role}
                              onChange={(event) =>
                                changeRole.mutate({ member, role: event.target.value })
                              }
                            >
                              {roleChoices(member.role).map((role) => (
                                <option key={role} value={role}>
                                  {describeRole(role).label}
                                </option>
                              ))}
                            </Select>
                            <Button
                              tone="outline"
                              size="compact"
                              onClick={() =>
                                undo.schedule({
                                  key: undoKey('project-member', member.projectMembershipId),
                                  message: tOr('Undo.memberRemoved', 'Removed from the project'),
                                  commit: () => remove.mutateAsync(member),
                                })
                              }
                              loading={remove.isPending}
                              loadingLabel={t('MembersAndRolesScreen.removingLabel')}
                            >
                              {t('MembersAndRolesScreen.remove')}
                            </Button>
                          </span>
                        </li>
                      );
                    })}
                </ul>
              )
            ) : null}
          </section>

          <section className="tm-card tm-prj-card" aria-labelledby="tm-add-member">
            <h2 id="tm-add-member" className="tm-prj-eyebrow">
              {t('MembersAndRolesScreen.addHeading')}
            </h2>
            <form
              noValidate
              className="tm-prj-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (addUserId !== '') add.mutate();
              }}
            >
              <Select
                label={t('MembersAndRolesScreen.personLabel')}
                name="userId"
                value={addUserId}
                onChange={(event) => setAddUserId(event.target.value)}
              >
                <option value="">{t('MembersAndRolesScreen.memberPlaceholder')}</option>
                {candidates.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName}
                  </option>
                ))}
              </Select>
              <Select
                label={t('MembersAndRolesScreen.roleLabel')}
                name="role"
                value={addRole}
                onChange={(event) => setAddRole(event.target.value)}
              >
                {PROJECT_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {describeRole(role).label}
                  </option>
                ))}
              </Select>
              <div className="tm-row">
                <Button
                  type="submit"
                  tone="ink"
                  loading={add.isPending}
                  loadingLabel={t('MembersAndRolesScreen.addingLabel')}
                  disabled={addUserId === ''}
                >
                  {t('MembersAndRolesScreen.addSubmit')}
                </Button>
              </div>
            </form>
            <p className="tm-card__meta">
              {t('MembersAndRolesScreen.allocationsMetaBefore')}{' '}
              <Link
                href={`/${organizationSlug}/projects/${encodeURIComponent(projectId)}/allocations`}
              >
                {t('MembersAndRolesScreen.allocationsLinkText')}
              </Link>
              .
            </p>
          </section>

          <section
            className="tm-card tm-prj-card tm-prj-card--client"
            aria-labelledby="tm-client-access"
          >
            <h2 id="tm-client-access" className="tm-prj-eyebrow">
              {tc('ProjectClient.accessHeading')}
            </h2>
            {shares.isError ? (
              <InlineAlert tone="danger" title={t('MembersAndRolesScreen.loadErrorTitle')} live>
                {describeProjectClientError(shares.error, tc)}
              </InlineAlert>
            ) : null}
            {shares.isPending ? (
              <LoadingRegion label={tc('ProjectClient.accessHeading')}>
                <Skeleton height="58px" />
              </LoadingRegion>
            ) : null}
            {shares.isSuccess ? (
              <ul className="tm-prj-people">
                <li>
                  {currentClientName === undefined ? null : (
                    <Avatar name={currentClientName} audience="client" decorative />
                  )}
                  <span className="tm-prj-people__who">
                    <span className="tm-prj-people__name">
                      {currentClientName ?? tc('ProjectClient.internalProject')}
                    </span>
                    <span className="tm-prj-people__role">
                      {tc('ProjectClient.currentClientLabel')}
                    </span>
                  </span>
                </li>
              </ul>
            ) : null}
            <p className="tm-card__meta">{tc('ProjectClient.accessHint')}</p>
            <div className="tm-row">
              <Button tone="ink" onClick={() => setSharing(true)} disabled={!shares.isSuccess}>
                {tc('ProjectClient.shareButton')}
              </Button>
            </div>
          </section>
        </div>
      </div>

      {sharing ? (
        <ShareWithClientDialog
          api={api}
          organizationSlug={organizationSlug}
          projectId={projectId}
          projectName={project.data?.name ?? ''}
          {...(currentClientId === undefined
            ? {}
            : { currentClientOrganizationId: currentClientId })}
          onClose={() => setSharing(false)}
          onShared={() => {
            setSharing(false);
            void queryClient.invalidateQueries({ queryKey: sharesKey });
          }}
        />
      ) : null}
    </AppShell>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('MembersAndRolesScreen.errorNetwork');
  return t('MembersAndRolesScreen.errorGeneric');
}
