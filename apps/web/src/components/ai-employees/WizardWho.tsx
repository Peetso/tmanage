'use client';

import { useId } from 'react';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { VoiceControl } from '../voice/VoiceControl';
import { useVoiceInput } from '../voice/use-voice-language';
import { FieldLabel, SelectBox } from './AiField';
import { DEPARTMENT_ENGLISH, DEPARTMENT_KEYS, VENDOR_LABELS } from './ai-employee-model';

export interface WhoDraft {
  readonly name: string;
  readonly jobTitle: string;
  readonly departmentKey: string;
  readonly vendorLabel: string;
}

export type WhoProblem = 'nameNeeded' | 'jobTitleNeeded';

/** The 80 / 120 caps the API keeps (`AI_EMPLOYEE_NAME_MAX`, `AI_EMPLOYEE_JOB_TITLE_MAX`). */
export const NAME_MAX = 80;
export const JOB_TITLE_MAX = 120;

export function whoProblems(draft: WhoDraft): readonly WhoProblem[] {
  const problems: WhoProblem[] = [];
  if (draft.name.trim() === '') problems.push('nameNeeded');
  if (draft.jobTitle.trim() === '') problems.push('jobTitleNeeded');
  return problems;
}

/**
 * S3a, step 1 "Who" (Figma `950:1036`): the name with voice naming (the shared mic and language
 * chip, as New team), job title, department and "Runs on" (optional). S3c: a missing name is said
 * under the name in the error colour and the name keeps the focus.
 *
 * "Change picture" is drawn in the design but not built: no route sets an AI employee's photo yet.
 */
export function WizardWho({
  api,
  organizationSlug,
  draft,
  problems,
  onChange,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly draft: WhoDraft;
  readonly problems: readonly WhoProblem[];
  readonly onChange: (next: WhoDraft) => void;
}) {
  const tOr = useTOr();
  const nameId = useId();
  const nameProblemId = useId();
  const jobId = useId();
  const jobProblemId = useId();
  const departmentId = useId();
  const vendorId = useId();
  const voice = useVoiceInput({
    api,
    organizationSlug,
    value: draft.name,
    onChange: (next) => onChange({ ...draft, name: next.slice(0, NAME_MAX) }),
  });
  const nameNeeded = problems.includes('nameNeeded');
  const jobNeeded = problems.includes('jobTitleNeeded');

  return (
    <>
      <div className="tm-team-dialog__field">
        <FieldLabel htmlFor={nameId} label={tOr('AiWizard.name', 'Name')} />
        <div className="tm-team-name" data-invalid={nameNeeded || undefined}>
          <input
            id={nameId}
            className="tm-team-name__input"
            value={draft.name}
            maxLength={NAME_MAX}
            dir="auto"
            required
            placeholder={tOr('AiWizard.name', 'Name')}
            data-autofocus
            aria-invalid={nameNeeded || undefined}
            {...(nameNeeded ? { 'aria-describedby': nameProblemId } : {})}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
          <VoiceControl input={voice} />
        </div>
        {nameNeeded ? (
          <p id={nameProblemId} className="tm-team-dialog__problem tm-aie-field-error">
            {tOr('AiWizard.nameNeeded', 'Give him a name.')}
          </p>
        ) : null}
      </div>

      <div className="tm-team-dialog__field">
        <FieldLabel htmlFor={jobId} label={tOr('AiPeople.colJobTitle', 'Job title')} />
        <input
          id={jobId}
          className="tm-aie-input"
          value={draft.jobTitle}
          maxLength={JOB_TITLE_MAX}
          dir="auto"
          required
          aria-invalid={jobNeeded || undefined}
          {...(jobNeeded ? { 'aria-describedby': jobProblemId } : {})}
          onChange={(event) => onChange({ ...draft, jobTitle: event.target.value })}
        />
        {jobNeeded ? (
          <p id={jobProblemId} className="tm-team-dialog__problem tm-aie-field-error">
            {tOr('AiWizard.jobTitleNeeded', 'Give him a job title.')}
          </p>
        ) : null}
      </div>

      <div className="tm-team-dialog__field">
        <FieldLabel htmlFor={departmentId} label={tOr('AiWizard.department', 'Department')} />
        <SelectBox
          id={departmentId}
          value={draft.departmentKey}
          onChange={(event) => onChange({ ...draft, departmentKey: event.target.value })}
        >
          <option value="">{tOr('AiWizard.chooseDepartment', 'Choose a department')}</option>
          {DEPARTMENT_KEYS.map((key) => (
            <option key={key} value={key}>
              {tOr(`AiDepartment.${key}`, DEPARTMENT_ENGLISH[key])}
            </option>
          ))}
        </SelectBox>
      </div>

      <div className="tm-team-dialog__field">
        <FieldLabel
          htmlFor={vendorId}
          label={tOr('AiWizard.runsOn', 'Runs on (optional)')}
          info={tOr(
            'AiWizard.runsOnInfo',
            'Which AI model runs his agent, as you tell us. Your team sees it; TManage does not check it.',
          )}
        />
        <SelectBox
          id={vendorId}
          value={draft.vendorLabel}
          onChange={(event) => onChange({ ...draft, vendorLabel: event.target.value })}
        >
          <option value="">{tOr('AiWizard.notSaid', 'Not said')}</option>
          {VENDOR_LABELS.map((vendor) => (
            <option key={vendor} value={vendor}>
              {vendor === 'Other' ? tOr('AiWizard.vendorOther', 'Other') : vendor}
            </option>
          ))}
        </SelectBox>
      </div>
    </>
  );
}
