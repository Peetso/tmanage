'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/automations.css';
import './automation-rule.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createWorkflowCondition,
  deleteWorkflowTemplate,
  listWorkflowConditions,
  listWorkflowRuns,
  listWorkflowTemplates,
  updateWorkflowTemplate,
  type CreateWorkflowConditionInput,
  type WorkflowActionKind,
  type WorkflowConditionSummary,
  type WorkflowRunHistoryItem,
  type WorkflowTemplateSummary,
  type WorkflowTriggerKind,
} from '../../lib/api/automations';
import { listProjects } from '../../lib/api/projects';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';

export interface AutomationTemplateEditScreenProps {
  organizationSlug: string;
  organizationName: string;
  templateId: string;
  client?: ApiClient;
}

type TOr = (key: string, english: string) => string;

/** The trigger chip's wording and the clause the page title ends with, per trigger kind. */
const TRIGGERS: Readonly<
  Record<WorkflowTriggerKind, { readonly label: string; readonly clause: string }>
> = {
  work_item_created: {
    label: 'A work item is created',
    clause: 'when a work item is created',
  },
  work_item_transitioned: {
    label: 'A work item changes status',
    clause: 'when a work item changes status',
  },
  request_submitted: {
    label: 'A client sends a request',
    clause: 'when a client sends a request',
  },
  meeting_scheduled: {
    label: 'A meeting is scheduled',
    clause: 'when a meeting is scheduled',
  },
  document_published: {
    label: 'A document is published',
    clause: 'when a document is published',
  },
  work_item_due_soon: {
    label: 'A work item is due in 2 days',
    clause: 'when a work item is due in 2 days',
  },
};

const ACTIONS: Readonly<Record<WorkflowActionKind, string>> = {
  notify_owner: 'Remind the owner',
  create_work_item: 'Create a work item',
  post_message: 'Post a message',
  send_email_digest: 'Send an email digest',
};

const TRIGGER_KINDS = Object.keys(TRIGGERS) as WorkflowTriggerKind[];
const ACTION_KINDS = Object.keys(ACTIONS) as WorkflowActionKind[];

type AlsoTell = 'project_lead' | 'none';
type StatusChoice = 'any' | 'not_done' | 'done';

/** The condition fields the "Only if" chips write (x190 conditions, step 0 = the trigger). */
const PROJECT_FIELD = 'project_id';
const STATUS_FIELD = 'status';

function triggerLabel(tOr: TOr, kind: string): string {
  const entry = TRIGGERS[kind as WorkflowTriggerKind];
  return entry ? tOr(`AutomationRule.trigger.${kind}`, entry.label) : kind;
}

function actionLabel(tOr: TOr, kind: string): string {
  const english = ACTIONS[kind as WorkflowActionKind];
  return english ? tOr(`AutomationRule.action.${kind}`, english) : kind;
}

/** The page title: the rule as one sentence, e.g. "Remind the owner when a work item is created". */
export function ruleSentence(tOr: TOr, triggerKind: string, actionKind: string): string {
  const entry = TRIGGERS[triggerKind as WorkflowTriggerKind];
  const clause = entry ? tOr(`AutomationRule.clause.${triggerKind}`, entry.clause) : '';
  return [actionLabel(tOr, actionKind), clause].filter(Boolean).join(' ');
}

/**
 * The latest condition on `field` is the chip's current value. Conditions are append-only
 * (x190 has no delete), so a change appends a new condition and the newest one wins; `contains ''`
 * is the "any" value, true for every row.
 */
function latest(
  conditions: readonly WorkflowConditionSummary[],
  field: string,
): WorkflowConditionSummary | undefined {
  return conditions.filter((condition) => condition.field === field).at(-1);
}

function projectChoiceOf(conditions: readonly WorkflowConditionSummary[]): string {
  const condition = latest(conditions, PROJECT_FIELD);
  return condition?.op === 'eq' ? condition.value : '';
}

function statusChoiceOf(conditions: readonly WorkflowConditionSummary[]): StatusChoice {
  const condition = latest(conditions, STATUS_FIELD);
  if (condition?.op === 'neq' && condition.value === 'done') return 'not_done';
  if (condition?.op === 'eq' && condition.value === 'done') return 'done';
  return 'any';
}

function projectCondition(projectId: string): CreateWorkflowConditionInput {
  return projectId === ''
    ? { field: PROJECT_FIELD, op: 'contains', value: '', targetStep: 0 }
    : { field: PROJECT_FIELD, op: 'eq', value: projectId, targetStep: 0 };
}

function statusCondition(choice: StatusChoice): CreateWorkflowConditionInput {
  if (choice === 'not_done')
    return { field: STATUS_FIELD, op: 'neq', value: 'done', targetStep: 0 };
  if (choice === 'done') return { field: STATUS_FIELD, op: 'eq', value: 'done', targetStep: 0 };
  return { field: STATUS_FIELD, op: 'contains', value: '', targetStep: 0 };
}

/**
 * **Automation rule settings (A14, Figma fq11-automation-rule).**
 *
 * One rule on one page: the rule name; grey When / Only if / Then blocks of chips (trigger;
 * project and status, saved as conditions; action and who else hears it); "Skip weekends" and
 * "Rule is on" switches; when it last ran, from the run history; and Delete rule, Cancel,
 * Save rule. Gated on the server by `org.manage`; an unknown or cross-tenant id is a 404 the
 * screen renders as a not-found state. There is no `GET …/templates/:id`, so the rule is found
 * in the org-scoped list.
 */
export function AutomationTemplateEditScreen({
  organizationSlug,
  organizationName,
  templateId,
  client,
}: AutomationTemplateEditScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const [deleted, setDeleted] = useState(false);

  const templates = useQuery({
    queryKey: ['workflow-templates', organizationSlug],
    queryFn: () => listWorkflowTemplates(api, organizationSlug),
    enabled: !deleted,
  });
  const conditions = useQuery({
    queryKey: ['workflow-conditions', organizationSlug, templateId],
    queryFn: () => listWorkflowConditions(api, organizationSlug, templateId),
    enabled: !deleted,
  });

  const template = (templates.data ?? []).find((t) => t.id === templateId);
  const backHref = `/${organizationSlug}/automations`;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={tOr('AutomationRule.eyebrow', 'Automation')}
      title={
        template
          ? ruleSentence(tOr, template.triggerKind, template.actionKind)
          : tOr('AutomationTemplateEditScreen.editTemplate', 'Edit template')
      }
      actions={
        template && !deleted ? (
          <span className={`tm-aur-pill${template.enabled ? '' : ' tm-aur-pill--off'}`}>
            {template.enabled ? (
              <>
                <span aria-hidden="true">✓</span> {tOr('AutomationRule.on', 'On')}
              </>
            ) : (
              tOr('AutomationRule.off', 'Off')
            )}
          </span>
        ) : null
      }
    >
      <div className="tm-aur">
        {deleted ? (
          <div className="tm-aur-card">
            <p className="tm-aur-done__title">
              {tOr('AutomationRule.deletedTitle', 'Rule deleted')}
            </p>
            <p className="tm-aur-hint">{tOr('AutomationRule.deletedBody', 'It no longer runs.')}</p>
            <Link href={backHref} className="tm-button tm-button--outline tm-button--feature">
              {tOr('AutomationRule.backToAutomations', 'Back to automations')}
            </Link>
          </div>
        ) : null}

        {!deleted && (templates.isError || conditions.isError) ? (
          <InlineAlert
            tone="danger"
            title={tOr('AutomationTemplateEditScreen.errorLoadTitle', 'Could not load this rule')}
            live
          >
            {describeError(tOr, templates.error ?? conditions.error)}
          </InlineAlert>
        ) : null}

        {!deleted && (templates.isPending || conditions.isPending) ? (
          <div className="tm-aur-card">
            <LoadingRegion label={tOr('AutomationTemplateEditScreen.loadingLabel', 'Loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          </div>
        ) : null}

        {!deleted && !templates.isPending && !templates.isError && !template ? (
          <div className="tm-aur-card">
            <p className="tm-aur-done__title">
              {tOr('AutomationTemplateEditScreen.notFoundTitle', 'Rule not found')}
            </p>
            <p className="tm-aur-hint">
              {tOr('AutomationTemplateEditScreen.notFoundBody', 'It may have been removed.')}{' '}
              <Link href={backHref}>
                {tOr('AutomationTemplateEditScreen.backToLibrary', 'Back to automations')}
              </Link>
            </p>
          </div>
        ) : null}

        {!deleted && template && conditions.data ? (
          <RuleForm
            api={api}
            organizationSlug={organizationSlug}
            template={template}
            conditions={conditions.data}
            backHref={backHref}
            onDeleted={() => setDeleted(true)}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

interface RuleFormProps {
  api: ApiClient;
  organizationSlug: string;
  template: WorkflowTemplateSummary;
  conditions: readonly WorkflowConditionSummary[];
  backHref: string;
  onDeleted: () => void;
}

/**
 * The prefilled form. Split out so its `useState` initialises from the loaded rule and its
 * conditions exactly once, when the parent has them — not from an empty first render.
 */
function RuleForm({
  api,
  organizationSlug,
  template,
  conditions,
  backHref,
  onDeleted,
}: RuleFormProps) {
  const queryClient = useQueryClient();
  const tOr = useTOr();
  const ids = useId();

  const savedProject = projectChoiceOf(conditions);
  const savedStatus = statusChoiceOf(conditions);

  const [name, setName] = useState(template.name);
  const [triggerKind, setTriggerKind] = useState(template.triggerKind);
  const [actionKind, setActionKind] = useState(template.actionKind);
  const [projectId, setProjectId] = useState(savedProject);
  const [status, setStatus] = useState<StatusChoice>(savedStatus);
  const [alsoTell, setAlsoTell] = useState<AlsoTell>(
    template.config['alsoTell'] === 'project_lead' ? 'project_lead' : 'none',
  );
  const [skipWeekends, setSkipWeekends] = useState(template.config['skipWeekends'] === true);
  const [enabled, setEnabled] = useState(template.enabled);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const runs = useQuery({
    queryKey: ['workflow-runs', organizationSlug],
    queryFn: () => listWorkflowRuns(api, organizationSlug),
  });

  const save = useMutation({
    mutationFn: async () => {
      await updateWorkflowTemplate(api, organizationSlug, template.id, {
        name: name.trim(),
        triggerKind: triggerKind as WorkflowTriggerKind,
        actionKind: actionKind as WorkflowActionKind,
        enabled,
        config: { ...template.config, skipWeekends, alsoTell },
      });
      if (projectId !== savedProject) {
        await createWorkflowCondition(
          api,
          organizationSlug,
          template.id,
          projectCondition(projectId),
        );
      }
      if (status !== savedStatus) {
        await createWorkflowCondition(api, organizationSlug, template.id, statusCondition(status));
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workflow-templates', organizationSlug] }),
        queryClient.invalidateQueries({
          queryKey: ['workflow-conditions', organizationSlug, template.id],
        }),
      ]);
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteWorkflowTemplate(api, organizationSlug, template.id),
    onSuccess: async () => {
      onDeleted();
      await queryClient.invalidateQueries({ queryKey: ['workflow-templates', organizationSlug] });
    },
  });

  const canSave = name.trim() !== '' && !save.isPending;
  const projectOptions = projects.data ?? [];
  const knownProject = projectId === '' || projectOptions.some((p) => p.id === projectId);

  return (
    <form
      className="tm-aur-card"
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (canSave) save.mutate();
      }}
    >
      <div className="tm-aur-field">
        <label className="tm-aur-field__label" htmlFor={`${ids}-name`}>
          {tOr('AutomationRule.ruleName', 'Rule name')}
        </label>
        <input
          id={`${ids}-name`}
          className="tm-aur-input"
          name="name"
          value={name}
          required
          maxLength={300}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <fieldset className="tm-aur-block">
        <legend className="tm-aur-block__title">{tOr('AutomationRule.when', 'When')}</legend>
        <div className="tm-aur-chips">
          <Chip id={`${ids}-trigger`} label={tOr('AutomationRule.triggerLabel', 'Trigger')}>
            <select
              id={`${ids}-trigger`}
              className="tm-aur-chip__select"
              value={triggerKind}
              onChange={(event) => setTriggerKind(event.target.value)}
            >
              {TRIGGER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {triggerLabel(tOr, kind)}
                </option>
              ))}
            </select>
          </Chip>
        </div>
      </fieldset>

      <fieldset className="tm-aur-block">
        <legend className="tm-aur-block__title">{tOr('AutomationRule.onlyIf', 'Only if')}</legend>
        <div className="tm-aur-chips">
          <Chip id={`${ids}-project`} label={tOr('AutomationRule.projectLabel', 'Project')}>
            <select
              id={`${ids}-project`}
              className="tm-aur-chip__select"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">{tOr('AutomationRule.anyProject', 'Any project')}</option>
              {!knownProject ? <option value={projectId}>{projectId}</option> : null}
              {projectOptions.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Chip>
          <Chip id={`${ids}-status`} label={tOr('AutomationRule.statusLabel', 'Status')}>
            <select
              id={`${ids}-status`}
              className="tm-aur-chip__select"
              value={status}
              onChange={(event) => setStatus(event.target.value as StatusChoice)}
            >
              <option value="any">{tOr('AutomationRule.anyStatus', 'Any status')}</option>
              <option value="not_done">{tOr('AutomationRule.notDone', 'Not done')}</option>
              <option value="done">{tOr('AutomationRule.done', 'Done')}</option>
            </select>
          </Chip>
        </div>
      </fieldset>

      <fieldset className="tm-aur-block">
        <legend className="tm-aur-block__title">{tOr('AutomationRule.then', 'Then')}</legend>
        <div className="tm-aur-chips">
          <Chip id={`${ids}-action`} label={tOr('AutomationRule.actionLabel', 'Action')}>
            <select
              id={`${ids}-action`}
              className="tm-aur-chip__select"
              value={actionKind}
              onChange={(event) => setActionKind(event.target.value)}
            >
              {ACTION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {actionLabel(tOr, kind)}
                </option>
              ))}
            </select>
          </Chip>
          <Chip id={`${ids}-also`} label={tOr('AutomationRule.alsoTellLabel', 'Also tell')}>
            <select
              id={`${ids}-also`}
              className="tm-aur-chip__select"
              value={alsoTell}
              onChange={(event) => setAlsoTell(event.target.value as AlsoTell)}
            >
              <option value="project_lead">
                {tOr('AutomationRule.projectLead', 'Project lead')}
              </option>
              <option value="none">{tOr('AutomationRule.noOneElse', 'No one else')}</option>
            </select>
          </Chip>
        </div>
      </fieldset>

      <ToggleRow
        id={`${ids}-weekends`}
        label={tOr('AutomationRule.skipWeekends', 'Skip weekends')}
        hint={tOr(
          'AutomationRule.skipWeekendsHint',
          'Reminders due on Friday or Saturday go out on Thursday.',
        )}
        checked={skipWeekends}
        onChange={setSkipWeekends}
      />
      <ToggleRow
        id={`${ids}-enabled`}
        label={tOr('AutomationRule.ruleIsOn', 'Rule is on')}
        checked={enabled}
        onChange={setEnabled}
      />

      <p className="tm-aur-info">
        <span className="tm-aur-info__mark" aria-hidden="true">
          i
        </span>
        <span>
          <LastRunLine tOr={tOr} runs={runs.data} templateId={template.id} />
        </span>
      </p>

      {save.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('AutomationTemplateEditScreen.errorSaveTitle', 'Could not save the rule')}
          live
        >
          {describeError(tOr, save.error)}
        </InlineAlert>
      ) : null}
      {save.isSuccess ? (
        <p className="tm-aur-hint" role="status">
          {tOr('AutomationRule.saved', 'Rule saved.')}
        </p>
      ) : null}
      {remove.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('AutomationRule.deleteFailedTitle', 'Could not delete the rule')}
          live
        >
          {remove.error instanceof ApiRequestError && remove.error.status === 409
            ? tOr(
                'AutomationRule.inFlight',
                'This rule is running right now. Try again in a moment.',
              )
            : describeError(tOr, remove.error)}
        </InlineAlert>
      ) : null}

      {confirmingDelete ? (
        <div className="tm-aur-confirm" role="group" aria-labelledby={`${ids}-confirm`}>
          <p id={`${ids}-confirm`} className="tm-aur-confirm__title">
            {tOr('AutomationRule.deleteConfirmTitle', 'Delete this rule?')}
          </p>
          <p className="tm-aur-hint">
            {tOr(
              'AutomationRule.deleteConfirmBody',
              'It stops running and leaves the list. Its run history stays.',
            )}
          </p>
          <div className="tm-aur-confirm__actions">
            <Button
              type="button"
              tone="outline"
              size="accessible"
              onClick={() => setConfirmingDelete(false)}
            >
              {tOr('AutomationRule.keep', 'Keep it')}
            </Button>
            <Button
              type="button"
              tone="destructive"
              size="accessible"
              loading={remove.isPending}
              loadingLabel={tOr('AutomationRule.deleting', 'Deleting…')}
              onClick={() => remove.mutate()}
            >
              {tOr('AutomationRule.deleteConfirm', 'Delete')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="tm-aur-footer">
        <button type="button" className="tm-aur-delete" onClick={() => setConfirmingDelete(true)}>
          {tOr('AutomationRule.deleteRule', 'Delete rule')}
        </button>
        <div className="tm-aur-footer__end">
          <Link href={backHref} className="tm-button tm-button--outline tm-button--feature">
            {tOr('AutomationRule.cancel', 'Cancel')}
          </Link>
          <Button
            type="submit"
            tone="ink"
            size="feature"
            loading={save.isPending}
            loadingLabel={tOr('AutomationRule.saving', 'Saving…')}
            disabled={!canSave}
          >
            {tOr('AutomationRule.saveRule', 'Save rule')}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** One white chip: a small grey label over the value, the value a native select. */
function Chip({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="tm-aur-chip">
      <label className="tm-aur-chip__label" htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}

/** A label (and optional helper line) at the start, the switch at the end. */
function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="tm-aur-toggle">
      <div className="tm-aur-toggle__text">
        <label className="tm-aur-toggle__label" htmlFor={id}>
          {label}
        </label>
        {hint ? (
          <p className="tm-aur-hint" id={`${id}-hint`}>
            {hint}
          </p>
        ) : null}
      </div>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="tm-switch tm-aur-switch"
        checked={checked}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}

function clock(date: Date): string {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

/**
 * "Last ran today at 9:00 · 3 reminders sent." — from the run history: the newest run of this
 * rule, and how many of its runs that day succeeded (each successful run sent its reminder).
 */
function LastRunLine({
  tOr,
  runs,
  templateId,
}: {
  tOr: TOr;
  runs: readonly WorkflowRunHistoryItem[] | undefined;
  templateId: string;
}) {
  const locale = useActiveLocale();
  const mine = (runs ?? [])
    .filter((run) => run.templateId === templateId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const newest = mine[0];
  if (!newest) {
    return <>{tOr('AutomationRule.notRunYet', 'This rule has not run yet.')}</>;
  }
  const at = new Date(newest.startedAt);
  const sent = mine.filter(
    (run) => run.status === 'succeeded' && sameDay(new Date(run.startedAt), at),
  ).length;
  const when = sameDay(at, new Date())
    ? tOr('AutomationRule.lastRanToday', 'Last ran today at {time}').replace('{time}', clock(at))
    : tOr('AutomationRule.lastRanOn', 'Last ran on {date} at {time}')
        .replace('{date}', at.toLocaleDateString(locale, { day: 'numeric', month: 'short' }))
        .replace('{time}', clock(at));
  const count =
    sent === 1
      ? tOr('AutomationRule.reminderSent', '1 reminder sent.')
      : tOr('AutomationRule.remindersSent', '{count} reminders sent.').replace(
          '{count}',
          String(sent),
        );
  return <>{`${when} · ${count}`}</>;
}

function describeError(tOr: TOr, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) {
    return tOr('AutomationTemplateEditScreen.errorApiUnreachable', 'The service is unreachable.');
  }
  return tOr('AutomationTemplateEditScreen.errorGeneric', 'Something went wrong.');
}
