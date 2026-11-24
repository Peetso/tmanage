'use client';

import { useCallback, useId, useState, type FormEvent } from 'react';
import { Button } from '@tmanage/ui';
import {
  hireAiEmployee,
  type AiEmployeeView,
  type CreatedAgentKeyView,
} from '../../lib/api/ai-employees';
import type { ApiClient } from '../../lib/api/client';
import type { PersonSummary } from '../../lib/api/people';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { withNumerals } from '../../lib/i18n/display-format';
import { fill, type CustomRoleOption } from '../people/ChangeRoleDialog';
import { CheckIcon } from '../work/work-icons';
import { AiDialogFrame, AiDialogHead, ConfirmDialog } from './AiDialog';
import { ConnectPanel, type ConnectChoice } from './ConnectPanel';
import { TestPanel } from './TestPanel';
import { WizardWho, whoProblems, type WhoDraft, type WhoProblem } from './WizardWho';
import { WizardWork, workProblems, type WorkDraft, type WorkProblem } from './WizardWork';
import type { ProjectOption, TestState } from './ai-employee-model';

export type WizardStep = 1 | 2 | 3 | 4;

/** Stories open the wizard at a drawn state (S3a–S4e). */
export interface HireWizardStart {
  readonly step?: WizardStep;
  readonly who?: WhoDraft;
  readonly work?: WorkDraft;
  readonly hired?: AiEmployeeView;
  readonly connect?: ConnectChoice;
  readonly createdKey?: CreatedAgentKeyView;
  readonly whoProblems?: readonly WhoProblem[];
  readonly confirmClose?: boolean;
  readonly testElapsedMs?: number;
  /** Stories: a stopped clock, so "Waiting for Mat · 0:12" holds still for the shot. */
  readonly testClock?: () => number;
}

export interface HireWizardProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly projects: readonly ProjectOption[];
  readonly projectsLoading: boolean;
  readonly closedIds: ReadonlySet<string>;
  readonly customRoles: readonly CustomRoleOption[];
  readonly people: readonly PersonSummary[];
  readonly myMembershipId: string | null;
  readonly roleLabel: (role: string) => string;
  /** After the hire: People re-reads (the new row shows "Not connected" until he connects). */
  readonly onHired: (ai: AiEmployeeView) => void;
  readonly onClose: (hired: AiEmployeeView | null) => void;
  readonly start?: HireWizardStart;
  /** Stories: the address the design shows. */
  readonly addressOverride?: string;
}

const EMPTY_WHO: WhoDraft = { name: '', jobTitle: '', departmentKey: '', vendorLabel: '' };

/**
 * S3–S4 "Hire an AI employee": Who → Work → Connect → Test, one dialog (a bottom sheet on a
 * phone). The hire is written when step 2 is left (`hireAiEmployee` with the projects), so closing
 * in steps 1–2 saves nothing. After the hire, closing before he is connected asks first (S3d): he
 * stays in People as "Not connected" and can be connected from his profile.
 */
export function HireWizard({
  api,
  organizationSlug,
  projects,
  projectsLoading,
  closedIds,
  customRoles,
  people,
  myMembershipId,
  roleLabel,
  onHired,
  onClose,
  start = {},
  addressOverride,
}: HireWizardProps) {
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const titleId = useId();
  const [step, setStep] = useState<WizardStep>(start.step ?? 1);
  const [who, setWho] = useState<WhoDraft>(start.who ?? EMPTY_WHO);
  const [work, setWork] = useState<WorkDraft>(
    start.work ?? { role: 'member', projectIds: [], sponsorMembershipId: '' },
  );
  const [whoShown, setWhoShown] = useState<readonly WhoProblem[]>(start.whoProblems ?? []);
  const [workShown, setWorkShown] = useState<readonly WorkProblem[]>([]);
  const [hired, setHired] = useState<AiEmployeeView | null>(start.hired ?? null);
  const [choice, setChoice] = useState<ConnectChoice>(start.connect ?? 'claude');
  const [createdKey, setCreatedKey] = useState<CreatedAgentKeyView | null>(
    start.createdKey ?? null,
  );
  const [testState, setTestState] = useState<TestState>('waiting');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [askClose, setAskClose] = useState(start.confirmClose ?? false);

  const name = (hired?.displayName ?? who.name.trim()) || tOr('AiWizard.him', 'him');
  const connected =
    createdKey !== null || testState === 'ready' || (hired !== null && hired.connection.live > 0);
  const onTestState = useCallback((state: TestState) => setTestState(state), []);

  const requestClose = () => {
    if (hired !== null && !connected) setAskClose(true);
    else onClose(hired);
  };

  const hire = async () => {
    setSaving(true);
    setProblem(null);
    try {
      const created = await hireAiEmployee(api, organizationSlug, {
        displayName: who.name.trim(),
        jobTitle: who.jobTitle.trim(),
        role: work.role,
        sponsorMembershipId: work.sponsorMembershipId === '' ? null : work.sponsorMembershipId,
        departmentKey: who.departmentKey === '' ? null : who.departmentKey,
        vendorLabel: who.vendorLabel === '' ? null : who.vendorLabel,
        projectIds: work.projectIds,
      });
      setHired(created);
      onHired(created);
      setStep(3);
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setSaving(false);
    }
  };

  const next = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (step === 1) {
      const found = whoProblems(who);
      setWhoShown(found);
      if (found.length === 0) setStep(2);
      return;
    }
    if (step === 2) {
      const found = workProblems(work);
      setWorkShown(found);
      if (found.length > 0) return;
      // A second Next after a hire never writes twice: he already exists.
      if (hired === null) void hire();
      else setStep(3);
      return;
    }
    if (step === 3) {
      setStep(4);
      return;
    }
    onClose(hired);
  };

  const title =
    step === 4
      ? fill(tOr('AiWizard.testTitle', 'Check {name}’s connection'), { name })
      : tOr('AiPeople.hireAi', 'Hire an AI employee');

  if (askClose && hired !== null) {
    return (
      <ConfirmDialog
        title={tOr('AiWizard.closeTitle', 'Close without connecting?')}
        lines={[
          fill(
            tOr(
              'AiWizard.closeSaved',
              '{name} is saved as Not connected. He can’t be given work until you connect him.',
            ),
            { name: hired.displayName },
          ),
          tOr('AiWizard.closeLater', 'You can connect him later from his profile.'),
        ]}
        confirmLabel={tOr('AiWizard.closeConfirm', 'Close')}
        cancelLabel={tOr('AiWizard.keepGoing', 'Keep setting up')}
        safeIsPrimary
        onConfirm={() => onClose(hired)}
        onClose={() => setAskClose(false)}
      />
    );
  }

  return (
    <AiDialogFrame labelledBy={titleId} onClose={requestClose}>
      <form className="tm-team-dialog__form" noValidate onSubmit={next}>
        <AiDialogHead id={titleId} title={title} onClose={requestClose} />
        <WizardStepper step={step} />

        {step === 1 ? (
          <WizardWho
            api={api}
            organizationSlug={organizationSlug}
            draft={who}
            problems={whoShown}
            onChange={(draft) => {
              setWho(draft);
              if (whoShown.length > 0) setWhoShown(whoProblems(draft));
            }}
          />
        ) : null}

        {step === 2 ? (
          <WizardWork
            aiName={name}
            draft={work}
            problems={workShown}
            onChange={(draft) => {
              setWork(draft);
              if (workShown.length > 0) setWorkShown(workProblems(draft));
            }}
            projects={projects}
            projectsLoading={projectsLoading}
            closedCount={closedIds.size}
            closedIds={closedIds}
            customRoles={customRoles}
            people={people}
            myMembershipId={myMembershipId}
            roleLabel={roleLabel}
          />
        ) : null}

        {step === 3 && hired !== null ? (
          <ConnectPanel
            api={api}
            organizationSlug={organizationSlug}
            ai={hired}
            choice={choice}
            onChoice={setChoice}
            createdKey={createdKey}
            onKeyCreated={setCreatedKey}
            {...(addressOverride === undefined ? {} : { addressOverride })}
          />
        ) : null}

        {step === 4 && hired !== null ? (
          <TestPanel
            api={api}
            organizationSlug={organizationSlug}
            ai={hired}
            onState={onTestState}
            onChangeConnection={() => setStep(3)}
            {...(start.testElapsedMs === undefined
              ? {}
              : { initialElapsedMs: start.testElapsedMs })}
            {...(start.testClock === undefined ? {} : { now: start.testClock })}
          />
        ) : null}

        {problem ? (
          <p className="tm-team-dialog__problem" role="alert">
            {problem}
          </p>
        ) : null}

        <WizardActions
          step={step}
          saving={saving}
          nextBlocked={step === 3 && choice === 'other' && createdKey === null}
          ready={testState === 'ready'}
          onBack={() => setStep((current) => (current === 4 ? 3 : current === 3 ? 2 : 1))}
          onCancel={requestClose}
          onSkip={requestClose}
        />
      </form>
    </AiDialogFrame>
  );
}

function WizardActions({
  step,
  saving,
  nextBlocked,
  ready,
  onBack,
  onCancel,
  onSkip,
}: {
  step: WizardStep;
  saving: boolean;
  nextBlocked: boolean;
  ready: boolean;
  onBack: () => void;
  onCancel: () => void;
  onSkip: () => void;
}) {
  const tOr = useTOr();
  const back = (
    <Button type="button" tone="outline" size="large" onClick={onBack}>
      {tOr('AiWizard.back', 'Back')}
    </Button>
  );
  if (step === 1) {
    return (
      <div className="tm-team-dialog__actions">
        <Button type="button" tone="text" size="large" onClick={onCancel}>
          {tOr('AiEmployees.cancel', 'Cancel')}
        </Button>
        <Button type="submit" tone="lime" size="large">
          {tOr('AiWizard.next', 'Next')}
        </Button>
      </div>
    );
  }
  if (step === 4) {
    return ready ? (
      <div className="tm-team-dialog__actions">
        <Button type="submit" tone="lime" size="large">
          {tOr('AiWizard.done', 'Done')}
        </Button>
      </div>
    ) : (
      <div className="tm-aie-actions-split">
        {back}
        <Button type="button" tone="text" size="large" flush onClick={onSkip}>
          {tOr('AiWizard.skip', 'Skip for now')}
        </Button>
      </div>
    );
  }
  return (
    <div className="tm-aie-actions-split">
      {/* Step 3 has no Back: the hire is saved when step 2 is left, so step 2 cannot change it. */}
      {step === 2 ? back : <span />}
      <Button type="submit" tone="lime" size="large" loading={saving} disabled={nextBlocked}>
        {tOr('AiWizard.next', 'Next')}
      </Button>
    </div>
  );
}

/** The four steps (Who · Work · Connect · Test): done ones ticked, the current one in lime. */
function WizardStepper({ step }: { step: WizardStep }) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const labels = [
    tOr('AiWizard.stepWho', 'Who'),
    tOr('AiWizard.stepWork', 'Work'),
    tOr('AiWizard.stepConnect', 'Connect'),
    tOr('AiWizard.stepTest', 'Test'),
  ];
  return (
    <ol className="tm-aie-stepper" aria-label={tOr('AiWizard.steps', 'Steps')}>
      {labels.map((label, index) => {
        const number = index + 1;
        const state = number < step ? 'done' : number === step ? 'current' : 'todo';
        return (
          <li
            key={label}
            className="tm-aie-stepper__step"
            data-state={state}
            {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}
          >
            <span className="tm-aie-stepper__mark" aria-hidden="true">
              {state === 'done' ? <CheckIcon /> : number.toLocaleString(withNumerals(locale))}
            </span>
            <span className="tm-aie-stepper__label">{label}</span>
            {state === 'done' ? (
              <span className="tm-visually-hidden">{tOr('AiWizard.stepDone', '(done)')}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
