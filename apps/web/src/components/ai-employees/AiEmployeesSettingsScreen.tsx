'use client';

import { useId, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, IconButton, InfoButton, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  excludeProjectFromAi,
  includeProjectForAi,
  updateAiEmployeeSettings,
  type AiAssignPolicy,
  type AiClientWork,
  type AiEmployeeSettingsView,
  type AiHirePolicy,
  type UpdateAiEmployeeSettingsInput,
} from '../../lib/api/ai-employees';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { fill } from '../people/ChangeRoleDialog';
import { usePeopleDirectory } from '../people/MembershipSelect';
import { CloseIcon, LockIcon, PlusIcon } from '../work/work-icons';
import { ConfirmDialog } from './AiDialog';
import { FieldLabel, SelectBox } from './AiField';
import {
  aiKeys,
  isStale,
  useAiRefresh,
  useAiSettings,
  useExcludedProjects,
  useProjectOptions,
} from './use-ai-employees';
import '../people/teams/teams.css';
import './ai-employees.css';

export interface AiEmployeesSettingsScreenProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly client?: ApiClient;
  /** Stories: S8b open. */
  readonly initialConfirmOff?: boolean;
  /** Stories: the "Close a project to AI" picker open. */
  readonly initialClosing?: boolean;
}

/**
 * S8 Settings › AI employees (Figma `960:1036`): owner and admin only (`ai_employee.manage`; the
 * menu hides the entry from everyone else and the API refuses them).
 *
 * - The workspace switch, with "3 of 5 used in the beta". Switching off asks first (S8b).
 * - Who may hire, who may give work to AI.
 * - Client work: allowed or internal only; tell clients when AI helped; a second approver.
 * - Projects closed to AI: a list with remove, and "Close a project to AI…".
 *
 * Every write sends the read's `version`; a 409 says someone else changed the settings and reloads.
 */
export function AiEmployeesSettingsScreen({
  organizationSlug,
  organizationName,
  client,
  initialConfirmOff = false,
  initialClosing = false,
}: AiEmployeesSettingsScreenProps) {
  const tOr = useTOr();
  const api = client ?? browserApiClient();
  const settings = useAiSettings(api, organizationSlug);

  let body: ReactNode;
  if (settings.isPending) {
    body = (
      <LoadingRegion label={tOr('AiWizard.loading', 'Loading…')}>
        <Skeleton height="var(--app-row)" />
        <Skeleton height="var(--app-row)" />
      </LoadingRegion>
    );
  } else if (settings.isError) {
    body = (
      <InlineAlert tone="danger">
        {tOr(
          'AiEmployeeSettings.loadFailed',
          'The AI employee settings could not be loaded. Reload the page.',
        )}
      </InlineAlert>
    );
  } else if (settings.data === null) {
    body = (
      <InlineAlert tone="neutral">
        {tOr('AiEmployeeSettings.notForYou', 'Only the owner and admins manage AI employees.')}
      </InlineAlert>
    );
  } else {
    body = (
      <SettingsForm
        api={api}
        organizationSlug={organizationSlug}
        settings={settings.data}
        initialConfirmOff={initialConfirmOff}
        initialClosing={initialClosing}
      />
    );
  }

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="ai-employees"
      crumbs={[tOr('RouteTitle.settingsAiEmployees', 'AI employees')]}
      title={tOr('RouteTitle.settingsAiEmployees', 'AI employees')}
      {...(client === undefined ? {} : { client })}
    >
      {body}
    </ControlCenterShell>
  );
}

function SettingsForm({
  api,
  organizationSlug,
  settings,
  initialConfirmOff,
  initialClosing,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly settings: AiEmployeeSettingsView;
  readonly initialConfirmOff: boolean;
  readonly initialClosing: boolean;
}) {
  const tOr = useTOr();
  const fmt = useDisplayFormatters();
  const queryClient = useQueryClient();
  const refresh = useAiRefresh(organizationSlug);
  const hireId = useId();
  const assignId = useId();
  const clientGroup = useId();
  const discloseId = useId();
  const secondId = useId();
  const enabledId = useId();
  const [confirmOff, setConfirmOff] = useState(initialConfirmOff);
  const [problem, setProblem] = useState<'stale' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = !settings.canEdit || busy;

  const save = async (change: Omit<UpdateAiEmployeeSettingsInput, 'version'>) => {
    setBusy(true);
    setProblem(null);
    try {
      const next = await updateAiEmployeeSettings(api, organizationSlug, {
        ...change,
        version: settings.version,
      });
      queryClient.setQueryData(aiKeys.settings(organizationSlug), next);
      refresh();
    } catch (error) {
      setProblem(isStale(error) ? 'stale' : 'failed');
      refresh();
      throw error;
    } finally {
      setBusy(false);
    }
  };
  const quietly = (change: Omit<UpdateAiEmployeeSettingsInput, 'version'>) => {
    void save(change).catch(() => undefined);
  };

  return (
    <div className="tm-aie-settings">
      {problem === 'stale' ? (
        <InlineAlert tone="warning" live>
          {tOr(
            'AiEmployeeSettings.stale',
            'Someone else changed these settings. The page now shows their version.',
          )}
        </InlineAlert>
      ) : null}
      {problem === 'failed' ? (
        <InlineAlert tone="danger" live>
          {tOr('AiEmployees.writeFailed', 'That did not work. Try again.')}
        </InlineAlert>
      ) : null}

      <section className="tm-aie-panel tm-aie-switch-row" aria-labelledby={`${enabledId}-label`}>
        <span className="tm-aie-switch-row__text">
          <label id={`${enabledId}-label`} htmlFor={enabledId} className="tm-aie-panel__title">
            {tOr('AiEmployeeSettings.enabled', 'AI employees in this workspace')}
          </label>
          <span id={`${enabledId}-hint`} className="tm-aie-quiet">
            {fill(tOr('AiPeople.usedInBeta', '{live} of {limit} used in the beta'), {
              live: fmt.number(settings.live),
              limit: fmt.number(settings.limit),
            })}
          </span>
        </span>
        <input
          id={enabledId}
          type="checkbox"
          role="switch"
          className="tm-switch"
          checked={settings.enabled}
          disabled={locked}
          aria-describedby={`${enabledId}-hint`}
          onChange={(event) => {
            if (event.target.checked) quietly({ enabled: true });
            else setConfirmOff(true);
          }}
        />
      </section>

      <section className="tm-aie-panel" aria-labelledby={`${hireId}-group`}>
        <h2 id={`${hireId}-group`} className="tm-aie-panel__title">
          {tOr('AiEmployeeSettings.whoCan', 'Who can do what')}
        </h2>
        <div className="tm-team-dialog__field">
          <FieldLabel
            htmlFor={hireId}
            label={tOr('AiEmployeeSettings.whoMayHire', 'Who may hire')}
            info={tOr(
              'AiEmployeeSettings.whoMayHireInfo',
              'Who can add AI employees to this workspace.',
            )}
          />
          <SelectBox
            id={hireId}
            value={settings.hirePolicy}
            disabled={locked}
            onChange={(event) => quietly({ hirePolicy: event.target.value as AiHirePolicy })}
          >
            <option value="owners_and_admins">
              {tOr('AiEmployeeSettings.ownersAndAdmins', 'Owners and admins')}
            </option>
            <option value="owners">{tOr('AiEmployeeSettings.ownersOnly', 'Owners only')}</option>
          </SelectBox>
        </div>
        <div className="tm-team-dialog__field">
          <FieldLabel
            htmlFor={assignId}
            label={tOr('AiEmployeeSettings.whoMayAssign', 'Who may give work to AI')}
            info={tOr(
              'AiEmployeeSettings.whoMayAssignInfo',
              'Who can make an AI employee the doer of a task.',
            )}
          />
          <SelectBox
            id={assignId}
            value={settings.assignPolicy}
            disabled={locked}
            onChange={(event) => quietly({ assignPolicy: event.target.value as AiAssignPolicy })}
          >
            <option value="managers">
              {tOr('AiEmployeeSettings.managers', 'Managers and project managers')}
            </option>
            <option value="owners_and_admins">
              {tOr('AiEmployeeSettings.ownersAndAdmins', 'Owners and admins')}
            </option>
          </SelectBox>
        </div>
      </section>

      <section className="tm-aie-panel" aria-labelledby={`${clientGroup}-title`}>
        <h2 id={`${clientGroup}-title`} className="tm-aie-panel__title">
          {tOr('AiEmployeeSettings.clientWork', 'Client work')}
        </h2>
        <fieldset className="tm-aie-radios" disabled={locked}>
          <legend className="tm-visually-hidden">
            {tOr('AiEmployeeSettings.clientWork', 'Client work')}
          </legend>
          {(
            [
              [
                'allowed',
                tOr('AiEmployeeSettings.clientAllowed', 'AI may work on client projects'),
              ],
              ['internal_only', tOr('AiEmployeeSettings.internalOnly', 'Only internal projects')],
            ] as const
          ).map(([value, text]) => (
            <label key={value} className="tm-aie-radio">
              <input
                type="radio"
                className="tm-radio"
                name={clientGroup}
                value={value}
                checked={settings.clientWork === value}
                onChange={() => quietly({ clientWork: value as AiClientWork })}
              />
              <span>{text}</span>
            </label>
          ))}
        </fieldset>
        <hr className="tm-aie-rule" />
        <SwitchRow
          id={discloseId}
          label={tOr('AiEmployeeSettings.tellClients', 'Tell clients when AI helped')}
          info={tOr(
            'AiEmployeeSettings.tellClientsInfo',
            'Client work an AI helped with shows “Prepared with AI, reviewed by <name>”.',
          )}
          checked={settings.discloseToClients}
          disabled={locked}
          onChange={(discloseToClients) => quietly({ discloseToClients })}
        />
        <SwitchRow
          id={secondId}
          label={tOr('AiEmployeeSettings.secondApprover', 'A second person approves client work')}
          info={tOr(
            'AiEmployeeSettings.secondApproverInfo',
            'On client work, the person who sponsored the AI and gave it the task can’t also approve the result. Someone else must.',
          )}
          checked={settings.secondApprover}
          disabled={locked}
          onChange={(secondApprover) => quietly({ secondApprover })}
        />
      </section>

      <ClosedProjects
        api={api}
        organizationSlug={organizationSlug}
        initialClosing={initialClosing}
      />

      {confirmOff ? (
        <ConfirmDialog
          title={tOr('AiEmployeeSettings.offTitle', 'Switch off AI employees?')}
          lines={[
            fill(
              tOr(
                'AiEmployeeSettings.offLine1',
                'All {count} AI employees stop at once. Every call from their agents is refused.',
              ),
              { count: fmt.number(settings.live) },
            ),
            tOr(
              'AiEmployeeSettings.offLine2',
              'Nothing is deleted. Their work, files and connections stay, and you can still revoke a key.',
            ),
            tOr('AiEmployeeSettings.offLine3', 'Switch on again here at any time.'),
          ]}
          confirmLabel={tOr('AiEmployeeSettings.switchOff', 'Switch off')}
          onConfirm={async () => {
            await save({ enabled: false });
            setConfirmOff(false);
          }}
          onClose={() => setConfirmOff(false)}
        />
      ) : null}
    </div>
  );
}

function SwitchRow({
  id,
  label,
  info,
  checked,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly info: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const tOr = useTOr();
  return (
    <div className="tm-aie-switch-line">
      <span className="tm-aie-label">
        <label htmlFor={id} className="tm-aie-switch-line__label">
          {label}
        </label>
        <InfoButton
          title={label}
          label={fill(tOr('AiEmployees.aboutField', 'About {field}'), { field: label })}
        >
          {info}
        </InfoButton>
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="tm-switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}

/** Projects closed to AI: who closed each and when; open one again, or close another («اقفل»). */
function ClosedProjects({
  api,
  organizationSlug,
  initialClosing,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly initialClosing: boolean;
}) {
  const tOr = useTOr();
  const fmt = useDisplayFormatters();
  const queryClient = useQueryClient();
  const refresh = useAiRefresh(organizationSlug);
  const pickId = useId();
  const titleId = useId();
  const excluded = useExcludedProjects(api, organizationSlug);
  const [closing, setClosing] = useState(initialClosing);
  const projects = useProjectOptions(api, organizationSlug, closing);
  const people = usePeopleDirectory(api, organizationSlug);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const rows = excluded.data?.projects ?? [];
  const canEdit = excluded.data?.canEdit ?? false;
  const closedIds = new Set(rows.map((row) => row.projectId));
  const offered = (projects.data ?? []).filter((project) => !closedIds.has(project.id));
  const chosen =
    pick !== '' && offered.some((project) => project.id === pick) ? pick : (offered[0]?.id ?? '');
  const nameOf = (membershipId: string) =>
    (people.isSuccess ? people.data.people : []).find(
      (person) => person.membershipId === membershipId,
    )?.displayName ?? null;

  const write = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setFailed(false);
    try {
      const next = await run();
      // Closing answers the new list; opening again is a 204, so the list is re-read instead.
      if (next !== undefined) queryClient.setQueryData(aiKeys.excluded(organizationSlug), next);
      refresh();
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tm-aie-panel" aria-labelledby={titleId}>
      <span className="tm-aie-label">
        <h2 id={titleId} className="tm-aie-panel__title">
          {tOr('AiEmployeeSettings.closedTitle', 'Projects closed to AI')}
        </h2>
        <InfoButton
          title={tOr('AiEmployeeSettings.closedTitle', 'Projects closed to AI')}
          label={fill(tOr('AiEmployees.aboutField', 'About {field}'), {
            field: tOr('AiEmployeeSettings.closedTitle', 'Projects closed to AI'),
          })}
        >
          {tOr(
            'AiEmployeeSettings.closedInfo',
            'AI employees can’t see or work in these projects, even if someone adds them.',
          )}
        </InfoButton>
      </span>
      {failed ? (
        <p className="tm-team-dialog__problem" role="alert">
          {tOr('AiEmployees.writeFailed', 'That did not work. Try again.')}
        </p>
      ) : null}
      {rows.length === 0 && excluded.isSuccess ? (
        <p className="tm-aie-quiet">
          {tOr('AiEmployeeSettings.noneClosed', 'No project is closed to AI.')}
        </p>
      ) : null}
      <ul className="tm-aie-closed">
        {rows.map((row) => {
          const by = nameOf(row.setByMembershipId);
          const day = fmt.day(row.createdAt, { day: 'numeric', month: 'short' });
          return (
            <li key={row.projectId} className="tm-aie-closed__row">
              <span className="tm-aie-closed__icon" aria-hidden="true">
                <LockIcon />
              </span>
              <span className="tm-aie-closed__text">
                <bdi className="tm-aie-closed__name">{row.name}</bdi>
                <span className="tm-aie-quiet">
                  {by === null
                    ? fill(tOr('AiEmployeeSettings.closedOn', 'Closed {date}'), { date: day })
                    : fill(tOr('AiEmployeeSettings.closedBy', 'Closed by {name} · {date}'), {
                        name: by,
                        date: day,
                      })}
                </span>
              </span>
              {canEdit ? (
                <IconButton
                  label={fill(tOr('AiEmployeeSettings.openAgain', 'Open {name} to AI again'), {
                    name: row.name,
                  })}
                  icon={<CloseIcon />}
                  outline
                  disabled={busy}
                  onClick={() =>
                    void write(() => includeProjectForAi(api, organizationSlug, row.projectId))
                  }
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {canEdit && !closing ? (
        <button type="button" className="tm-aie-add-line" onClick={() => setClosing(true)}>
          <PlusIcon />
          <span>{tOr('AiEmployeeSettings.closeProject', 'Close a project to AI…')}</span>
        </button>
      ) : null}
      {canEdit && closing ? (
        <form
          noValidate
          className="tm-aie-about__edit"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen === '') return;
            void write(() => excludeProjectFromAi(api, organizationSlug, chosen)).then((done) => {
              if (done) {
                setClosing(false);
                setPick('');
              }
            });
          }}
        >
          <label htmlFor={pickId} className="tm-visually-hidden">
            {tOr('AiEmployeeSettings.closeWhich', 'Project to close to AI')}
          </label>
          <SelectBox id={pickId} value={chosen} onChange={(event) => setPick(event.target.value)}>
            {offered.length === 0 ? (
              <option value="">
                {projects.isPending
                  ? tOr('AiWizard.loading', 'Loading…')
                  : tOr('AiWizard.noProjects', 'No project left to add.')}
              </option>
            ) : null}
            {offered.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </SelectBox>
          <span className="tm-aie-about__actions">
            <Button type="submit" tone="lime" size="header" loading={busy} disabled={chosen === ''}>
              {tOr('AiEmployeeSettings.close', 'Close to AI')}
            </Button>
            <Button type="button" tone="text" size="header" onClick={() => setClosing(false)}>
              {tOr('AiEmployees.cancel', 'Cancel')}
            </Button>
          </span>
        </form>
      ) : null}
    </section>
  );
}
