'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, IconButton, InlineAlert, LoadingRegion, SearchField, Skeleton } from '@tmanage/ui';
import {
  capabilitySetFor,
  CLIENT_ROLES,
  mayActOnMember,
  memberAuthorityTier,
} from '@tmanage/domain';
import { AppShell } from '../shell/AppShell';
import { PeopleSectionNav } from '../people/PeopleSectionNav';
import {
  ChangeRoleDialog,
  fill,
  firstNameOf,
  initialsOf,
  useCustomRoles,
  useRoleChipLabel,
} from '../people/ChangeRoleDialog';
import type { ChangeRoleTarget } from '../people/ChangeRoleDialog';
import { InviteMemberDialog } from '../people/InviteMemberDialog';
import { MemberPasswordResetDialog } from '../people/MemberPasswordResetDialog';
import {
  ChangeInvitationRoleDialog,
  InvitationLinkDialog,
  PendingInvitationsSection,
  RevokeInvitationDialog,
} from '../people/PendingInvitations';
import type { PendingInvitation } from '../people/PendingInvitations';
import { browserApiClient } from '../../lib/api/browser-client';
import type { PersonSummary } from '../../lib/api/people';
import { usePeopleDirectory } from '../people/MembershipSelect';
import { fetchPendingInvitations, reissueInvitation } from '../../lib/api/admin-invitations';
import type { IssuedInvitation } from '../../lib/api/invitations';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { changeAiEmployeeStatus, type AiEmployeeView } from '../../lib/api/ai-employees';
import { useOrganizationName, useOrganizationRole } from '../../lib/use-organization-names';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { pluralPhrase } from '../../lib/i18n/plural';
import { withNumerals } from '../../lib/i18n/display-format';
import { describePeopleError } from './peopleShared';
import { ViewSwitcher } from '../views/ViewSwitcher';
import { useViewPreference } from '../views/use-view-preference';
import { invitationRoleName } from './AdminInvitationsView';
import { PersonAvatar } from '../people/PersonAvatar';
import { SearchIcon } from '../work/work-icons';
import { AiAvatar, AiBadge, aiInitialsOf } from '../ai-employees/AiBadge';
import { AiStatus } from '../ai-employees/AiStatus';
import { AddChooserDialog } from '../ai-employees/AddChooserDialog';
import { HireWizard, type HireWizardStart } from '../ai-employees/HireWizard';
import { PeopleRoster, type RosterActions } from '../ai-employees/PeopleRoster';
import { AiTabs } from '../ai-employees/AiTabs';
import {
  aiRowStatus,
  grantableCustomRoles,
  hireBlocked,
  matchesQuery,
  mergeDirectory,
  personJobTitle,
  rowsForTab,
  type DirectoryRow,
  type DirectoryTab,
} from '../ai-employees/ai-employee-model';
import {
  useAiEmployeeList,
  useAiRefresh,
  useExcludedProjects,
  useOrganizationMe,
  useProjectOptions,
} from '../ai-employees/use-ai-employees';
import '../../styles/screens/people.css';
import '../people/teams/teams.css';
import '../ai-employees/ai-employees.css';

export interface PeopleDirectoryScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Stories: open on this tab. */
  initialTab?: DirectoryTab;
  /** Stories: open with the add chooser, or the hire wizard at a drawn state. */
  initialDialog?: 'add' | 'hire';
  initialWizard?: HireWizardStart;
  /** Stories: the connector address the design shows. */
  addressOverride?: string;
}

/** Owner and org admin assign roles and invite (`12-PERMISSION-MATRIX` §2 "Assign roles"). */
const ROLE_ASSIGNERS = new Set(['owner', 'org_admin']);

/** R38 G5-views: the members as a table or as cards. */
const PEOPLE_LAYOUTS = ['list', 'grid'] as const;
type PeopleLayout = (typeof PEOPLE_LAYOUTS)[number];

type Dialog =
  | { readonly kind: 'role'; readonly target: ChangeRoleTarget }
  | { readonly kind: 'reset'; readonly person: PersonSummary }
  | { readonly kind: 'add' }
  | { readonly kind: 'hire' }
  | { readonly kind: 'invite'; readonly email?: string }
  | { readonly kind: 'invite-role'; readonly invitation: PendingInvitation }
  | { readonly kind: 'invite-revoke'; readonly invitation: PendingInvitation }
  | { readonly kind: 'invite-link'; readonly issued: IssuedInvitation };

/** "Online now"-style wording for LAST ACTIVE, in the active locale; "—" when unknown. */
function useLastActive(): (iso: string | null | undefined) => string {
  const tr = useTOr();
  const locale = useActiveLocale();
  return (iso) => {
    const at = iso ? Date.parse(iso) : Number.NaN;
    if (Number.isNaN(at)) return tr('PeopleDirectoryScreen.lastActiveUnknown', '—');
    const minutes = Math.round((at - Date.now()) / 60_000);
    const format = new Intl.RelativeTimeFormat(withNumerals(locale), { numeric: 'auto' });
    if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return format.format(hours, 'hour');
    const days = Math.round(hours / 24);
    if (Math.abs(days) < 7) return format.format(days, 'day');
    return format.format(Math.round(days / 7), 'week');
  };
}

/**
 * **People** (plan 60 slice 60-07, S1; Figma `949:1022`, phone `949:1853`). People's own menu on
 * the left, "People · 5 people · 3 AI employees", Search people and Add in the header; the tabs
 * Everyone / People / AI employees with their counts; and everyone in one table: Name, Job title,
 * Role, Sponsor, Status and a ⋯ menu.
 *
 * Every feature of the earlier Members and roles page stays: the role chip and Change role, Send
 * password reset link, View profile, Remove (offboarding), pending invitations with all their
 * actions, Invite (now through Add), the list / grid switch (grid cards keep each person's
 * address, projects and last activity) and the Capacity link (both at the end of the tab row).
 *
 * AI employees come from `GET …/ai-employees`. A 404 (the server switch is off) or a 403 means
 * this workspace shows none: no AI tab and no AI count, never an error. While the workspace has
 * them switched off (`enabled: false`) a banner says so (S1d).
 */
export function PeopleDirectoryScreen({
  organizationSlug,
  organizationName,
  client,
  initialTab = 'everyone',
  initialDialog,
  initialWizard,
  addressOverride,
}: PeopleDirectoryScreenProps) {
  const api = client ?? browserApiClient();
  const tr = useTOr();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const workspace = useOrganizationName(organizationSlug, organizationName) || organizationName;
  const { role: myRole, capabilities: myCapabilities } = useOrganizationRole(organizationSlug);
  const canAssign = myRole !== undefined && ROLE_ASSIGNERS.has(myRole);
  const [dialog, setDialog] = useState<Dialog | null>(
    initialDialog === undefined ? null : { kind: initialDialog },
  );
  const [announcement, setAnnouncement] = useState('');
  const [tab, setTab] = useState<DirectoryTab>(initialTab);
  const [query, setQuery] = useState('');
  const [phoneSearch, setPhoneSearch] = useState(false);
  const [layout, setLayout] = useViewPreference<PeopleLayout>(
    `people:${organizationSlug}`,
    PEOPLE_LAYOUTS,
    'list',
  );
  const customRoles = useCustomRoles(api, organizationSlug, myRole !== undefined);
  const chip = useRoleChipLabel(customRoles.data);
  const customRoleFallback = tr('PeopleDirectoryScreen.role.custom', 'Custom role');
  const invitationChip = (role: string): string => {
    const label = chip(role);
    if (label !== customRoleFallback) return label;
    const named = invitationRoleName(role, customRoles.data, customRoleFallback);
    return (CLIENT_ROLES as readonly string[]).includes(role)
      ? tr(`PermissionEditor.role.${role}`, named)
      : named;
  };
  const myCustomRole = customRoles.data?.find((entry) => entry.id === myRole);
  const canManage =
    canAssign ||
    (myCustomRole?.capabilities.includes('org.manage') ?? false) ||
    (myCapabilities?.includes('org.manage') ?? false);

  const myRights = useMemo(
    () => new Set<string>([...capabilitySetFor(myRole ?? ''), ...(myCapabilities ?? [])]),
    [myRole, myCapabilities],
  );
  const myTier = memberAuthorityTier(myRole ?? '', myRights);
  const outranks = (person: PersonSummary): boolean =>
    myRole !== undefined &&
    mayActOnMember(
      myTier,
      memberAuthorityTier(
        person.role,
        customRoles.data?.find((entry) => entry.id === person.role)?.capabilities ??
          capabilitySetFor(person.role),
      ),
    );

  const people = usePeopleDirectory(api, organizationSlug);
  const ai = useAiEmployeeList(api, organizationSlug);
  const aiList = ai.data ?? null;
  const refreshAi = useAiRefresh(organizationSlug);
  const wizardOpen = dialog?.kind === 'hire';
  const projects = useProjectOptions(api, organizationSlug, wizardOpen);
  const excluded = useExcludedProjects(api, organizationSlug, wizardOpen);
  const me = useOrganizationMe(api, organizationSlug);

  const invitations = useQuery({
    queryKey: ['admin-invitations', organizationSlug],
    queryFn: () => fetchPendingInvitations(api, organizationSlug),
    enabled: canManage,
    retry: false,
  });

  const describeError = useDescribeApiError();
  const resend = useMutation({
    mutationFn: (invitation: PendingInvitation) =>
      reissueInvitation(api, organizationSlug, invitation.id),
    onSuccess: (issued) => {
      reload();
      if (issued.delivery === 'sent') {
        setAnnouncement(
          fill(tr('PendingInvitations.resent', 'Invitation sent again to {email}.'), {
            email: issued.invitation.email,
          }),
        );
      } else {
        setDialog({ kind: 'invite-link', issued });
      }
    },
  });

  const roster: readonly PersonSummary[] = people.isSuccess ? people.data.people : [];
  const complete = people.isSuccess && people.data.nextAfter === null;
  const activeOwners = roster.filter((person) => person.role === 'owner').length;
  const pending: readonly PendingInvitation[] = Array.isArray(invitations.data?.invitations)
    ? invitations.data.invitations
    : [];

  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ['people-directory', organizationSlug] });
    void queryClient.invalidateQueries({ queryKey: ['admin-invitations', organizationSlug] });
  };

  const aiRows = aiList?.aiEmployees ?? [];
  const all = mergeDirectory(roster, aiRows, locale);
  const shownTab: DirectoryTab = aiList === null ? 'everyone' : tab;
  const shown = rowsForTab(all, shownTab).filter((row) => matchesQuery(row, query));
  const humanCount = all.filter((row) => row.kind === 'person').length;
  const count = (key: string, value: number, one: string, other: string) =>
    pluralPhrase(tr, locale, key, value, { one, other });
  const meta = people.isSuccess
    ? [
        count('AiPeople.peopleCount', humanCount, '1 person', '{count} people'),
        ...(aiList === null
          ? []
          : [count('AiPeople.aiCount', aiRows.length, '1 AI employee', '{count} AI employees')]),
      ].join(' · ')
    : undefined;

  const aiBlockedReason = (() => {
    if (aiList === null)
      return tr('AiPeople.aiUnavailable', 'AI employees are not available here.');
    if (!aiList.enabled) return tr('AiPeople.aiSwitchedOff', 'AI employees are switched off.');
    if (aiList.live >= aiList.limit) {
      return fill(
        tr('AiPeople.atLimit', '{live} of {limit} used in the beta. Retire one to hire another.'),
        {
          live: aiList.live.toLocaleString(withNumerals(locale)),
          limit: aiList.limit.toLocaleString(withNumerals(locale)),
        },
      );
    }
    if (hireBlocked(aiList)) return tr('AiPeople.mayNotHire', 'You can’t hire AI employees here.');
    return null;
  })();
  const mayAdd = canManage || (aiList !== null && aiList.canHire);
  const openAdd = () => setDialog(aiList === null ? { kind: 'invite' } : { kind: 'add' });

  const aiStep = useMutation({
    mutationFn: ({ target, step }: { target: AiEmployeeView; step: 'pause' | 'resume' }) =>
      changeAiEmployeeStatus(api, organizationSlug, target.id, step, target.version),
    onSuccess: (changed, { step }) => {
      refreshAi();
      setAnnouncement(
        fill(
          step === 'pause'
            ? tr('AiPeople.paused', '{name} is paused.')
            : tr('AiPeople.resumed', '{name} is working again.'),
          { name: changed.displayName },
        ),
      );
    },
    onError: (error) => {
      refreshAi();
      setAnnouncement(describeError(error));
    },
  });

  const actions: RosterActions = {
    mayChangeRole: (person) => canAssign && outranks(person),
    mayRemove: (person) =>
      canAssign && outranks(person) && !(person.role === 'owner' && complete && activeOwners === 1),
    mayManage: (person) => canManage && outranks(person),
    roleLabel: (role, roleName) => roleName ?? chip(role),
    onChangeRole: (person) =>
      setDialog({
        kind: 'role',
        target: {
          userId: person.userId,
          displayName: person.displayName,
          role: person.role,
          version: person.version,
        },
      }),
    onSendReset: (person) => setDialog({ kind: 'reset', person }),
    onAiStep: (target, step) => {
      if (!aiStep.isPending) aiStep.mutate({ target, step });
    },
  };

  const title = tr('RouteTitle.people', 'People');
  const add = mayAdd ? (
    <Button tone="lime" size="header" onClick={openAdd}>
      {tr('AiPeople.add', 'Add')}
    </Button>
  ) : null;
  const searchLabel = tr('AiPeople.search', 'Search people');
  const hireAllowed = aiBlockedReason === null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      header="compact"
      title={title}
      {...(meta === undefined ? {} : { titleMeta: meta })}
      contextRail={<PeopleSectionNav organizationSlug={organizationSlug} current="directory" />}
      actions={
        <>
          <SearchField
            label={searchLabel}
            placeholder={searchLabel}
            className="tm-aie-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <IconButton
            label={searchLabel}
            icon={<SearchIcon />}
            outline
            className="tm-aie-search-toggle"
            aria-expanded={phoneSearch}
            onClick={() => setPhoneSearch((open) => !open)}
          />
          {add}
        </>
      }
    >
      <div className="tm-aie-people">
        <p className="tm-visually-hidden" role="status" aria-live="polite">
          {announcement}
        </p>

        {phoneSearch ? (
          <SearchField
            label={searchLabel}
            placeholder={searchLabel}
            className="tm-aie-search-phone"
            value={query}
            // The person pressed Search: the field that opened takes the focus.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}

        {aiList !== null && !aiList.enabled ? (
          <InlineAlert tone="warning">
            {tr(
              'AiPeople.offBanner',
              'AI employees are switched off. Their agents can’t work until an owner switches them on in Settings.',
            )}
          </InlineAlert>
        ) : null}

        <div className="tm-aie-tabbar">
          {aiList !== null ? (
            <AiTabs
              label={tr('AiPeople.tabsLabel', 'Show')}
              idPrefix="tm-aie-people"
              current={shownTab}
              onChange={setTab}
              tabs={[
                {
                  id: 'everyone',
                  label: tr('AiPeople.tabEveryone', 'Everyone'),
                  count: all.length,
                },
                { id: 'people', label: tr('AiPeople.tabPeople', 'People'), count: humanCount },
                { id: 'ai', label: tr('AiPeople.tabAi', 'AI employees'), count: aiRows.length },
              ]}
            />
          ) : (
            <span />
          )}
          <div className="tm-aie-tabbar__tools">
            <ViewSwitcher
              label={tr('ViewSwitcher.peopleLabel', 'People view')}
              options={[
                { id: 'list', label: tr('ViewSwitcher.list', 'List') },
                { id: 'grid', label: tr('ViewSwitcher.grid', 'Grid') },
              ]}
              value={layout}
              onChange={setLayout}
            />
            <Link href={`/${organizationSlug}/people/capacity`} className="tm-aie-link">
              {tr('PeopleCapacityTabs.capacity', 'Capacity')}
            </Link>
          </div>
        </div>

        <div
          id="tm-aie-people-panel"
          {...(aiList !== null
            ? { role: 'tabpanel', 'aria-labelledby': `tm-aie-people-tab-${shownTab}` }
            : {})}
        >
          {people.isPending ? (
            <LoadingRegion
              label={tr('PeopleDirectoryScreen.loadingMembers', 'Loading members')}
              className="tm-stack tm-stack--tight"
            >
              <Skeleton height="var(--app-row)" />
              <Skeleton height="var(--app-row)" />
            </LoadingRegion>
          ) : null}

          {people.isError ? (
            <InlineAlert
              tone="danger"
              title={tr('PeopleDirectoryScreen.membersLoadError', 'Members could not be loaded')}
              live
            >
              {describePeopleError(people.error)}
            </InlineAlert>
          ) : null}

          {people.isSuccess && shownTab === 'ai' && aiRows.length === 0 && query === '' ? (
            <section className="tm-aie-empty" aria-label={tr('AiPeople.tabAi', 'AI employees')}>
              <AiAvatar initials="AI" size={40} />
              <h2 className="tm-aie-empty__title">
                {tr('AiPeople.emptyTitle', 'No AI employees yet')}
              </h2>
              <p className="tm-aie-empty__text">
                {tr(
                  'AiPeople.emptyBody',
                  'Hire your own AI agent. It works on the tasks you brief it on.',
                )}
              </p>
              {hireAllowed ? (
                <Button tone="lime" size="large" onClick={() => setDialog({ kind: 'hire' })}>
                  {tr('AiPeople.hireAi', 'Hire an AI employee')}
                </Button>
              ) : null}
            </section>
          ) : null}

          {people.isSuccess && !(shownTab === 'ai' && aiRows.length === 0 && query === '') ? (
            layout === 'grid' ? (
              <DirectoryGrid rows={shown} organizationSlug={organizationSlug} actions={actions} />
            ) : (
              <PeopleRoster
                rows={shown}
                organizationSlug={organizationSlug}
                organizationName={workspace}
                actions={actions}
                empty={
                  query === ''
                    ? tr('PeopleDirectoryScreen.noMembers', 'No members yet.')
                    : tr('AiPeople.noMatch', 'Nobody matches this search.')
                }
              />
            )
          ) : null}
        </div>

        {canManage && resend.isError ? (
          <InlineAlert
            tone="danger"
            title={tr('PendingInvitations.resendError', 'The invitation was not sent again')}
            live
          >
            {describeError(resend.error)}
          </InlineAlert>
        ) : null}

        {/* QA-FIX-P L8: the Control Center's "Invitations" entry lands here (`/people#invitations`). */}
        {canManage && people.isSuccess && shownTab !== 'ai' ? (
          <div id="invitations" tabIndex={-1}>
            {invitations.isSuccess && pending.length === 0 ? (
              <p className="tm-aie-quiet">
                {tr('PeopleDirectoryScreen.noInvitations', 'No invitations are waiting.')}
              </p>
            ) : null}
            <PendingInvitationsSection
              api={api}
              organizationSlug={organizationSlug}
              invitations={pending}
              roleLabel={invitationChip}
              busyId={resend.isPending ? (resend.variables?.id ?? null) : null}
              onChangeRole={(invitation) => setDialog({ kind: 'invite-role', invitation })}
              onResend={(invitation) => {
                if (!resend.isPending) resend.mutate(invitation);
              }}
              onRevoke={(invitation) => setDialog({ kind: 'invite-revoke', invitation })}
              onCheckAddress={(invitation) =>
                setDialog({ kind: 'invite', email: invitation.email })
              }
            />
          </div>
        ) : null}

        {people.isSuccess && !complete ? (
          <p className="tm-aie-quiet">
            {tr(
              'PeopleDirectoryScreen.moreMembers',
              'There are more members than this list shows.',
            )}
          </p>
        ) : null}
      </div>

      {dialog?.kind === 'add' ? (
        <AddChooserDialog
          mayInvite={canManage}
          aiBlockedReason={aiBlockedReason}
          live={aiList?.live ?? 0}
          limit={aiList?.limit ?? 0}
          onChoose={(choice) => setDialog(choice === 'ai' ? { kind: 'hire' } : { kind: 'invite' })}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'hire' ? (
        <HireWizard
          api={api}
          organizationSlug={organizationSlug}
          projects={projects.data ?? []}
          projectsLoading={projects.isPending}
          closedIds={new Set((excluded.data?.projects ?? []).map((project) => project.projectId))}
          customRoles={grantableCustomRoles(customRoles.data ?? [], myRights)}
          people={roster}
          myMembershipId={me.data?.membershipId ?? null}
          roleLabel={(role) => chip(role)}
          onHired={() => refreshAi()}
          onClose={(hired) => {
            setDialog(null);
            if (hired) {
              refreshAi();
              setAnnouncement(
                fill(tr('AiPeople.hired', '{name} joined the team.'), { name: hired.displayName }),
              );
            }
          }}
          {...(initialWizard === undefined ? {} : { start: initialWizard })}
          {...(addressOverride === undefined ? {} : { addressOverride })}
        />
      ) : null}

      {dialog?.kind === 'role' ? (
        <ChangeRoleDialog
          api={api}
          organizationSlug={organizationSlug}
          organizationName={workspace}
          target={dialog.target}
          isOnlyOwner={complete && activeOwners === 1}
          onStale={reload}
          onClose={(changed) => {
            setDialog(null);
            if (changed?.changed) {
              setAnnouncement(
                fill(tr('PeopleDirectoryScreen.roleChanged', '{name} is now {role}.'), {
                  name: dialog.target.displayName,
                  role: chip(changed.role),
                }),
              );
              reload();
            }
          }}
        />
      ) : null}

      {dialog?.kind === 'reset' ? (
        <MemberPasswordResetDialog
          api={api}
          organizationSlug={organizationSlug}
          membershipId={dialog.person.membershipId}
          displayName={dialog.person.displayName}
          firstName={firstNameOf(dialog.person.displayName)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'invite-revoke' ? (
        <RevokeInvitationDialog
          api={api}
          organizationSlug={organizationSlug}
          invitation={dialog.invitation}
          roleLabel={invitationChip(dialog.invitation.role)}
          onClose={(revoked) => {
            setDialog(null);
            if (revoked) {
              setAnnouncement(
                fill(tr('PendingInvitations.revoked', 'Invitation to {email} revoked.'), {
                  email: dialog.invitation.email,
                }),
              );
              reload();
            }
          }}
        />
      ) : null}

      {dialog?.kind === 'invite-role' ? (
        <ChangeInvitationRoleDialog
          api={api}
          organizationSlug={organizationSlug}
          organizationName={workspace}
          invitation={dialog.invitation}
          roleLabel={invitationChip(dialog.invitation.role)}
          onClose={(issued) => {
            if (!issued) {
              setDialog(null);
              return;
            }
            reload();
            if (issued.delivery === 'sent') {
              setDialog(null);
              setAnnouncement(
                fill(
                  tr('PendingInvitations.roleChanged', 'New invitation sent to {email} as {role}.'),
                  { email: issued.invitation.email, role: invitationChip(issued.invitation.role) },
                ),
              );
            } else {
              setDialog({ kind: 'invite-link', issued });
            }
          }}
        />
      ) : null}

      {dialog?.kind === 'invite-link' ? (
        <InvitationLinkDialog issued={dialog.issued} onClose={() => setDialog(null)} />
      ) : null}

      {dialog?.kind === 'invite' ? (
        <InviteMemberDialog
          api={api}
          organizationSlug={organizationSlug}
          organizationName={workspace}
          initialEmail={dialog.email}
          onClose={(issued) => {
            setDialog(null);
            if (issued) {
              setAnnouncement(
                fill(tr('PeopleDirectoryScreen.inviteSent', 'Invitation sent to {email}.'), {
                  email: issued.invitation.email,
                }),
              );
              reload();
            }
          }}
        />
      ) : null}
    </AppShell>
  );
}

/** R38 G5-views: everyone as cards. A person's card keeps the address, projects and last activity. */
function DirectoryGrid({
  rows,
  organizationSlug,
  actions,
}: {
  rows: readonly DirectoryRow[];
  organizationSlug: string;
  actions: RosterActions;
}) {
  const tr = useTOr();
  const locale = useActiveLocale();
  const lastActive = useLastActive();
  if (rows.length === 0) {
    return (
      <p className="tm-aie-quiet">{tr('PeopleDirectoryScreen.noMembers', 'No members yet.')}</p>
    );
  }
  return (
    <ul
      className="tm-view-grid"
      aria-label={tr('PeopleDirectoryScreen.listLabel', 'People in this organization')}
    >
      {rows.map((row) => {
        if (row.kind === 'ai') {
          const ai = row.ai;
          return (
            <li key={row.key}>
              <article
                className="tm-view-card tm-aie-card-view"
                data-retired={ai.status === 'retired' || undefined}
              >
                <AiAvatar
                  initials={aiInitialsOf(ai.displayName)}
                  size={40}
                  className="tm-aie-dim"
                />
                <h3 className="tm-view-card__title tm-aie-who">
                  <Link href={`/${organizationSlug}/people/${encodeURIComponent(ai.membershipId)}`}>
                    <bdi>{ai.displayName}</bdi>
                  </Link>
                  <AiBadge />
                </h3>
                <p className="tm-view-card__meta">{ai.jobTitle}</p>
                <AiStatus status={aiRowStatus(ai)} />
              </article>
            </li>
          );
        }
        const person = row.person;
        const mayChange = actions.mayChangeRole(person);
        const chipLabel = actions.roleLabel(person.role, person.roleName);
        const profileHref = person.membershipId
          ? `/${organizationSlug}/people/${encodeURIComponent(person.membershipId)}`
          : null;
        const jobTitle = personJobTitle(person);
        return (
          <li key={row.key}>
            <article className="tm-view-card ppl-member-card">
              <PersonAvatar
                organizationSlug={organizationSlug}
                userId={person.userId}
                name={person.displayName}
                className="ppl-avatar"
                decorative
                fallback={
                  <span className="ppl-avatar ppl-avatar--40" aria-hidden="true">
                    {initialsOf(person.displayName)}
                  </span>
                }
              />
              <h3 className="tm-view-card__title">
                {profileHref ? (
                  <Link href={profileHref}>{person.displayName}</Link>
                ) : (
                  person.displayName
                )}
              </h3>
              {jobTitle ? <p className="tm-view-card__meta">{jobTitle}</p> : null}
              {person.email ? (
                <p className="tm-view-card__meta" dir="ltr">
                  {person.email}
                </p>
              ) : null}
              <p className="tm-view-card__meta">
                <span>
                  {pluralPhrase(tr, locale, 'PeopleDirectoryScreen.projects', person.projectCount, {
                    one: '1 project',
                    other: '{count} projects',
                  })}
                </span>
                {' · '}
                <span>{lastActive(person.lastActiveAt)}</span>
              </p>
              <div>
                {mayChange ? (
                  <button
                    type="button"
                    className="ppl-role-chip"
                    aria-label={fill(
                      tr('PeopleDirectoryScreen.roleChip', 'Role of {name}: {role}. Change role'),
                      { name: person.displayName, role: chipLabel },
                    )}
                    onClick={() => actions.onChangeRole(person)}
                  >
                    {chipLabel}
                    <span className="ppl-role-chip__caret" aria-hidden="true" />
                  </button>
                ) : (
                  <span className="ppl-role-chip ppl-role-chip--static">{chipLabel}</span>
                )}
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
