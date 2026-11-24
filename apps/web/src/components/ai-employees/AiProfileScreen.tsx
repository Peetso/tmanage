'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import {
  changeAiEmployeeSponsor,
  changeAiEmployeeStatus,
  updateAiEmployee,
  type AiEmployeeView,
  type UpdateAiEmployeeInput,
} from '../../lib/api/ai-employees';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { AppShell } from '../shell/AppShell';
import { PeopleSectionNav } from '../people/PeopleSectionNav';
import { fill, useCustomRoles, useRoleChipLabel } from '../people/ChangeRoleDialog';
import { usePeopleDirectory } from '../people/MembershipSelect';
import { useOrganizationName, useOrganizationRole } from '../../lib/use-organization-names';
import { AiAvatar, AiBadge, aiInitialsOf } from './AiBadge';
import { AiStatus } from './AiStatus';
import { ConfirmDialog } from './AiDialog';
import { RowMenu, type RowMenuItem } from './RowMenu';
import { AiTabs } from './AiTabs';
import { AiProfileOverview, type AboutRow } from './AiProfileOverview';
import { AiProfileConnections, type ConnectionDialog } from './AiProfileConnections';
import { BinIcon, PauseIcon, TurnIcon } from './ai-icons';
import { PencilIcon } from '../work/work-icons';
import {
  DEPARTMENT_ENGLISH,
  aiRowStatus,
  grantableCustomRoles,
  isDepartmentKey,
} from './ai-employee-model';
import { useAiRefresh, useExcludedProjects, useProjectOptions } from './use-ai-employees';
import { capabilitySetFor } from '@tmanage/domain';
import '../../styles/screens/people.css';
import '../people/teams/teams.css';
import './ai-employees.css';

export type ProfileTab = 'overview' | 'connections';

export interface AiProfileScreenProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly ai: AiEmployeeView;
  readonly client: ApiClient;
  /** Stories and tests: where the screen opens. */
  readonly initialTab?: ProfileTab;
  readonly initialMenuOpen?: boolean;
  readonly initialRetire?: boolean;
  readonly initialEditing?: AboutRow | null;
  readonly initialConnectionDialog?: ConnectionDialog | null;
  readonly now?: number;
  readonly addressOverride?: string;
}

/**
 * S6 AI employee profile (Figma `956:1079` Overview, `956:1350` Connections): the header (AI
 * avatar, name, badge, status, "job · department"), "People › Mat" with Pause/Resume and the ⋯
 * menu (Edit details, Change sponsor, Pause or Resume, Retire in the danger colour; S6e0), and the
 * two tabs. S6c: a paused AI employee says so above the tabs; paused because the sponsor left, the
 * alert offers to pick a new sponsor. S6e asks before a retire.
 *
 * Every right is the server's (`canEdit`, `canPause`, `canResume`, `canRetire`); a write sends the
 * view's `version`, and a 409 refreshes the view so the next try uses the current one.
 */
export function AiProfileScreen({
  organizationSlug,
  organizationName,
  ai,
  client: api,
  initialTab = 'overview',
  initialMenuOpen = false,
  initialRetire = false,
  initialEditing = null,
  initialConnectionDialog = null,
  now,
  addressOverride,
}: AiProfileScreenProps) {
  const tOr = useTOr();
  const fmt = useDisplayFormatters();
  const refresh = useAiRefresh(organizationSlug);
  const workspace = useOrganizationName(organizationSlug, organizationName) || organizationName;
  const { role: myRole, capabilities: myCapabilities } = useOrganizationRole(organizationSlug);
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  const [editing, setEditing] = useState<AboutRow | null>(initialEditing);
  const [retire, setRetire] = useState(initialRetire);
  const [connectionDialog, setConnectionDialog] = useState<ConnectionDialog | null>(
    initialConnectionDialog,
  );
  const [stepFailed, setStepFailed] = useState(false);

  const editable = ai.canEdit && ai.status !== 'retired';
  const people = usePeopleDirectory(api, organizationSlug);
  const customRoles = useCustomRoles(api, organizationSlug, editable);
  const chip = useRoleChipLabel(customRoles.data);
  const projects = useProjectOptions(api, organizationSlug, editable);
  const excluded = useExcludedProjects(api, organizationSlug, editable);
  const myRights = new Set<string>([...capabilitySetFor(myRole ?? ''), ...(myCapabilities ?? [])]);

  const name = ai.displayName;
  const status = aiRowStatus(ai);
  const department = isDepartmentKey(ai.departmentKey)
    ? tOr(`AiDepartment.${ai.departmentKey}`, DEPARTMENT_ENGLISH[ai.departmentKey])
    : null;
  const peopleHref = `/${organizationSlug}/people`;

  const update = async (input: Omit<UpdateAiEmployeeInput, 'version'>) => {
    try {
      await updateAiEmployee(api, organizationSlug, ai.id, { ...input, version: ai.version });
    } finally {
      refresh();
    }
  };
  const sponsor = async (membershipId: string) => {
    try {
      await changeAiEmployeeSponsor(api, organizationSlug, ai.id, ai.version, membershipId);
    } finally {
      refresh();
    }
  };
  const step = async (next: 'pause' | 'resume' | 'retire') => {
    setStepFailed(false);
    try {
      await changeAiEmployeeStatus(api, organizationSlug, ai.id, next, ai.version);
    } catch (error) {
      // The retire confirm says a failure in place; Pause and Resume say it above the tabs.
      if (next !== 'retire') setStepFailed(true);
      throw error;
    } finally {
      refresh();
    }
  };
  const editRow = (row: AboutRow) => {
    setTab('overview');
    setEditing(row);
  };

  const menu: RowMenuItem[] = [];
  if (editable) {
    menu.push({
      key: 'edit',
      label: tOr('AiProfile.editDetails', 'Edit details'),
      icon: <PencilIcon />,
      onSelect: () => editRow('jobTitle'),
    });
    menu.push({
      key: 'sponsor',
      label: tOr('AiProfile.changeSponsor', 'Change sponsor'),
      icon: <TurnIcon />,
      onSelect: () => editRow('sponsor'),
    });
  }
  if (ai.canPause && ai.status === 'active') {
    menu.push({
      key: 'pause',
      label: fill(tOr('AiProfile.pauseNamed', 'Pause {name}'), { name }),
      icon: <PauseIcon />,
      onSelect: () => void step('pause').catch(() => undefined),
    });
  }
  if (ai.canResume && ai.status === 'paused') {
    menu.push({
      key: 'resume',
      label: fill(tOr('AiProfile.resumeNamed', 'Resume {name}'), { name }),
      icon: <TurnIcon />,
      onSelect: () => void step('resume').catch(() => undefined),
    });
  }
  if (ai.canRetire && ai.status !== 'retired') {
    menu.push({
      key: 'retire',
      label: fill(tOr('AiProfile.retireNamed', 'Retire {name}'), { name }),
      icon: <BinIcon />,
      danger: true,
      onSelect: () => setRetire(true),
    });
  }

  const headerAction =
    ai.status === 'active' && ai.canPause ? (
      <Button
        type="button"
        tone="outline"
        size="header"
        onClick={() => void step('pause').catch(() => undefined)}
      >
        {tOr('AiProfile.pause', 'Pause')}
      </Button>
    ) : ai.status === 'paused' && ai.canResume && ai.pausedReason !== 'sponsor_left' ? (
      <Button
        type="button"
        tone="lime"
        size="header"
        onClick={() => void step('resume').catch(() => undefined)}
      >
        {tOr('AiProfile.resume', 'Resume')}
      </Button>
    ) : null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={workspace}
      activeNavigationId="people"
      header="compact"
      contextRail={<PeopleSectionNav organizationSlug={organizationSlug} current="directory" />}
      crumbs={
        <ol className="tm-aie-crumbs">
          <li>
            <Link href={peopleHref}>{tOr('PersonProfileScreen.people', 'People')}</Link>
          </li>
          <li aria-current="page">
            <bdi>{name}</bdi>
          </li>
        </ol>
      }
      back={{ href: peopleHref, label: tOr('PersonProfileScreen.people', 'People') }}
      crumbActions={
        <span className="tm-aie-head-actions">
          {headerAction}
          <RowMenu
            label={fill(tOr('AiProfile.moreFor', 'More for {name}'), { name })}
            items={menu}
            defaultOpen={initialMenuOpen}
            className="tm-aie-head-menu"
          />
        </span>
      }
      title={name}
      titleContent={
        <span className="tm-aie-title">
          <AiAvatar initials={aiInitialsOf(name)} size={40} />
          <bdi className="tm-aie-title__name">{name}</bdi>
        </span>
      }
      titleMeta={
        <span className="tm-aie-title__meta">
          <AiBadge />
          <AiStatus status={status} />
        </span>
      }
      description={
        <span className="tm-aie-title__job">
          {department === null ? ai.jobTitle : `${ai.jobTitle} · ${department}`}
        </span>
      }
    >
      <div className="tm-aie-profile">
        {ai.status === 'paused' ? (
          <InlineAlert tone="warning">
            {ai.pausedReason === 'sponsor_left' ? (
              <span className="tm-aie-alert-row">
                <span>
                  {fill(
                    tOr(
                      'AiProfile.pausedSponsorLeft',
                      '{name} is paused because his sponsor left. Pick a new sponsor to resume him.',
                    ),
                    { name },
                  )}
                </span>
                {editable ? (
                  <Button
                    type="button"
                    tone="outline"
                    size="header"
                    onClick={() => editRow('sponsor')}
                  >
                    {tOr('AiProfile.pickSponsor', 'Pick a sponsor')}
                  </Button>
                ) : null}
              </span>
            ) : (
              fill(
                tOr(
                  'AiProfile.paused',
                  '{name} is paused. He gets no new work until you resume him.',
                ),
                { name },
              )
            )}
          </InlineAlert>
        ) : null}
        {ai.status === 'retired' && ai.retiredAt !== null ? (
          <InlineAlert tone="neutral">
            {fill(
              tOr(
                'AiProfile.retiredOn',
                '{name} was retired on {date}. His work and history stay.',
              ),
              {
                name,
                date: fmt.day(ai.retiredAt, { day: 'numeric', month: 'long', year: 'numeric' }),
              },
            )}
          </InlineAlert>
        ) : null}
        {stepFailed ? (
          <InlineAlert tone="danger" live>
            {tOr('AiEmployees.writeFailed', 'That did not work. Try again.')}
          </InlineAlert>
        ) : null}

        <AiTabs<ProfileTab>
          label={fill(tOr('AiProfile.tabsLabel', 'About {name}'), { name })}
          idPrefix="tm-aie-profile"
          current={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: tOr('AiProfile.overview', 'Overview') },
            {
              id: 'connections',
              label: tOr('AiProfile.connections', 'Connections'),
              count: ai.connection.live,
            },
          ]}
        />
        <div
          id="tm-aie-profile-panel"
          className="tm-aie-profile-panel"
          role="tabpanel"
          aria-labelledby={`tm-aie-profile-tab-${tab}`}
        >
          {tab === 'overview' ? (
            <AiProfileOverview
              ai={ai}
              editable={editable}
              editing={editing}
              onEditing={setEditing}
              onUpdate={update}
              onSponsor={sponsor}
              people={people.isSuccess ? people.data.people : []}
              customRoles={grantableCustomRoles(customRoles.data ?? [], myRights)}
              roleLabel={chip}
              projects={projects.data ?? []}
              closedIds={
                new Set((excluded.data?.projects ?? []).map((project) => project.projectId))
              }
            />
          ) : (
            <AiProfileConnections
              api={api}
              organizationSlug={organizationSlug}
              ai={ai}
              dialog={connectionDialog}
              onDialog={setConnectionDialog}
              {...(now === undefined ? {} : { now })}
              {...(addressOverride === undefined ? {} : { addressOverride })}
            />
          )}
        </div>
      </div>

      {retire ? (
        <ConfirmDialog
          title={fill(tOr('AiProfile.retireTitle', 'Retire {name}?'), { name })}
          lines={[
            tOr('AiProfile.retireLine1', 'His connections stop at once.'),
            tOr('AiProfile.retireLine2', 'His open work goes back to its supervisors.'),
            tOr(
              'AiProfile.retireLine3',
              'His files, comments and history stay. He stays in People as Retired.',
            ),
          ]}
          confirmLabel={fill(tOr('AiProfile.retireNamed', 'Retire {name}'), { name })}
          onConfirm={async () => {
            await step('retire');
            setRetire(false);
          }}
          onClose={() => setRetire(false)}
        />
      ) : null}
    </AppShell>
  );
}
