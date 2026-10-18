'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { INTERNAL_ROLES } from '@tmanage/domain';
import { Avatar, Button, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import { listMembers } from '../../lib/api/members';
import {
  addProjectMember,
  changeProjectMemberRole,
  listProjectMembers,
  removeProjectMember,
} from '../../lib/api/project-members';
import type { ProjectMemberSummary } from '../../lib/api/project-members';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { describeInternalRole } from '../../lib/roles';
import type { ApiClient } from '../../lib/api/client';

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
 * screen offers every internal role, and the server refuses an assignment above the caller's own
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
export function MembersAndRolesScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: MembersAndRolesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const membersKey = ['project-members', projectId];

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
  const onError = (error: unknown) => setActionError(describe(error));

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
      eyebrow="Project · Team"
      title="Members and roles"
      description="Who works on this project, and what they can do. Adding, changing a role and removing are all recorded."
      topBar={
        <ProjectTabs organizationSlug={organizationSlug} projectId={projectId} current="team" />
      }
    >
      <div className="tm-prj tm-prj--sub">
        {actionError ? (
          <InlineAlert tone="danger" title="That change was refused" live>
            {actionError}
          </InlineAlert>
        ) : null}

        <div className="tm-prj__grid tm-prj__grid--even">
          <section className="tm-card tm-prj-card" aria-labelledby="tm-member-list">
            <h2 id="tm-member-list" className="tm-prj-eyebrow">
              On this project{members.isSuccess ? ` · ${members.data.length}` : ''}
            </h2>

            {members.isPending ? (
              <LoadingRegion
                label="Loading the project's members."
                className="tm-stack tm-stack--tight"
              >
                <Skeleton height="58px" />
                <Skeleton height="58px" />
              </LoadingRegion>
            ) : null}

            {members.isError ? (
              <InlineAlert tone="danger" title="Could not load the members" live>
                {describe(members.error)}
              </InlineAlert>
            ) : null}

            {members.isSuccess ? (
              members.data.length === 0 ? (
                <InlineAlert tone="neutral">Nobody is on this project yet.</InlineAlert>
              ) : (
                <ul className="tm-prj-people">
                  {members.data.map((member) => {
                    const name = names.get(member.userId) ?? member.userId;
                    return (
                      <li key={member.projectMembershipId}>
                        <Avatar name={name} decorative />
                        <span className="tm-prj-people__who">
                          <span className="tm-prj-people__name">{name}</span>
                          <span className="tm-prj-people__role">
                            {describeInternalRole(member.role).label} · on project
                          </span>
                        </span>
                        <span className="tm-prj-people__end">
                          <Select
                            label={`Role for ${name}`}
                            name={`role-${member.projectMembershipId}`}
                            value={member.role}
                            onChange={(event) =>
                              changeRole.mutate({ member, role: event.target.value })
                            }
                          >
                            {INTERNAL_ROLES.map((role) => (
                              <option key={role} value={role}>
                                {describeInternalRole(role).label}
                              </option>
                            ))}
                          </Select>
                          <Button
                            tone="outline"
                            size="compact"
                            onClick={() => remove.mutate(member)}
                            loading={remove.isPending}
                            loadingLabel="Removing"
                          >
                            Remove
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
              Add someone to this project
            </h2>
            <form
              className="tm-prj-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (addUserId !== '') add.mutate();
              }}
            >
              <Select
                label="Person"
                name="userId"
                value={addUserId}
                onChange={(event) => setAddUserId(event.target.value)}
              >
                <option value="">Choose a member…</option>
                {candidates.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName}
                  </option>
                ))}
              </Select>
              <Select
                label="Role"
                name="role"
                value={addRole}
                onChange={(event) => setAddRole(event.target.value)}
              >
                {INTERNAL_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {describeInternalRole(role).label}
                  </option>
                ))}
              </Select>
              <div className="tm-row">
                <Button
                  type="submit"
                  tone="ink"
                  loading={add.isPending}
                  loadingLabel="Adding"
                  disabled={addUserId === ''}
                >
                  Add to project
                </Button>
              </div>
            </form>
            <p className="tm-card__meta">
              Allocations — who gives this project what share of their week — are on the{' '}
              <Link
                href={`/${organizationSlug}/projects/${encodeURIComponent(projectId)}/allocations`}
              >
                allocations page
              </Link>
              .
            </p>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}
