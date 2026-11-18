'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createWorkflowCondition,
  deleteWorkflowCondition,
  listWorkflowConditions,
  type WorkflowConditionOp,
} from '../../lib/api/automations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { useTOr } from '../../lib/i18n/use-t-or';

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

/**
 * **Automations & integrations (module 17, x190).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations & integrations ("conditions / branching").
 * A **condition** gates a template step: a `(field, op, value)` predicate bound to a target step that
 * the run evaluator (x163) reads to decide whether the step fires. This section belongs on the template
 * edit surface — it lists a template's conditions, adds one and removes one. Both routes are gated on the server by
 * `org.manage`, so a member without the capability sees the API's refusal rather than a blank page.
 *
 * ## What it does, and what it cannot
 *
 * - **A condition is added or removed, never edited here.** Each row has a Remove action that asks
 *   first and then calls `DELETE …/conditions/:id`; on success the list is read again. There is no
 *   edit control — to change a condition, remove it and add the new one.
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
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
  const tOr = useTOr();
  const queryKey = ['workflow-conditions', organizationSlug, templateId];

  /** Human labels for the operator options. */
  const opLabel = (op: string): string => {
    switch (op) {
      case 'eq':
        return t('AutomationConditionsScreen.opEq');
      case 'neq':
        return t('AutomationConditionsScreen.opNeq');
      case 'gt':
        return t('AutomationConditionsScreen.opGt');
      case 'lt':
        return t('AutomationConditionsScreen.opLt');
      case 'contains':
        return t('AutomationConditionsScreen.opContains');
      default:
        return op;
    }
  };

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

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirming = rows.find((row) => row.id === confirmingId) ?? null;

  const remove = useMutation({
    mutationFn: (conditionId: string) =>
      deleteWorkflowCondition(api, organizationSlug, templateId, conditionId),
    onSuccess: async () => {
      setConfirmingId(null);
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const stepIsValid = Number.isInteger(Number(targetStep)) && Number(targetStep) >= 0;
  const canCreate = field.trim() !== '' && stepIsValid && !create.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-automation-conditions-heading">
      <h2 id="tm-automation-conditions-heading" className="tm-eyebrow">
        {t('AutomationConditionsScreen.heading')}
      </h2>
      <p className="tm-muted">{t('AutomationConditionsScreen.lede')}</p>

      <form
        ref={firstStep}
        className="tm-stack"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canCreate) create.mutate();
        }}
      >
        <Field
          label={t('AutomationConditionsScreen.fieldLabel')}
          name="field"
          value={field}
          onChange={(event) => setField(event.target.value)}
          hint={t('AutomationConditionsScreen.fieldHint')}
          required
        />

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-automation-condition-op">
            {t('AutomationConditionsScreen.operatorLabel')}
          </label>
          <select
            id="tm-automation-condition-op"
            className="tm-field__control"
            value={op}
            onChange={(event) => setOp(event.target.value as WorkflowConditionOp)}
          >
            {CONDITION_OPS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {opLabel(candidate)}
              </option>
            ))}
          </select>
        </div>

        <Field
          label={t('AutomationConditionsScreen.valueLabel')}
          name="value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          hint={t('AutomationConditionsScreen.valueHint')}
        />

        <Field
          label={t('AutomationConditionsScreen.targetStepLabel')}
          name="targetStep"
          type="number"
          value={targetStep}
          onChange={(event) => setTargetStep(event.target.value)}
          hint={t('AutomationConditionsScreen.targetStepHint')}
          required
        />

        {create.isError ? (
          <InlineAlert tone="danger" title={t('AutomationConditionsScreen.errorAddTitle')} live>
            {describeError(t, create.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={create.isPending}
            loadingLabel={t('AutomationConditionsScreen.adding')}
            disabled={!canCreate}
          >
            {t('AutomationConditionsScreen.addButton')}
          </Button>
        </div>
      </form>

      {conditions.isError ? (
        <InlineAlert tone="danger" title={t('AutomationConditionsScreen.errorLoadTitle')} live>
          {describeError(t, conditions.error)}
        </InlineAlert>
      ) : null}

      {conditions.isPending ? (
        <LoadingRegion label={t('AutomationConditionsScreen.loadingLabel')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!conditions.isPending && !conditions.isError && rows.length === 0 ? (
        <TeachingEmptyState
          title={t('AutomationConditionsScreen.emptyTitle')}
          explanation={t('teachEmpty.automationConditionsBody')}
          action={
            canUse('org.manage') ? (
              <Button
                tone="lime"
                size="accessible"
                onClick={() => focusFirstField(firstStep.current)}
              >
                {t('teachEmpty.automationConditionsAction')}
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {rows.length > 0 ? (
        <div
          className="tm-table-scroll"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
          // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label={t('AutomationConditionsScreen.tableLabel')}
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              {t('AutomationConditionsScreen.captionPrefix')} {rows.length}{' '}
              {t('AutomationConditionsScreen.captionSuffix')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('AutomationConditionsScreen.colStep')}</th>
                <th scope="col">{t('AutomationConditionsScreen.colField')}</th>
                <th scope="col">{t('AutomationConditionsScreen.colOperator')}</th>
                <th scope="col">{t('AutomationConditionsScreen.colValue')}</th>
                <th scope="col">
                  <span className="tm-visually-hidden">
                    {tOr('AutomationConditionsScreen.colActions', 'Actions')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((condition) => (
                <tr key={condition.id}>
                  <th scope="row" className="tm-table__title">
                    {condition.targetStep}
                  </th>
                  <td>{condition.field}</td>
                  <td>{opLabel(condition.op)}</td>
                  <td>{condition.value}</td>
                  <td>
                    <Button
                      type="button"
                      tone="outline"
                      size="accessible"
                      aria-label={`${tOr('AutomationConditionsScreen.removeButton', 'Remove')} ${condition.field} ${opLabel(condition.op)} ${condition.value}`.trim()}
                      disabled={remove.isPending}
                      onClick={() => {
                        remove.reset();
                        setConfirmingId(condition.id);
                      }}
                    >
                      {tOr('AutomationConditionsScreen.removeButton', 'Remove')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {confirming !== null ? (
        <div
          className="tm-panel tm-stack"
          role="group"
          aria-labelledby="tm-automation-condition-remove-title"
        >
          <p id="tm-automation-condition-remove-title" className="tm-eyebrow">
            {tOr('AutomationConditionsScreen.removeConfirmTitle', 'Remove this condition?')}
          </p>
          <p className="tm-muted">
            {confirming.field} {opLabel(confirming.op)} {confirming.value}
          </p>
          <p className="tm-muted">
            {tOr(
              'AutomationConditionsScreen.removeConfirmBody',
              'The rule stops checking it from its next run.',
            )}
          </p>
          {remove.isError ? (
            <InlineAlert
              tone="danger"
              title={tOr(
                'AutomationConditionsScreen.errorRemoveTitle',
                'Could not remove the condition',
              )}
              live
            >
              {describeError(t, remove.error)}
            </InlineAlert>
          ) : null}
          <div className="tm-row">
            <Button
              type="button"
              tone="outline"
              size="accessible"
              onClick={() => {
                remove.reset();
                setConfirmingId(null);
              }}
            >
              {tOr('AutomationConditionsScreen.keep', 'Keep it')}
            </Button>
            <Button
              type="button"
              tone="destructive"
              size="accessible"
              loading={remove.isPending}
              loadingLabel={tOr('AutomationConditionsScreen.removing', 'Removing…')}
              onClick={() => remove.mutate(confirming.id)}
            >
              {tOr('AutomationConditionsScreen.removeConfirm', 'Remove')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function describeError(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('AutomationConditionsScreen.errorApiUnreachable');
  return t('AutomationConditionsScreen.errorGeneric');
}
