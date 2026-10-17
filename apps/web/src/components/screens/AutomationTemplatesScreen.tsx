'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
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
] as const satisfies readonly WorkflowTriggerKind[];

const ACTION_KINDS = [
  'notify_owner',
  'create_work_item',
  'post_message',
  'send_email_digest',
] as const satisfies readonly WorkflowActionKind[];

/** Turn `work_item_created` into `Work item created` for the option labels. */
function humanize(kind: string): string {
  const spaced = kind.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

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

  const rows = templates.data ?? [];

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

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Automations"
      description="Workflow templates: pair a trigger with an action your team reuses."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-automation-new-heading">
        <h2 id="tm-automation-new-heading" className="tm-eyebrow">
          New template
        </h2>
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <fieldset className="tm-fieldset tm-stack" disabled={!hydrated}>
            <Field
              label="Name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint="A short handle, such as Notify owner on new work."
              required
            />

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-automation-trigger">
                Trigger
              </label>
              <select
                id="tm-automation-trigger"
                className="tm-field__control"
                value={triggerKind}
                onChange={(event) => setTriggerKind(event.target.value as WorkflowTriggerKind)}
              >
                {TRIGGER_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {humanize(kind)}
                  </option>
                ))}
              </select>
            </div>

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-automation-action">
                Action
              </label>
              <select
                id="tm-automation-action"
                className="tm-field__control"
                value={actionKind}
                onChange={(event) => setActionKind(event.target.value as WorkflowActionKind)}
              >
                {ACTION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {humanize(kind)}
                  </option>
                ))}
              </select>
            </div>

            {create.isError ? (
              <InlineAlert tone="danger" title="Could not create the template" live>
                {describeError(create.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={create.isPending}
                loadingLabel="Creating"
                disabled={!canCreate}
              >
                Create template
              </Button>
            </div>
          </fieldset>
        </form>
      </section>

      <section
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-automation-list-heading"
      >
        <h2 id="tm-automation-list-heading" className="tm-eyebrow">
          Templates
        </h2>

        {templates.isError ? (
          <InlineAlert tone="danger" title="Could not load the templates" live>
            {describeError(templates.error)}
          </InlineAlert>
        ) : null}

        {templates.isPending ? (
          <LoadingRegion label="Loading the templates.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!templates.isPending && !templates.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No templates yet">
            Create a template above to pair a trigger with an action.
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
            aria-label="Workflow templates"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                Workflow templates for this organization, in name order, {rows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Trigger</th>
                  <th scope="col">Action</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((template) => (
                  <tr key={template.id}>
                    <th scope="row" className="tm-table__title">
                      {template.name}
                    </th>
                    <td>{humanize(template.triggerKind)}</td>
                    <td>{humanize(template.actionKind)}</td>
                    <td>{template.enabled ? 'Enabled' : 'Disabled'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
