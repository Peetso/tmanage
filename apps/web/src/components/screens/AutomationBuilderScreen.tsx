'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flowIssues } from '@tmanage/domain';
import type { AutomationFlow, AutomationFlowIssue } from '@tmanage/domain';
import {
  Button,
  InlineAlert,
  LoadingRegion,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
  StateCapsule,
} from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import './automation-builder.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listWorkflowTemplates,
  runWorkflowTemplate,
  type WorkflowActionKind,
  type WorkflowTemplateSummary,
} from '../../lib/api/automations';
import {
  getWorkflowFlow,
  saveWorkflowFlow,
  turnOnWorkflowFlow,
  type WorkflowFlowSummary,
} from '../../lib/api/automation-flow';
import { listProjects, type ProjectSummary } from '../../lib/api/projects';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import {
  insertCondition,
  insertStep,
  locateStep,
  removeStep,
  savesNow,
  setAction,
  setCondition,
  toLanes,
  type FlowLanes,
  type LaneName,
} from '../../lib/automation-flow-lanes';
import { ACTIONS, actionLabel, conditionLabel, triggerLabel } from './automation-labels';

type TOr = (key: string, english: string) => string;

export interface AutomationBuilderScreenProps {
  organizationSlug: string;
  organizationName: string;
  templateId: string;
  client?: ApiClient;
}

const ACTION_KINDS = Object.keys(ACTIONS) as WorkflowActionKind[];
/** The Step settings choice that turns an unfinished main-path step into the If. */
const IF_CHOICE = 'if';
type CheckChoice = 'done' | 'not_done' | 'project';

/**
 * **Visual branching automation builder (58-C1, Figma 607:34180 / 607:34332).**
 *
 * One rule as a vertical flow: When (the trigger), the main-path Then steps, at most one If with
 * Yes and No branches, and the Then steps of each branch; "+" between steps and "Add step" at the
 * end of each lane; Step settings on the side. An unfinished step has a danger border and a top
 * alert, and Turn on stays off until every step is finished. Every edit is made by the pure lane
 * helpers and saved as a new version through `lib/api`; the API checks the graph again.
 */
export function AutomationBuilderScreen({
  organizationSlug,
  organizationName,
  templateId,
  client,
}: AutomationBuilderScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const templates = useQuery({
    queryKey: ['workflow-templates', organizationSlug],
    queryFn: () => listWorkflowTemplates(api, organizationSlug),
  });
  const flow = useQuery({
    queryKey: ['workflow-flow', organizationSlug, templateId],
    queryFn: () => getWorkflowFlow(api, organizationSlug, templateId),
  });
  const template = (templates.data ?? []).find((t) => t.id === templateId);
  const backHref = `/${organizationSlug}/automations`;

  const loading = templates.isPending || flow.isPending;
  const failed = templates.isError || flow.isError;

  return (
    <SettingsShell
      section="automations"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={tOr('AutomationBuilder.eyebrow', 'Automations')}
      title={template?.name ?? tOr('AutomationBuilder.title', 'Automation')}
    >
      {loading ? (
        <div className="tm-afb-loading">
          <p className="tm-afb-loading__label">
            {tOr('AutomationBuilder.opening', 'Opening the automation…')}
          </p>
          <LoadingRegion label={tOr('AutomationBuilder.opening', 'Opening the automation…')}>
            <Skeleton height="64px" />
            <Skeleton height="64px" />
            <Skeleton height="40px" width="62%" />
          </LoadingRegion>
        </div>
      ) : null}
      {failed ? (
        <InlineAlert
          tone="danger"
          title={tOr('AutomationBuilder.loadFailed', 'Could not open this automation')}
          live
        >
          {describeError(tOr, templates.error ?? flow.error)}
        </InlineAlert>
      ) : null}
      {!loading && !failed && !template ? (
        <InlineAlert tone="warning" title={tOr('AutomationBuilder.notFound', 'Rule not found')}>
          <Link href={backHref}>
            {tOr('AutomationBuilder.backToAutomations', 'Back to automations')}
          </Link>
        </InlineAlert>
      ) : null}
      {template && flow.data ? (
        <Builder
          key={`${template.id}:${String(flow.data.version)}`}
          api={api}
          organizationSlug={organizationSlug}
          template={template}
          saved={flow.data}
        />
      ) : null}
    </SettingsShell>
  );
}

interface BuilderProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly template: WorkflowTemplateSummary;
  readonly saved: WorkflowFlowSummary;
}

function Builder({ api, organizationSlug, template, saved }: BuilderProps) {
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AutomationFlow>(saved.flow);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(saved.enabled);

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name;

  const issues = flowIssues(draft);
  const lanes = toLanes(draft);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['workflow-templates', organizationSlug] });
  };
  const save = useMutation({
    mutationFn: (next: AutomationFlow) =>
      saveWorkflowFlow(api, organizationSlug, template.id, next),
    onSuccess: () => setDirty(false),
  });
  const turnOn = useMutation({
    mutationFn: () => turnOnWorkflowFlow(api, organizationSlug, template.id),
    onSuccess: async (view) => {
      setEnabled(view.enabled);
      await refresh();
    },
  });
  const testRun = useMutation({
    mutationFn: () => runWorkflowTemplate(api, organizationSlug, template.id),
  });

  const commit = (next: AutomationFlow, select: string | null) => {
    setDraft(next);
    setSelected(select);
    if (savesNow(enabled, flowIssues(next).length)) save.mutate(next);
    else setDirty(true);
  };

  const version = save.data?.version ?? saved.version;
  const status = enabled
    ? tOr('AutomationBuilder.statusOn', 'On')
    : tOr('AutomationBuilder.statusDraft', 'Draft');
  const subline = dirty
    ? tOr('AutomationBuilder.notSaved', 'Changes not saved yet')
    : version === null
      ? status
      : `${status} · ${tOr('AutomationBuilder.version', 'version {n}').replace('{n}', String(version))}`;

  const cardFor = (nodeId: string) => (
    <StepCard
      key={nodeId}
      tOr={tOr}
      nodeId={nodeId}
      draft={draft}
      projectName={projectName}
      selected={selected === nodeId}
      onSelect={() => setSelected(nodeId)}
    />
  );

  const laneSteps = (lane: LaneName) => (
    <>
      {lanes[lane].map((node, index) => (
        <Fragment key={node.id}>
          {index > 0 || lane === 'trunk' ? (
            <AddHere tOr={tOr} onAdd={() => addAt(lane, index)} />
          ) : (
            <span className="tm-afb-connector" aria-hidden="true" />
          )}
          {cardFor(node.id)}
        </Fragment>
      ))}
    </>
  );

  const addAt = (lane: LaneName, index: number) => {
    const inserted = insertStep(draft, lane, index);
    commit(inserted.flow, inserted.nodeId);
  };

  const addAtEnd = (lane: LaneName) => (
    <>
      <span className="tm-afb-connector" aria-hidden="true" />
      <button
        type="button"
        className="tm-afb-add-step"
        onClick={() => addAt(lane, lanes[lane].length)}
      >
        <span aria-hidden="true">+</span>
        {tOr('AutomationBuilder.addStep', 'Add step')}
      </button>
    </>
  );

  return (
    <div className="tm-afb">
      <div className="tm-afb-head">
        <p className="tm-afb-head__sub">{subline}</p>
        <div className="tm-afb-head__actions">
          <Button
            type="button"
            tone="outline"
            loading={testRun.isPending}
            onClick={() => testRun.mutate()}
          >
            {tOr('AutomationBuilder.testRun', 'Test run')}
          </Button>
          {enabled ? (
            <StateCapsule state="done">{tOr('AutomationBuilder.statusOn', 'On')}</StateCapsule>
          ) : (
            <Button
              type="button"
              tone="ink"
              disabled={issues.length > 0 || dirty}
              loading={turnOn.isPending}
              onClick={() => turnOn.mutate()}
            >
              {tOr('AutomationBuilder.turnOn', 'Turn on')}
            </Button>
          )}
        </div>
      </div>

      {issues.length > 0 ? (
        <InlineAlert tone="danger" title={attentionTitle(tOr, issues.length)}>
          {attentionBody(tOr, issues[0], lanes, enabled)}
        </InlineAlert>
      ) : null}
      <ResultAlerts
        tOr={tOr}
        save={save.error}
        turnOn={turnOn.error}
        testRun={testRun.error}
        ran={testRun.data}
      />

      <div className="tm-afb-body">
        <div
          className="tm-afb-canvas"
          role="group"
          aria-label={tOr('AutomationBuilder.canvas', 'Rule steps')}
        >
          <div className="tm-afb-step">
            <span className="tm-afb-step__kind">{tOr('AutomationBuilder.when', 'WHEN')}</span>
            <span className="tm-afb-step__title">{triggerLabel(tOr, template.triggerKind)}</span>
            <span className="tm-afb-step__detail">{template.name}</span>
          </div>
          {laneSteps('trunk')}
          {lanes.condition === null ? (
            addAtEnd('trunk')
          ) : (
            <>
              <AddHere tOr={tOr} onAdd={() => addAt('trunk', lanes.trunk.length)} />
              {cardFor(lanes.condition.id)}
              <span className="tm-afb-connector tm-afb-connector--split" aria-hidden="true" />
              <span className="tm-afb-split" aria-hidden="true" />
              <div className="tm-afb-branches">
                {(['yes', 'no'] as const).map((lane) => (
                  <div key={lane} className="tm-afb-branch">
                    <span className="tm-afb-connector" aria-hidden="true" />
                    {lane === 'yes' ? (
                      <StateCapsule state="done" className="tm-afb-branch__yes">
                        {tOr('AutomationBuilder.yes', 'Yes')}
                      </StateCapsule>
                    ) : (
                      <StateCapsule state="neutral">
                        {tOr('AutomationBuilder.no', 'No')}
                      </StateCapsule>
                    )}
                    {laneSteps(lane)}
                    {addAtEnd(lane)}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <StepSettings
          key={selected ?? 'none'}
          tOr={tOr}
          draft={draft}
          lanes={lanes}
          nodeId={selected}
          projects={projects.data ?? []}
          saving={save.isPending}
          onCommit={commit}
        />
      </div>
    </div>
  );
}

function AddHere({ tOr, onAdd }: { readonly tOr: TOr; readonly onAdd: () => void }) {
  return (
    <>
      <span className="tm-afb-connector tm-afb-connector--short" aria-hidden="true" />
      <button
        type="button"
        className="tm-afb-add"
        aria-label={tOr('AutomationBuilder.addHere', 'Add a step here')}
        onClick={onAdd}
      >
        +
      </button>
      <span className="tm-afb-connector tm-afb-connector--short" aria-hidden="true" />
    </>
  );
}

interface StepCardProps {
  readonly tOr: TOr;
  readonly draft: AutomationFlow;
  readonly nodeId: string;
  readonly projectName: (id: string) => string | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function StepCard({ tOr, draft, nodeId, projectName, selected, onSelect }: StepCardProps) {
  const node = draft.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return null;
  const unfinished = node.type === 'action' && node.actionKind === null;
  const kind =
    node.type === 'condition'
      ? tOr('AutomationBuilder.if', 'IF')
      : tOr('AutomationBuilder.then', 'THEN');
  const title =
    node.type === 'condition'
      ? conditionLabel(tOr, node, projectName)
      : node.actionKind === null
        ? tOr('AutomationBuilder.chooseTitle', 'Choose what happens')
        : actionLabel(tOr, node.actionKind);
  const detail =
    node.type === 'condition'
      ? tOr('AutomationBuilder.ifDetail', 'Checks the item that started this rule')
      : node.actionKind === null
        ? tOr(
            'AutomationBuilder.chooseDetail',
            'This step is not finished. Pick an action or remove the step.',
          )
        : node.actionKind === 'notify_owner'
          ? tOr('AutomationBuilder.notifyDetail', 'Tells the owner in their inbox')
          : tOr('AutomationBuilder.notYetDetail', 'Not available yet: logged as not run');
  return (
    <button
      type="button"
      className={`tm-afb-step${unfinished ? ' tm-afb-step--danger' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="tm-afb-step__row">
        <span className="tm-afb-step__kind">{kind}</span>
        {unfinished ? (
          <span className="tm-afb-step__flag">
            {tOr('AutomationBuilder.needsAttention', 'Needs attention')}
          </span>
        ) : null}
      </span>
      <span className="tm-afb-step__title">{title}</span>
      <span className="tm-afb-step__detail">{detail}</span>
    </button>
  );
}

interface StepSettingsProps {
  readonly tOr: TOr;
  readonly draft: AutomationFlow;
  readonly lanes: FlowLanes;
  readonly nodeId: string | null;
  readonly projects: readonly ProjectSummary[];
  readonly saving: boolean;
  readonly onCommit: (next: AutomationFlow, select: string | null) => void;
}

function StepSettings({
  tOr,
  draft,
  lanes,
  nodeId,
  projects,
  saving,
  onCommit,
}: StepSettingsProps) {
  const node = nodeId === null ? undefined : draft.nodes.find((n) => n.id === nodeId);
  const initialAction = node?.type === 'action' ? (node.actionKind ?? '') : '';
  const [choice, setChoice] = useState<string>(initialAction);
  const initialCheck: CheckChoice =
    node?.type === 'condition' && node.field === 'project_id'
      ? 'project'
      : node?.type === 'condition' && node.op === 'neq'
        ? 'not_done'
        : 'done';
  const [check, setCheck] = useState<CheckChoice>(initialCheck);
  const [projectId, setProjectId] = useState(
    node?.type === 'condition' && node.field === 'project_id' ? node.value : '',
  );

  if (node === undefined || nodeId === null) {
    return (
      <aside
        className="tm-afb-panel"
        aria-label={tOr('AutomationBuilder.settings', 'Step settings')}
      >
        <p className="tm-afb-panel__title">{tOr('AutomationBuilder.settings', 'Step settings')}</p>
        <p className="tm-afb-panel__hint">
          {tOr('AutomationBuilder.pickStep', 'Pick a step to change it, or add one with +.')}
        </p>
      </aside>
    );
  }

  const where = locateStep(lanes, nodeId);
  const place =
    where === null
      ? tOr('AutomationBuilder.placeIf', 'If')
      : `${laneName(tOr, where.lane)} · ${tOr('AutomationBuilder.stepN', 'step {n}').replace('{n}', String(where.position))}`;
  // The If can only be added on the main path, and a rule has one If at most.
  const mayBecomeIf = where?.lane === 'trunk' && lanes.condition === null;

  const saveStep = () => {
    if (node.type === 'condition') {
      const next =
        check === 'project'
          ? { field: 'project_id' as const, op: 'eq' as const, value: projectId }
          : {
              field: 'status' as const,
              op: check === 'done' ? ('eq' as const) : ('neq' as const),
              value: 'done',
            };
      onCommit(setCondition(draft, next), nodeId);
      return;
    }
    if (choice === IF_CHOICE && where !== null) {
      const inserted = insertCondition(removeStep(draft, nodeId), where.position - 1);
      onCommit(inserted.flow, inserted.nodeId);
      return;
    }
    onCommit(setAction(draft, nodeId, choice), nodeId);
  };

  const unchosen = node.type === 'action' && choice === '';
  const projectMissing = node.type === 'condition' && check === 'project' && projectId === '';

  return (
    <aside className="tm-afb-panel" aria-label={tOr('AutomationBuilder.settings', 'Step settings')}>
      <div className="tm-afb-panel__head">
        <p className="tm-afb-panel__title">{tOr('AutomationBuilder.settings', 'Step settings')}</p>
        <p className="tm-afb-panel__place">{place}</p>
      </div>
      {node.type === 'action' ? (
        <RadioGroup
          legend={tOr('AutomationBuilder.whatHappens', 'What should happen?')}
          error={
            unchosen ? tOr('AutomationBuilder.pickOne', 'Pick one to finish this step.') : undefined
          }
        >
          {ACTION_KINDS.map((kind) => (
            <Radio
              key={kind}
              value={kind}
              label={actionLabel(tOr, kind)}
              checked={choice === kind}
              onChange={() => setChoice(kind)}
            />
          ))}
          {mayBecomeIf ? (
            <Radio
              value={IF_CHOICE}
              label={tOr('AutomationBuilder.checkFirst', 'Check something first (Yes or No)')}
              checked={choice === IF_CHOICE}
              onChange={() => setChoice(IF_CHOICE)}
            />
          ) : null}
        </RadioGroup>
      ) : (
        <RadioGroup legend={tOr('AutomationBuilder.whatTrue', 'What should be true?')}>
          <Radio
            value="done"
            label={tOr('AutomationBuilder.ifDone', 'The work item is done')}
            checked={check === 'done'}
            onChange={() => setCheck('done')}
          />
          <Radio
            value="not_done"
            label={tOr('AutomationBuilder.ifNotDone', 'The work item is not done')}
            checked={check === 'not_done'}
            onChange={() => setCheck('not_done')}
          />
          <Radio
            value="project"
            label={tOr('AutomationBuilder.ifInProject', 'It is in one project')}
            checked={check === 'project'}
            onChange={() => setCheck('project')}
          />
        </RadioGroup>
      )}
      {node.type === 'condition' && check === 'project' ? (
        <Select
          label={tOr('AutomationBuilder.project', 'Project')}
          value={projectId}
          error={
            projectMissing ? tOr('AutomationBuilder.pickProject', 'Pick a project.') : undefined
          }
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">{tOr('AutomationBuilder.chooseProject', 'Choose a project')}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </Select>
      ) : null}
      <div className="tm-afb-panel__actions">
        <Button
          type="button"
          tone="ink"
          disabled={unchosen || projectMissing}
          loading={saving}
          onClick={saveStep}
        >
          {tOr('AutomationBuilder.saveStep', 'Save step')}
        </Button>
        <Button
          type="button"
          tone="outline"
          onClick={() => onCommit(removeStep(draft, nodeId), null)}
        >
          {tOr('AutomationBuilder.removeStep', 'Remove step')}
        </Button>
      </div>
    </aside>
  );
}

interface ResultAlertsProps {
  readonly tOr: TOr;
  readonly save: unknown;
  readonly turnOn: unknown;
  readonly testRun: unknown;
  readonly ran: { readonly status: string; readonly detail: Record<string, unknown> } | undefined;
}

function ResultAlerts({ tOr, save, turnOn, testRun, ran }: ResultAlertsProps) {
  return (
    <>
      {save ? (
        <InlineAlert
          tone="danger"
          title={tOr('AutomationBuilder.saveFailed', 'Could not save the steps')}
          live
        >
          {describeError(tOr, save)}
        </InlineAlert>
      ) : null}
      {turnOn ? (
        <InlineAlert
          tone="danger"
          title={tOr('AutomationBuilder.turnOnFailed', 'Could not turn this on')}
          live
        >
          {describeError(tOr, turnOn)}
        </InlineAlert>
      ) : null}
      {testRun ? (
        <InlineAlert
          tone="danger"
          title={tOr('AutomationRule.testRunFailedTitle', 'Could not run a test')}
          live
        >
          {testRun instanceof ApiRequestError && testRun.status === 409
            ? tOr('AutomationBuilder.testRunOff', 'This rule is off. Turn it on, then run a test.')
            : describeError(tOr, testRun)}
        </InlineAlert>
      ) : null}
      {ran ? (
        <InlineAlert
          tone={ran.status === 'succeeded' ? 'success' : 'warning'}
          title={
            ran.status === 'succeeded'
              ? tOr('AutomationRule.testRunDone', 'Test run done.')
              : tOr('AutomationRule.testRunNotDone', 'The test run did not complete.')
          }
          live
        >
          {testPath(tOr, ran.detail)}
        </InlineAlert>
      ) : null}
    </>
  );
}

/** Which way a test run went, read from its step log. */
function testPath(tOr: TOr, detail: Record<string, unknown>): string {
  const steps = Array.isArray(detail['steps']) ? (detail['steps'] as unknown[]) : [];
  const branch = steps
    .map((step) =>
      typeof step === 'object' && step !== null ? (step as { branch?: unknown }).branch : undefined,
    )
    .find((value) => value === 'yes' || value === 'no');
  const path =
    branch === 'yes'
      ? tOr('AutomationBuilder.tookYes', 'It took the Yes path.')
      : branch === 'no'
        ? tOr('AutomationBuilder.tookNo', 'It took the No path.')
        : '';
  return [path, tOr('AutomationBuilder.inHistory', 'The run and each step are in Run history.')]
    .filter(Boolean)
    .join(' ');
}

function laneName(tOr: TOr, lane: LaneName): string {
  if (lane === 'yes') return tOr('AutomationBuilder.yesBranch', 'Yes branch');
  if (lane === 'no') return tOr('AutomationBuilder.noBranch', 'No branch');
  return tOr('AutomationBuilder.mainPath', 'Main path');
}

function attentionTitle(tOr: TOr, count: number): string {
  return count === 1
    ? tOr('AutomationBuilder.attentionOne', '1 step needs attention')
    : tOr('AutomationBuilder.attentionMany', '{n} steps need attention').replace(
        '{n}',
        String(count),
      );
}

function attentionBody(
  tOr: TOr,
  issue: AutomationFlowIssue | undefined,
  lanes: FlowLanes,
  enabled: boolean,
): string {
  const after = enabled
    ? tOr('AutomationBuilder.thenSaves', 'then your changes are saved.')
    : tOr('AutomationBuilder.thenTurnOn', 'then you can turn this on.');
  if (issue === undefined || issue.reason === 'flow_empty') {
    return `${tOr('AutomationBuilder.addFirst', 'Add a first step,')} ${after}`;
  }
  if (issue.reason === 'branch_empty') {
    const branch =
      issue.branch === 'yes'
        ? tOr('AutomationBuilder.yes', 'Yes')
        : tOr('AutomationBuilder.no', 'No');
    return `${tOr('AutomationBuilder.fillBranch', 'Add a step to the “{branch}” branch,').replace('{branch}', branch)} ${after}`;
  }
  const where = locateStep(lanes, issue.nodeId);
  if (where === null || where.lane === 'trunk') {
    return `${tOr('AutomationBuilder.finishStep', 'Finish or remove the unfinished step,')} ${after}`;
  }
  const branch =
    where.lane === 'yes' ? tOr('AutomationBuilder.yes', 'Yes') : tOr('AutomationBuilder.no', 'No');
  return `${tOr('AutomationBuilder.finishBranchStep', 'Finish or remove the step in the “{branch}” branch,').replace('{branch}', branch)} ${after}`;
}

function describeError(tOr: TOr, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) {
    return tOr('AutomationBuilder.unreachable', 'The service is unreachable.');
  }
  return tOr('AutomationBuilder.genericError', 'Something went wrong.');
}
