'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, Switch } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { AutomationRunButton } from './AutomationRunButton';
import '../../styles/screens/automations.css';
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
      activeNavigationId="admin"
      eyebrow={
        template ? `Automation · ${template.enabled ? 'Live' : 'Off · not live'}` : 'Automation'
      }
      title={template?.name ?? 'Edit template'}
      actions={
        <Link href={`/${organizationSlug}/automations/runs`} className="tm-aut-btn">
          Run history
        </Link>
      }
    >
      <div className="tm-aut">
        {templates.isError ? (
          <InlineAlert tone="danger" title="Could not load the template" live>
            {describeError(templates.error)}
          </InlineAlert>
        ) : null}

        {templates.isPending ? (
          <div className="tm-aut-builder">
            <LoadingRegion label="Loading the template.">
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          </div>
        ) : null}

        {!templates.isPending && !templates.isError && !template ? (
          <div className="tm-aut-tablecard">
            <div className="tm-aut-empty">
              <p className="tm-aut-empty__title">Template not found</p>
              <p className="tm-aut-empty__body">
                This template does not exist, or it belongs to another organization.{' '}
                <Link href={`/${organizationSlug}/automations`}>Back to the library</Link>
              </p>
            </div>
          </div>
        ) : null}

        {template ? (
          <EditForm api={api} organizationSlug={organizationSlug} template={template} />
        ) : null}
      </div>
    </AppShell>
  );
}

interface EditFormProps {
  api: ApiClient;
  organizationSlug: string;
  template: WorkflowTemplateSummary;
}

/**
 * The prefilled edit form, drawn as AUT-02's builder: numbered WHEN / THEN steps on a rail, with
 * the template's state and a real run on the right. Split out so its `useState` initialises from
 * the loaded template exactly once, when the parent has the row — not from an empty first render.
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
    <div className="tm-aut-split tm-aut-split--builder">
      <section className="tm-aut-builder" aria-labelledby="tm-automation-edit-heading">
        <h2 id="tm-automation-edit-heading" className="tm-aut-eyebrow">
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

          <ol className="tm-aut-flow" aria-label="Steps">
            <li>
              <span className="tm-aut-flow__num" aria-hidden="true">
                1
              </span>
              <div className="tm-aut-flow__body">
                <p className="tm-aut-eyebrow">When</p>
                <p className="tm-aut-flow__title">{humanize(triggerKind)}</p>
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
              </div>
            </li>
            <li className="is-current">
              <span className="tm-aut-flow__num" aria-hidden="true">
                2
              </span>
              <div className="tm-aut-flow__body">
                <p className="tm-aut-eyebrow">Then</p>
                <p className="tm-aut-flow__title">{humanize(actionKind)}</p>
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
              </div>
            </li>
            <li className="is-add">
              <span className="tm-aut-flow__num" aria-hidden="true">
                +
              </span>
              <div className="tm-aut-flow__body">
                <p className="tm-aut-flow__add-title">One trigger, one action</p>
                <p className="tm-aut-flow__note">
                  Automations can never approve, publish, change access, invite, or delete.
                </p>
              </div>
            </li>
          </ol>

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

          <div className="tm-aut-actions">
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

      <div className="tm-aut-col">
        <section
          className={`tm-aut-card ${template.enabled ? '' : 'tm-aut-card--warning'}`}
          aria-labelledby="tm-automation-state-heading"
        >
          <h2
            id="tm-automation-state-heading"
            className="tm-aut-card__title tm-aut-card__title--section"
          >
            {template.enabled ? 'This automation is live' : 'This automation is off'}
          </h2>
          <p className="tm-aut-card__body">
            {template.enabled
              ? `When ${humanize(template.triggerKind).toLowerCase()} happens, it will ${humanize(template.actionKind).toLowerCase()}.`
              : 'It is kept but never fires. Turn on Enabled and save to make it live.'}
          </p>
          <p className="tm-aut-card__foot">
            Created {formatDate(template.createdAt)}. Every run is recorded in the run history.
          </p>
        </section>

        <section className="tm-aut-card tm-card--ink" aria-labelledby="tm-automation-run-heading">
          <p className="tm-aut-eyebrow">Run once · a real run</p>
          <h2 id="tm-automation-run-heading" className="tm-aut-card__title">
            Run it now
          </h2>
          <p className="tm-aut-card__body">
            Runs the saved version once, right away. The outcome lands in the run history.
          </p>
          <AutomationRunButton
            organizationSlug={organizationSlug}
            templateId={template.id}
            templateName={template.name}
            client={api}
          />
        </section>
      </div>
    </div>
  );
}

/** A short, locale-stable date (e.g. `18 Oct 2026`) for the created line. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
