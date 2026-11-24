'use client';

import { useId } from 'react';
import { InlineAlert } from '@tmanage/ui';
import type { PersonSummary } from '../../lib/api/people';
import type { CustomRoleOption } from '../people/ChangeRoleDialog';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { pluralPhrase } from '../../lib/i18n/plural';
import { fill } from '../people/ChangeRoleDialog';
import { PeopleCombobox } from '../people/teams/PeopleCombobox';
import { CloseIcon, LockIcon } from '../work/work-icons';
import { FieldLabel, SelectBox } from './AiField';
import { offeredProjects, type ProjectOption } from './ai-employee-model';

export interface WorkDraft {
  /** `member`, `guest` or a custom role id. */
  readonly role: string;
  readonly projectIds: readonly string[];
  /** Empty = the hiring person (the API's default). */
  readonly sponsorMembershipId: string;
}

export type WorkProblem = 'projectNeeded';

export function workProblems(draft: WorkDraft): readonly WorkProblem[] {
  return draft.projectIds.length === 0 ? ['projectNeeded'] : [];
}

/**
 * S3b, step 2 "Work" (Figma `950:2224`): role, projects (chips with a remove button, from the open
 * projects minus those closed to AI; "n projects closed to AI" under them), a client alert when a
 * chosen project has a client, and the sponsor, "you" by default.
 *
 * Task types are not drawn: the field goes live with the Phase 2 catalogue (Fable verdict; plan
 * line under the Phase 1 slice table), and sample chips would promise work nobody can give.
 */
export function WizardWork({
  aiName,
  draft,
  problems,
  onChange,
  projects,
  projectsLoading,
  closedCount,
  closedIds,
  customRoles,
  people,
  myMembershipId,
  roleLabel,
}: {
  readonly aiName: string;
  readonly draft: WorkDraft;
  readonly problems: readonly WorkProblem[];
  readonly onChange: (next: WorkDraft) => void;
  readonly projects: readonly ProjectOption[];
  readonly projectsLoading: boolean;
  readonly closedCount: number;
  readonly closedIds: ReadonlySet<string>;
  readonly customRoles: readonly CustomRoleOption[];
  readonly people: readonly PersonSummary[];
  readonly myMembershipId: string | null;
  readonly roleLabel: (role: string) => string;
}) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const roleId = useId();
  const projectsId = useId();
  const projectsProblemId = useId();
  const sponsorId = useId();
  const chosen = draft.projectIds
    .map((id) => projects.find((project) => project.id === id))
    .filter((project): project is ProjectOption => project !== undefined);
  const clients = chosen.filter((project) => project.isClient);
  const projectNeeded = problems.includes('projectNeeded');
  const sponsors = people.filter((person) => person.membershipId);
  const sponsorValue = draft.sponsorMembershipId || myMembershipId || '';

  return (
    <>
      <div className="tm-team-dialog__field">
        <FieldLabel
          htmlFor={roleId}
          label={tOr('PeopleDirectoryScreen.membersColRole', 'Role')}
          info={fill(
            tOr(
              'AiWizard.roleInfo',
              'What {name} may do, like a person’s role. He never gets more rights than his sponsor.',
            ),
            { name: aiName },
          )}
        />
        <SelectBox
          id={roleId}
          value={draft.role}
          onChange={(event) => onChange({ ...draft, role: event.target.value })}
        >
          <option value="member">{roleLabel('member')}</option>
          <option value="guest">{roleLabel('guest')}</option>
          {customRoles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </SelectBox>
      </div>

      <div className="tm-team-dialog__field tm-aie-projects-field">
        <FieldLabel id={projectsId} label={tOr('AiWizard.projects', 'Projects')} />
        <PeopleCombobox
          variant="chips"
          labelledBy={projectsId}
          placeholder={tOr('AiWizard.addProjects', 'Add projects…')}
          options={(query) => {
            const needle = query.trim().toLocaleLowerCase();
            return offeredProjects(projects, closedIds, draft.projectIds)
              .filter(
                (project) => needle === '' || project.name.toLocaleLowerCase().includes(needle),
              )
              .map((project) => ({ id: project.id, label: project.name, kind: 'person' as const }));
          }}
          onPick={(option) => onChange({ ...draft, projectIds: [...draft.projectIds, option.id] })}
          loading={projectsLoading}
          loadingText={tOr('AiWizard.loading', 'Loading…')}
          emptyText={tOr('AiWizard.noProjects', 'No project left to add.')}
          teamTag=""
          before={chosen.map((project) => (
            <span key={project.id} className="tm-team-chip tm-aie-chip">
              {project.isClient ? <span className="tm-aie-client-dot" aria-hidden="true" /> : null}
              <bdi className="tm-team-chip__name">{project.name}</bdi>
              <button
                type="button"
                className="tm-team-chip__remove"
                aria-label={fill(tOr('AiWizard.removeProject', 'Remove {name}'), {
                  name: project.name,
                })}
                onClick={() =>
                  onChange({
                    ...draft,
                    projectIds: draft.projectIds.filter((id) => id !== project.id),
                  })
                }
              >
                <CloseIcon />
              </button>
            </span>
          ))}
        />
        {projectNeeded ? (
          <p
            id={projectsProblemId}
            className="tm-team-dialog__problem tm-aie-field-error"
            role="alert"
          >
            {tOr('AiWizard.projectNeeded', 'Choose at least one project. It is where he may work.')}
          </p>
        ) : null}
        {closedCount > 0 ? (
          <p className="tm-aie-closed-line">
            <LockIcon />
            <span>
              {pluralPhrase(tOr, locale, 'AiWizard.closedCount', closedCount, {
                one: '1 project is closed to AI',
                other: '{count} projects are closed to AI',
              })}
            </span>
          </p>
        ) : null}
      </div>

      {clients.length > 0 ? (
        <InlineAlert tone="client">
          {fill(
            clients.length === 1
              ? tOr(
                  'AiWizard.clientOne',
                  '{projects} is a client project. {name} reads only the work he is given.',
                )
              : tOr(
                  'AiWizard.clientMany',
                  '{projects} are client projects. {name} reads only the work he is given.',
                ),
            {
              projects: new Intl.ListFormat(locale, { type: 'conjunction' }).format(
                clients.map((project) => project.name),
              ),
              name: aiName,
            },
          )}
        </InlineAlert>
      ) : null}

      <div className="tm-team-dialog__field">
        <FieldLabel
          htmlFor={sponsorId}
          label={tOr('AiPeople.colSponsor', 'Sponsor')}
          info={fill(
            tOr(
              'AiWizard.sponsorInfo',
              'The person who answers for {name}. If the sponsor leaves, {name} pauses until you pick a new one.',
            ),
            { name: aiName },
          )}
        />
        <SelectBox
          id={sponsorId}
          value={sponsorValue}
          onChange={(event) => onChange({ ...draft, sponsorMembershipId: event.target.value })}
        >
          {sponsorValue === '' ? <option value="">{tOr('AiWizard.you', 'You')}</option> : null}
          {sponsors.map((person) => (
            <option key={person.membershipId} value={person.membershipId}>
              {person.membershipId === myMembershipId
                ? fill(tOr('AiWizard.youNamed', '{name} (you)'), { name: person.displayName })
                : person.displayName}
            </option>
          ))}
        </SelectBox>
      </div>
    </>
  );
}
