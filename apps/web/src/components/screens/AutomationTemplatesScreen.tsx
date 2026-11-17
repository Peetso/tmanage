'use client';

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { AutomationSectionTabs } from './AutomationSectionTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createWorkflowTemplate,
  listWorkflowTemplates,
  type WorkflowActionKind,
  type WorkflowTriggerKind,
} from '../../lib/api/automations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { useHydrated } from '../../lib/use-hydrated';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { useTOr } from '../../lib/i18n/use-t-or';
import { actionLabel, triggerLabel } from './automation-labels';

export interface AutomationTemplatesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const TRIGGER_KINDS = [
  'work_item_created',
  'work_item_transitioned',
  'request_submitted',
  'meeting_scheduled',
  'document_published',
  'work_item_due_soon',
] as const satisfies readonly WorkflowTriggerKind[];

const ACTION_KINDS = [
  'notify_owner',
  'create_work_item',
  'post_message',
  'send_email_digest',
] as const satisfies readonly WorkflowActionKind[];

/** The library's state filter (AUT-01's filter capsules), over the loaded rows only. */
const STATE_FILTERS = [{ value: 'all' }, { value: 'live' }, { value: 'off' }] as const;

type StateFilter = (typeof STATE_FILTERS)[number]['value'];

/**
 * **Automations & integrations (module 17, x162).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations & integrations ("workflow templates"). This
 * screen owns the org-scoped automation *templates* an admin defines: a name, a trigger, an action.
 * It defines a template and lists the organization's templates. Both routes are gated on the server by
 * `org.manage`, so a member without the capability sees the API's refusal rather than a blank page.
 *
 * ## What it does, and what it cannot
 *
 * - **Nothing runs here.** A template is a definition at rest; execution and run history are a later
 *   slice (x163). The screen shows whether a template is enabled, never a run.
 * - **A template is defined, never edited here.** The API grants create and read only this slice, so
 *   there is no edit, delete, or enable/disable control — a template is authored and then listed.
 */
export function AutomationTemplatesScreen({
  organizationSlug,
  organizationName,
  client,
}: AutomationTemplatesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
  const tOr = useTOr();

  const stateFilterLabel = (value: StateFilter): string => {
    switch (value) {
      case 'live':
        return t('AutomationTemplatesScreen.stateLive');
      case 'off':
        return t('AutomationTemplatesScreen.stateOff');
      default:
        return t('AutomationTemplatesScreen.filterAll');
    }
  };

  const templates = useQuery({
    queryKey: ['workflow-templates', organizationSlug],
    queryFn: () => listWorkflowTemplates(api, organizationSlug),
  });

  // The standing `useHydrated` barrier (see PolicySimulationScreen): these controlled inputs ship
  // disabled in the server render and enable once React is live, so text typed before hydration
  // cannot sit in the DOM while state stays empty and leaves Create template disabled for good.
  const hydrated = useHydrated();
  const [name, setName] = useState('');
  const [triggerKind, setTriggerKind] = useState<WorkflowTriggerKind>(TRIGGER_KINDS[0]);
  const [actionKind, setActionKind] = useState<WorkflowActionKind>(ACTION_KINDS[0]);

  const [stateFilter, setStateFilter] = useState<StateFilter>('all');

  const rows = templates.data ?? [];
  // ADM-04: automations are set up by the owner and organization admins. Someone else who opens the
  // page is told so, and is not shown a form the API would refuse.
  const refused = templates.error instanceof ApiRequestError && templates.error.status === 403;

  const create = useMutation({
    mutationFn: () =>
      createWorkflowTemplate(api, organizationSlug, {
        name: name.trim(),
        triggerKind,
        actionKind,
        config: {},
      }),
    onSuccess: async () => {
      setName('');
      setTriggerKind(TRIGGER_KINDS[0]);
      setActionKind(ACTION_KINDS[0]);
      await queryClient.invalidateQueries({ queryKey: ['workflow-templates', organizationSlug] });
    },
  });

  const canCreate = name.trim() !== '' && !create.isPending;

  const liveCount = rows.filter((template) => template.enabled).length;
  const offCount = rows.length - liveCount;
  const shown =
    stateFilter === 'all'
      ? rows
      : rows.filter((template) => (stateFilter === 'live' ? template.enabled : !template.enabled));

  return (
    <SettingsShell
      section="automations"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('AutomationTemplatesScreen.eyebrow')}
      // FIX3 item 10: headed with its menu name; the old headline is the lede.
      title={t('ControlCenterShell.automations')}
      description={t('AutomationTemplatesScreen.title')}
      actions={
        <>
          <Link href={`/${organizationSlug}/automations/runs`} className="tm-aut-btn">
            {t('AutomationTemplatesScreen.runHistory')}
          </Link>
          {refused ? null : (
            <Link href={`/${organizationSlug}/automations/builder`} className="tm-aut-btn">
              {tOr('AutomationBuilder.buildWithBranches', 'Build with branches')}
            </Link>
          )}
          {refused ? null : (
            <a href="#tm-automation-new" className="tm-aut-btn tm-aut-btn--ink">
              {t('AutomationTemplatesScreen.newAutomation')}
            </a>
          )}
        </>
      }
    >
      <div className="tm-aut">
        <AutomationSectionTabs
          organizationSlug={organizationSlug}
          current="library"
          count={rows.length}
          end={
            <fieldset
              className="tm-aut-filters"
              disabled={!hydrated}
              aria-label={t('AutomationTemplatesScreen.showLabel')}
            >
              {STATE_FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="tm-aut-filter"
                  aria-pressed={stateFilter === option.value}
                  onClick={() => setStateFilter(option.value)}
                >
                  {stateFilterLabel(option.value)}
                  {option.value === 'live' ? ` · ${liveCount}` : ''}
                </button>
              ))}
            </fieldset>
          }
        />

        <div className="tm-aut-split">
          <section className="tm-aut-col" aria-labelledby="tm-automation-list-heading">
            <h2 id="tm-automation-list-heading" className="tm-visually-hidden">
              {t('AutomationTemplatesScreen.templatesHeading')}
            </h2>

            {refused ? (
              <InlineAlert tone="neutral" title={t('AutomationTemplatesScreen.refusedTitle')} live>
                {t('AutomationTemplatesScreen.refusedBody')}
              </InlineAlert>
            ) : templates.isError ? (
              <InlineAlert tone="danger" title={t('AutomationTemplatesScreen.errorLoadTitle')} live>
                {describeError(t, templates.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-aut-tablecard">
              {templates.isPending ? (
                <div className="tm-aut-pad">
                  <LoadingRegion label={t('AutomationTemplatesScreen.loadingLabel')}>
                    <Skeleton height="var(--row)" />
                    <Skeleton height="var(--row)" />
                  </LoadingRegion>
                </div>
              ) : null}

              {!templates.isPending && !templates.isError && rows.length === 0 ? (
                <TeachingEmptyState
                  title={t('AutomationTemplatesScreen.emptyTitle')}
                  explanation={t('teachEmpty.automationsBody')}
                  action={
                    canUse('org.manage') ? (
                      <Button
                        tone="lime"
                        size="accessible"
                        onClick={() => focusFirstField(firstStep.current)}
                      >
                        {t('teachEmpty.automationsAction')}
                      </Button>
                    ) : undefined
                  }
                />
              ) : null}

              {rows.length > 0 ? (
                <div
                  className="tm-aut-tablecard__scroll"
                  // A scrollable region must be focusable or a keyboard cannot reach its overflow
                  // columns (WCAG 2.2 2.1.1), matching the sibling screens' tables.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                  tabIndex={0}
                  role="region"
                  aria-label={t('AutomationTemplatesScreen.tableLabel')}
                >
                  <table className="tm-aut-table">
                    <caption className="tm-visually-hidden">
                      {t('AutomationTemplatesScreen.captionPrefix')} {shown.length}{' '}
                      {t('AutomationTemplatesScreen.captionSuffix')}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('AutomationTemplatesScreen.colAutomation')}</th>
                        <th scope="col">{t('AutomationTemplatesScreen.colTrigger')}</th>
                        <th scope="col" className="tm-aut-hide-sm">
                          {t('AutomationTemplatesScreen.colAction')}
                        </th>
                        <th scope="col" className="tm-aut-end">
                          {t('AutomationTemplatesScreen.colState')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((template) => (
                        <tr key={template.id}>
                          <th scope="row">
                            <Link
                              href={`/${organizationSlug}/automations/templates/${encodeURIComponent(template.id)}`}
                              className="tm-aut-rowtitle"
                            >
                              {template.name}
                            </Link>
                            <span className="tm-aut-rowsub">
                              {triggerLabel(tOr, template.triggerKind)} →{' '}
                              {actionLabel(tOr, template.actionKind)}
                            </span>
                          </th>
                          <td>{triggerLabel(tOr, template.triggerKind)}</td>
                          <td className="tm-aut-hide-sm">
                            {actionLabel(tOr, template.actionKind)}
                          </td>
                          <td className="tm-aut-end">
                            <span
                              className={`tm-aut-state ${template.enabled ? 'tm-aut-state--live' : 'tm-aut-state--off'}`}
                            >
                              {template.enabled
                                ? t('AutomationTemplatesScreen.stateLive')
                                : t('AutomationTemplatesScreen.stateOff')}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {shown.length === 0 ? (
                    <div className="tm-aut-empty">
                      <p className="tm-aut-empty__title">
                        {t('AutomationTemplatesScreen.noMatchTitle')}
                      </p>
                      <p className="tm-aut-empty__body">
                        {t('AutomationTemplatesScreen.noMatchBody')}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          {refused ? null : (
            <div className="tm-aut-col">
              <section
                id="tm-automation-new"
                className="tm-aut-card tm-card--ink"
                aria-labelledby="tm-automation-new-heading"
              >
                <p className="tm-aut-eyebrow">
                  <span className="tm-aut-eyebrow__orb" aria-hidden="true" />
                  {t('AutomationTemplatesScreen.newAutomation')}
                </p>
                <h2 id="tm-automation-new-heading" className="tm-aut-card__title">
                  {t('AutomationTemplatesScreen.newTemplate')}
                </h2>
                <form
                  ref={firstStep}
                  className="tm-stack"
                  noValidate
                  onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    if (canCreate) create.mutate();
                  }}
                >
                  <fieldset className="tm-fieldset tm-stack" disabled={!hydrated}>
                    <Field
                      label={t('AutomationTemplatesScreen.nameLabel')}
                      name="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      hint={t('AutomationTemplatesScreen.nameHint')}
                      required
                    />

                    <div className="tm-field">
                      <label className="tm-field__label" htmlFor="tm-automation-trigger">
                        {t('AutomationTemplatesScreen.triggerLabel')}
                      </label>
                      <select
                        id="tm-automation-trigger"
                        className="tm-field__control"
                        value={triggerKind}
                        onChange={(event) =>
                          setTriggerKind(event.target.value as WorkflowTriggerKind)
                        }
                      >
                        {TRIGGER_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {triggerLabel(tOr, kind)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="tm-field">
                      <label className="tm-field__label" htmlFor="tm-automation-action">
                        {t('AutomationTemplatesScreen.actionLabel')}
                      </label>
                      <select
                        id="tm-automation-action"
                        className="tm-field__control"
                        value={actionKind}
                        onChange={(event) =>
                          setActionKind(event.target.value as WorkflowActionKind)
                        }
                      >
                        {ACTION_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {actionLabel(tOr, kind)}
                          </option>
                        ))}
                      </select>
                    </div>

                    {create.isError ? (
                      <InlineAlert
                        tone="danger"
                        title={t('AutomationTemplatesScreen.errorCreateTitle')}
                        live
                      >
                        {describeError(t, create.error)}
                      </InlineAlert>
                    ) : null}

                    <div className="tm-aut-actions">
                      <Button
                        type="submit"
                        tone="lime"
                        size="accessible"
                        loading={create.isPending}
                        loadingLabel={t('AutomationTemplatesScreen.creating')}
                        disabled={!canCreate}
                      >
                        {t('AutomationTemplatesScreen.createButton')}
                      </Button>
                    </div>
                  </fieldset>
                </form>
              </section>

              <section className="tm-aut-card" aria-labelledby="tm-automation-summary-heading">
                <h2
                  id="tm-automation-summary-heading"
                  className="tm-aut-card__title tm-aut-card__title--section"
                >
                  {t('AutomationTemplatesScreen.inLibrary')}
                </h2>
                <dl className="tm-aut-bars">
                  <div className="tm-aut-bars__row">
                    <dt>{t('AutomationTemplatesScreen.stateLive')}</dt>
                    <dd className="tm-aut-bars__value">
                      <span className="tm-aut-bars__track" aria-hidden="true">
                        <span
                          className="tm-aut-bars__fill"
                          style={{ inlineSize: `${share(liveCount, rows.length)}%` }}
                        />
                      </span>
                      <span>{liveCount}</span>
                    </dd>
                  </div>
                  <div className="tm-aut-bars__row">
                    <dt>{t('AutomationTemplatesScreen.stateOff')}</dt>
                    <dd className="tm-aut-bars__value">
                      <span className="tm-aut-bars__track" aria-hidden="true">
                        <span
                          className="tm-aut-bars__fill tm-aut-bars__fill--muted"
                          style={{ inlineSize: `${share(offCount, rows.length)}%` }}
                        />
                      </span>
                      <span>{offCount}</span>
                    </dd>
                  </div>
                </dl>
                <p className="tm-aut-card__foot">{t('AutomationTemplatesScreen.foot')}</p>
                <div className="tm-aut-actions">
                  <Link href={`/${organizationSlug}/automations/runs`} className="tm-aut-btn">
                    {t('AutomationTemplatesScreen.openRunHistory')}
                  </Link>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </SettingsShell>
  );
}

/** A bar's width as a percentage of the whole; an empty library draws empty bars. */
function share(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

function describeError(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('AutomationTemplatesScreen.errorApiUnreachable');
  return t('AutomationTemplatesScreen.errorGeneric');
}
