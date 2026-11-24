'use client';

import { useId, useState, type ReactNode } from 'react';
import { Button, IconButton } from '@tmanage/ui';
import type { AiEmployeeView, UpdateAiEmployeeInput } from '../../lib/api/ai-employees';
import type { PersonSummary } from '../../lib/api/people';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { withNumerals } from '../../lib/i18n/display-format';
import { fill, initialsOf, type CustomRoleOption } from '../people/ChangeRoleDialog';
import { ChevronDownIcon, CloseIcon, FolderIcon, PencilIcon, PlusIcon } from '../work/work-icons';
import { SelectBox } from './AiField';
import {
  DEPARTMENT_ENGLISH,
  DEPARTMENT_KEYS,
  VENDOR_LABELS,
  isDepartmentKey,
  offeredProjects,
  type ProjectOption,
} from './ai-employee-model';

/** The About rows that edit in place. */
export type AboutRow =
  'jobTitle' | 'department' | 'role' | 'sponsor' | 'vendor' | 'timezone' | 'clients';

export interface OverviewProps {
  readonly ai: AiEmployeeView;
  readonly editable: boolean;
  readonly editing: AboutRow | null;
  readonly onEditing: (row: AboutRow | null) => void;
  readonly onUpdate: (input: Omit<UpdateAiEmployeeInput, 'version'>) => Promise<void>;
  readonly onSponsor: (membershipId: string) => Promise<void>;
  readonly people: readonly PersonSummary[];
  readonly customRoles: readonly CustomRoleOption[];
  readonly roleLabel: (role: string) => string;
  readonly projects: readonly ProjectOption[];
  readonly closedIds: ReadonlySet<string>;
}

/**
 * S6a Overview (Figma `956:1079`): About (job title, department, role, sponsor, runs on, time
 * zone, hours, to clients), each editable in place where the reader may edit, and Projects with add
 * and remove. Task types are not drawn until the Phase 2 catalogue exists.
 */
/** "Africa/Cairo" reads as "Cairo" (design S6a); the picker still lists the full IANA names. */
function zoneCity(zone: string): string {
  return (zone.split('/').pop() ?? zone).replaceAll('_', ' ');
}

export function AiProfileOverview(props: OverviewProps) {
  return (
    <div className="tm-aie-overview">
      <AboutCard {...props} />
      <ProjectsCard {...props} />
    </div>
  );
}

function useHours(): (ai: AiEmployeeView) => string {
  const tOr = useTOr();
  const locale = useActiveLocale();
  return (ai) => {
    const windows = ai.workingHours;
    if (windows === null || windows.length === 0) return tOr('AiProfile.anyTime', 'Any time');
    // 0 = Sunday (the API's convention); 1 Jan 2023 was a Sunday.
    const dayName = (day: number) =>
      new Intl.DateTimeFormat(withNumerals(locale), { weekday: 'short', timeZone: 'UTC' }).format(
        Date.UTC(2023, 0, 1 + day),
      );
    const first = windows[0];
    const last = windows[windows.length - 1];
    const sameTimes = windows.every((w) => w.start === first?.start && w.end === first?.end);
    // "09:00" reads "9:00" (design S6a).
    const clock = (time: string) => time.replace(/^0(\d)/, '$1');
    const range = (days: string, start: string, end: string) =>
      fill(tOr('AiProfile.hoursRange', '{days}, {start}–{end}'), {
        days,
        start: clock(start),
        end: clock(end),
      });
    if (first && last && sameTimes) {
      const days =
        windows.length === 1 ? dayName(first.day) : `${dayName(first.day)}–${dayName(last.day)}`;
      return range(days, first.start, first.end);
    }
    return windows.map((w) => range(dayName(w.day), w.start, w.end)).join(' · ');
  };
}

function AboutCard({
  ai,
  editable,
  editing,
  onEditing,
  onUpdate,
  onSponsor,
  people,
  customRoles,
  roleLabel,
}: OverviewProps) {
  const tOr = useTOr();
  const hours = useHours();
  const department = isDepartmentKey(ai.departmentKey)
    ? tOr(`AiDepartment.${ai.departmentKey}`, DEPARTMENT_ENGLISH[ai.departmentKey])
    : (ai.departmentKey ?? '—');
  const vendor =
    ai.vendorLabel === null
      ? '—'
      : ai.vendorLabel === 'Other'
        ? tOr('AiWizard.vendorOther', 'Other')
        : ai.vendorLabel;
  const toClients = ai.discloseToClients
    ? tOr('AiProfile.markedAsAi', 'Marked as AI')
    : tOr('AiProfile.notMarked', 'Not marked');
  const zones =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [ai.timezone];

  const rowProps = (row: AboutRow) => ({
    editable,
    open: editing === row,
    onOpen: () => onEditing(row),
    onCancel: () => onEditing(null),
  });

  return (
    <section className="tm-aie-panel" aria-labelledby="tm-aie-about">
      <h2 id="tm-aie-about" className="tm-aie-panel__title">
        {tOr('AiProfile.about', 'About')}
      </h2>
      <dl className="tm-aie-about">
        <TextRow
          {...rowProps('jobTitle')}
          label={tOr('AiPeople.colJobTitle', 'Job title')}
          value={ai.jobTitle}
          onSave={(jobTitle) => onUpdate({ jobTitle })}
        />
        <SelectRow
          {...rowProps('department')}
          label={tOr('AiWizard.department', 'Department')}
          shown={department}
          value={ai.departmentKey ?? ''}
          options={[
            ['', tOr('AiWizard.chooseDepartment', 'Choose a department')],
            ...DEPARTMENT_KEYS.map(
              (key) => [key, tOr(`AiDepartment.${key}`, DEPARTMENT_ENGLISH[key])] as const,
            ),
          ]}
          onSave={(value) => onUpdate({ departmentKey: value === '' ? null : value })}
        />
        <SelectRow
          {...rowProps('role')}
          label={tOr('PeopleDirectoryScreen.membersColRole', 'Role')}
          shown={roleLabel(ai.role)}
          value={ai.role}
          options={[
            ['member', roleLabel('member')],
            ['guest', roleLabel('guest')],
            ...customRoles.map((role) => [role.id, role.name] as const),
          ]}
          onSave={(role) => onUpdate({ role })}
        />
        <SelectRow
          {...rowProps('sponsor')}
          label={tOr('AiPeople.colSponsor', 'Sponsor')}
          shown={
            ai.sponsor.displayName === null ? (
              '—'
            ) : (
              <span className="tm-aie-who">
                <span className="tm-aie-face" aria-hidden="true">
                  {initialsOf(ai.sponsor.displayName)}
                </span>
                <bdi>{ai.sponsor.displayName}</bdi>
              </span>
            )
          }
          value={ai.sponsor.membershipId}
          options={people
            .filter((person) => person.membershipId)
            .map((person) => [person.membershipId, person.displayName] as const)}
          onSave={onSponsor}
        />
        <SelectRow
          {...rowProps('vendor')}
          label={tOr('AiProfile.runsOn', 'Runs on')}
          shown={vendor}
          value={ai.vendorLabel ?? ''}
          options={[
            ['', tOr('AiWizard.notSaid', 'Not said')],
            ...VENDOR_LABELS.map(
              (label) =>
                [label, label === 'Other' ? tOr('AiWizard.vendorOther', 'Other') : label] as const,
            ),
          ]}
          onSave={(value) => onUpdate({ vendorLabel: value === '' ? null : value })}
        />
        <SelectRow
          {...rowProps('timezone')}
          label={tOr('AiProfile.timeZone', 'Time zone')}
          shown={zoneCity(ai.timezone)}
          value={ai.timezone}
          options={zones.map((zone) => [zone, zone] as const)}
          onSave={(timezone) => onUpdate({ timezone })}
        />
        <div className="tm-aie-about__row">
          <dt>{tOr('AiProfile.hours', 'Hours')}</dt>
          <dd>{hours(ai)}</dd>
        </div>
        <SelectRow
          {...rowProps('clients')}
          label={tOr('AiProfile.toClients', 'To clients')}
          shown={toClients}
          value={ai.discloseToClients ? 'yes' : 'no'}
          options={[
            ['yes', tOr('AiProfile.markedAsAi', 'Marked as AI')],
            ['no', tOr('AiProfile.notMarked', 'Not marked')],
          ]}
          onSave={(value) => onUpdate({ discloseToClients: value === 'yes' })}
        />
      </dl>
    </section>
  );
}

interface RowShared {
  readonly label: string;
  readonly editable: boolean;
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly onCancel: () => void;
}

function useSave(onCancel: () => void) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = async (write: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    try {
      await write();
      onCancel();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return { busy, failed, run };
}

function EditActions({
  busy,
  failed,
  onCancel,
}: {
  busy: boolean;
  failed: boolean;
  onCancel: () => void;
}) {
  const tOr = useTOr();
  return (
    <span className="tm-aie-about__actions">
      <Button type="submit" tone="lime" size="header" loading={busy}>
        {tOr('AiProfile.save', 'Save')}
      </Button>
      <Button type="button" tone="text" size="header" onClick={onCancel}>
        {tOr('AiEmployees.cancel', 'Cancel')}
      </Button>
      {failed ? (
        <span className="tm-team-dialog__problem" role="alert">
          {tOr('AiEmployees.writeFailed', 'That did not work. Try again.')}
        </span>
      ) : null}
    </span>
  );
}

function TextRow({
  label,
  value,
  editable,
  open,
  onOpen,
  onCancel,
  onSave,
}: RowShared & { readonly value: string; readonly onSave: (value: string) => Promise<void> }) {
  const tOr = useTOr();
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [blank, setBlank] = useState(false);
  const problemId = useId();
  const save = useSave(onCancel);
  return (
    <div className="tm-aie-about__row">
      <dt>{open ? <label htmlFor={id}>{label}</label> : label}</dt>
      <dd>
        {open ? (
          <form
            noValidate
            className="tm-aie-about__edit"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() === '') {
                setBlank(true);
                return;
              }
              void save.run(() => onSave(draft.trim()));
            }}
          >
            <input
              id={id}
              className="tm-aie-input"
              value={draft}
              maxLength={120}
              dir="auto"
              // The person asked to edit this row: the box takes the focus (APG, in-place edit).
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              aria-invalid={blank || undefined}
              {...(blank ? { 'aria-describedby': problemId } : {})}
              onChange={(event) => {
                setBlank(false);
                setDraft(event.target.value);
              }}
            />
            <EditActions busy={save.busy} failed={save.failed} onCancel={onCancel} />
            {blank ? (
              <span id={problemId} className="tm-team-dialog__problem" role="alert">
                {fill(tOr('AiProfile.fieldNeeded', '{field} cannot be empty.'), { field: label })}
              </span>
            ) : null}
          </form>
        ) : (
          <span className="tm-aie-about__value">{value}</span>
        )}
        {editable && !open ? (
          <IconButton
            label={fill(tOr('AiProfile.edit', 'Edit {field}'), { field: label })}
            icon={<PencilIcon />}
            outline
            className="tm-aie-about__button"
            onClick={() => {
              setDraft(value);
              onOpen();
            }}
          />
        ) : null}
      </dd>
    </div>
  );
}

function SelectRow({
  label,
  shown,
  value,
  options,
  editable,
  open,
  onOpen,
  onCancel,
  onSave,
}: RowShared & {
  readonly shown: ReactNode;
  readonly value: string;
  readonly options: readonly (readonly [string, string])[];
  readonly onSave: (value: string) => Promise<void>;
}) {
  const tOr = useTOr();
  const id = useId();
  const [draft, setDraft] = useState(value);
  const save = useSave(onCancel);
  return (
    <div className="tm-aie-about__row">
      <dt>{open ? <label htmlFor={id}>{label}</label> : label}</dt>
      <dd>
        {open ? (
          <form
            noValidate
            className="tm-aie-about__edit"
            onSubmit={(event) => {
              event.preventDefault();
              void save.run(() => onSave(draft));
            }}
          >
            <SelectBox
              id={id}
              value={draft}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
            >
              {options.map(([key, text]) => (
                <option key={key} value={key}>
                  {text}
                </option>
              ))}
            </SelectBox>
            <EditActions busy={save.busy} failed={save.failed} onCancel={onCancel} />
          </form>
        ) : (
          <span className="tm-aie-about__value">{shown}</span>
        )}
        {editable && !open ? (
          <IconButton
            label={fill(tOr('AiProfile.change', 'Change {field}'), { field: label })}
            icon={<ChevronDownIcon />}
            outline
            className="tm-aie-about__button"
            onClick={() => {
              setDraft(value);
              onOpen();
            }}
          />
        ) : null}
      </dd>
    </div>
  );
}

/** Projects (S6a): his boundary. Add from the open projects not closed to AI; remove (one stays). */
function ProjectsCard({ ai, editable, onUpdate, projects, closedIds }: OverviewProps) {
  const tOr = useTOr();
  const addId = useId();
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const save = useSave(() => setAdding(false));
  const ids = ai.projects.map((project) => project.id);
  const offered = offeredProjects(projects, closedIds, ids);
  return (
    <section className="tm-aie-panel" aria-labelledby="tm-aie-projects">
      <div className="tm-aie-panel__head">
        <h2 id="tm-aie-projects" className="tm-aie-panel__title">
          {tOr('AiWizard.projects', 'Projects')}
        </h2>
        {editable ? (
          <IconButton
            label={tOr('AiProfile.addProject', 'Add a project')}
            icon={<PlusIcon />}
            outline
            aria-expanded={adding}
            onClick={() => {
              setPick(offered[0]?.id ?? '');
              setAdding((open) => !open);
            }}
          />
        ) : null}
      </div>
      {adding ? (
        <form
          noValidate
          className="tm-aie-about__edit"
          onSubmit={(event) => {
            event.preventDefault();
            if (pick !== '') void save.run(() => onUpdate({ projectIds: [...ids, pick] }));
          }}
        >
          <label htmlFor={addId} className="tm-visually-hidden">
            {tOr('AiProfile.addProject', 'Add a project')}
          </label>
          <SelectBox id={addId} value={pick} onChange={(event) => setPick(event.target.value)}>
            {offered.length === 0 ? (
              <option value="">{tOr('AiWizard.noProjects', 'No project left to add.')}</option>
            ) : null}
            {offered.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </SelectBox>
          <EditActions busy={save.busy} failed={save.failed} onCancel={() => setAdding(false)} />
        </form>
      ) : null}
      <ul className="tm-aie-projects">
        {ai.projects.map((project) => (
          <li key={project.id} className="tm-aie-projects__row">
            <span className="tm-aie-projects__lead" aria-hidden="true">
              {project.isClient ? <span className="tm-aie-client-dot" /> : <FolderIcon />}
            </span>
            <bdi className="tm-aie-projects__name">{project.name}</bdi>
            {project.isClient ? (
              <span className="tm-visually-hidden">
                {tOr('AiProfile.clientProject', 'Client project')}
              </span>
            ) : null}
            {editable && ai.projects.length > 1 ? (
              <IconButton
                label={fill(tOr('AiWizard.removeProject', 'Remove {name}'), { name: project.name })}
                icon={<CloseIcon />}
                outline
                onClick={() =>
                  void save.run(() =>
                    onUpdate({ projectIds: ids.filter((id) => id !== project.id) }),
                  )
                }
              />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
