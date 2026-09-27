'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, Switch } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listWorkflowTemplates,
  updateWorkflowTemplate,
  type WorkflowActionKind,
  type WorkflowTemplateSummary,
  type WorkflowTriggerKind,
} from '../../lib/api/automations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AutomationTemplateEditScreenProps {
  organizationSlug: string;
  organizationName: string;
  templateId: string;
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
 * **Automations & integrations (module 17, x189) — edit an existing workflow template.**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations & integrations. The create-only x162 slice
 * let an admin define a template and list it, but never rename it or re-point its trigger/action;
 * this screen closes that lifecycle gap. It is gated on the server by `org.manage` (the PATCH
 * refuses without it), and the id is tenant-scoped there before any write — an unknown or
 * cross-tenant id is a 404 the screen renders as a not-found state.
 *
 * There is no `GET …/templates/:id`; the template is found in the org-scoped list the server already
 * exposes, so the form is prefilled from that list. Archive is not offered — `workflow_templates`
 * has no archive column yet (a later migration slice).
 */
export function AutomationTemplateEditScreen({
  organizationSlug,
  organizationName,
  templateId,
  client,
}: AutomationTemplateEditScreenProps) {
  const api = client ?? browserApiClient();

  const templates = useQuery({
    queryKey: ['workflow-templates', organizationSlug],
    queryFn: () => listWorkflowTemplates(api, organizationSlug),
  });

  const template = (templates.data ?? []).find((t) => t.id === templateId);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Edit template"
      description="Rename an automation template, or re-point its trigger and action."
    >
      {templates.isError ? (
        <InlineAlert tone="danger" title="Could not load the template" live>
          {describeError(templates.error)}
        </InlineAlert>
      ) : null}

      {templates.isPending ? (
        <LoadingRegion label="Loading the template.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!templates.isPending && !templates.isError && !template ? (
        <InlineAlert tone="neutral" title="Template not found">
          This template does not exist, or it belongs to another organization.
        </InlineAlert>
      ) : null}

      {template ? (
        <EditForm api={api} organizationSlug={organizationSlug} template={template} />
      ) : null}
    </AppShell>
  );
}

interface EditFormProps {
  api: ApiClient;
  organizationSlug: string;
  template: WorkflowTemplateSummary;
}

/**
 * The prefilled edit form. Split out so its `useState` initialises from the loaded template exactly
 * once, when the parent has the row — not from an empty first render.
 */
function EditForm({ api, organizationSlug, template }: EditFormProps) {
  const queryClient = useQueryClient();

  const [name, setName] = useState(template.name);
  const [triggerKind, setTriggerKind] = useState(template.triggerKind);
  const [actionKind, setActionKind] = useState(template.actionKind);
  const [enabled, setEnabled] = useState(template.enabled);

  const save = useMutation({
    mutationFn: () =>
      updateWorkflowTemplate(api, organizationSlug, template.id, {
        name: name.trim(),
        triggerKind: triggerKind as WorkflowTriggerKind,
        actionKind: actionKind as WorkflowActionKind,
        enabled,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workflow-templates', organizationSlug] });
    },
  });

  const canSave = name.trim() !== '' && !save.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-automation-edit-heading">
      <h2 id="tm-automation-edit-heading" className="tm-eyebrow">
        Template details
      </h2>
      <form
        className="tm-stack"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        <Field
          label="Name"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          hint="A short handle, such as Notify owner on new work."
          required
        />

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-automation-edit-trigger">
            Trigger
          </label>
          <select
            id="tm-automation-edit-trigger"
            className="tm-field__control"
            value={triggerKind}
            onChange={(event) => setTriggerKind(event.target.value)}
          >
            {TRIGGER_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {humanize(kind)}
              </option>
            ))}
          </select>
        </div>

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-automation-edit-action">
            Action
          </label>
          <select
            id="tm-automation-edit-action"
            className="tm-field__control"
            value={actionKind}
            onChange={(event) => setActionKind(event.target.value)}
          >
            {ACTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {humanize(kind)}
              </option>
            ))}
          </select>
        </div>

        <Switch
          label="Enabled"
          hint="A disabled template is kept but never fires."
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />

        {save.isError ? (
          <InlineAlert tone="danger" title="Could not save the template" live>
            {describeError(save.error)}
          </InlineAlert>
        ) : null}

        {save.isSuccess ? (
          <InlineAlert tone="success" title="Saved" live>
            The template changes have been saved.
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={save.isPending}
            loadingLabel="Saving"
            disabled={!canSave}
          >
            Save changes
          </Button>
        </div>
      </form>
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
