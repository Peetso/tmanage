'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createWorkflowCondition,
  listWorkflowConditions,
  type WorkflowConditionOp,
} from '../../lib/api/automations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AutomationConditionsScreenProps {
  organizationSlug: string;
  templateId: string;
  client?: ApiClient;
}

const CONDITION_OPS = [
  'eq',
  'neq',
  'gt',
  'lt',
  'contains',
] as const satisfies readonly WorkflowConditionOp[];

/** Human labels for the operator options. */
const OP_LABELS: Record<WorkflowConditionOp, string> = {
  eq: 'equals',
  neq: 'does not equal',
  gt: 'greater than',
  lt: 'less than',
  contains: 'contains',
};

/**
 * **Automations & integrations (module 17, x190).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations & integrations ("conditions / branching").
 * A **condition** gates a template step: a `(field, op, value)` predicate bound to a target step that
 * the run evaluator (x163) reads to decide whether the step fires. This section belongs on the template
 * edit surface — it lists a template's conditions and adds one. Both routes are gated on the server by
 * `org.manage`, so a member without the capability sees the API's refusal rather than a blank page.
 *
 * ## What it does, and what it cannot
 *
 * - **A condition is added, never edited here.** The API grants create and read only this slice, so
 *   there is no edit or delete control — a condition is authored and then listed in step order.
 * - **The operator set is closed.** The `op` options are the server allowlist; an off-list operator is
 *   the API's 400, not something this form can send.
 */
export function AutomationConditionsScreen({
  organizationSlug,
  templateId,
  client,
}: AutomationConditionsScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['workflow-conditions', organizationSlug, templateId];

  const conditions = useQuery({
    queryKey,
    queryFn: () => listWorkflowConditions(api, organizationSlug, templateId),
  });

  const [field, setField] = useState('');
  const [op, setOp] = useState<WorkflowConditionOp>(CONDITION_OPS[0]);
  const [value, setValue] = useState('');
  const [targetStep, setTargetStep] = useState('0');

  const rows = conditions.data ?? [];

  const create = useMutation({
    mutationFn: () =>
      createWorkflowCondition(api, organizationSlug, templateId, {
        field: field.trim(),
        op,
        value,
        targetStep: Number(targetStep),
      }),
    onSuccess: async () => {
      setField('');
      setOp(CONDITION_OPS[0]);
      setValue('');
      setTargetStep('0');
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const stepIsValid = Number.isInteger(Number(targetStep)) && Number(targetStep) >= 0;
  const canCreate = field.trim() !== '' && stepIsValid && !create.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-automation-conditions-heading">
      <h2 id="tm-automation-conditions-heading" className="tm-eyebrow">
        Conditions
      </h2>
      <p className="tm-muted">
        Gate a step: the step runs only when the event field satisfies the predicate.
      </p>

      <form
        className="tm-stack"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canCreate) create.mutate();
        }}
      >
        <Field
          label="Field"
          name="field"
          value={field}
          onChange={(event) => setField(event.target.value)}
          hint="The event field to test, such as priority."
          required
        />

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-automation-condition-op">
            Operator
          </label>
          <select
            id="tm-automation-condition-op"
            className="tm-field__control"
            value={op}
            onChange={(event) => setOp(event.target.value as WorkflowConditionOp)}
          >
            {CONDITION_OPS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {OP_LABELS[candidate]}
              </option>
            ))}
          </select>
        </div>

        <Field
          label="Value"
          name="value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          hint="What the field is compared against."
        />

        <Field
          label="Target step"
          name="targetStep"
          type="number"
          value={targetStep}
          onChange={(event) => setTargetStep(event.target.value)}
          hint="The step this condition gates (0 or more)."
          required
        />

        {create.isError ? (
          <InlineAlert tone="danger" title="Could not add the condition" live>
            {describeError(create.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={create.isPending}
            loadingLabel="Adding"
            disabled={!canCreate}
          >
            Add condition
          </Button>
        </div>
      </form>

      {conditions.isError ? (
        <InlineAlert tone="danger" title="Could not load the conditions" live>
          {describeError(conditions.error)}
        </InlineAlert>
      ) : null}

      {conditions.isPending ? (
        <LoadingRegion label="Loading the conditions.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!conditions.isPending && !conditions.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No conditions yet">
          Add a condition above to gate a step of this template.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <div
          className="tm-table-scroll"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
          // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Workflow conditions"
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Conditions for this template, in step order, {rows.length} shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Field</th>
                <th scope="col">Operator</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((condition) => (
                <tr key={condition.id}>
                  <th scope="row" className="tm-table__title">
                    {condition.targetStep}
                  </th>
                  <td>{condition.field}</td>
                  <td>{OP_LABELS[condition.op as WorkflowConditionOp] ?? condition.op}</td>
                  <td>{condition.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
