'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  defineChecklistTemplate,
  deleteChecklistTemplate,
  listChecklistTemplates,
} from '../../lib/api/work-checklist-templates';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ChecklistTemplatesViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

/** Split a textarea into an ordered, trimmed, non-empty list of labels — one per line. */
function parseLabels(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * **x292 — reusable work-item checklist templates.** (Work module 7.)
 *
 * A member defines a named template — an ordered set of checklist item labels — once at org level,
 * then applies it to a work item to seed that item's checklist. This screen owns the definitions:
 * list them, define a new one (a name and one label per line), and remove one. Both write routes are
 * gated on the server by `work.update` and the list by `work.read`, so a member without the
 * capability sees the API's refusal rather than a blank page. Applying a template to a specific item
 * is the work-item detail screen's job, via {@link applyChecklistTemplate}.
 */
export function ChecklistTemplatesView({
  organizationSlug,
  organizationName,
  client,
}: ChecklistTemplatesViewProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['work-checklist-templates', organizationSlug] as const;

  const [name, setName] = useState('');
  const [labelsText, setLabelsText] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const templates = useQuery({
    queryKey,
    queryFn: () => listChecklistTemplates(api, organizationSlug),
  });

  const define = useMutation({
    mutationFn: () =>
      defineChecklistTemplate(api, organizationSlug, {
        name: name.trim(),
        labels: parseLabels(labelsText),
      }),
    onSuccess: async () => {
      setName('');
      setLabelsText('');
      setFailure(undefined);
      await queries.invalidateQueries({ queryKey });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const remove = useMutation({
    mutationFn: (templateId: string) => deleteChecklistTemplate(api, organizationSlug, templateId),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const rows = templates.data ?? [];
  const labels = parseLabels(labelsText);
  const canDefine = name.trim() !== '' && labels.length > 0 && !define.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Checklist templates"
      description="Define a reusable checklist, then apply it to a work item to seed its checklist."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-checklist-template-new-heading">
        <h2 id="tm-checklist-template-new-heading" className="tm-eyebrow">
          New template
        </h2>
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canDefine) define.mutate();
          }}
        >
          <Field
            label="Name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint="A short handle, such as Onboarding or Design review."
            required
          />

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-checklist-template-labels">
              Items
            </label>
            <textarea
              id="tm-checklist-template-labels"
              className="tm-field__control"
              rows={5}
              value={labelsText}
              onChange={(event) => setLabelsText(event.target.value)}
              placeholder={'One checklist item per line, in order'}
            />
            <p className="tm-field__hint">One item per line; blank lines are ignored.</p>
          </div>

          {failure ? (
            <InlineAlert tone="danger" title="Could not save the template" live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={define.isPending}
              loadingLabel="Saving"
              disabled={!canDefine}
            >
              Define template
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-checklist-template-list-heading">
        <h2 id="tm-checklist-template-list-heading" className="tm-eyebrow">
          Templates
        </h2>
        {templates.isPending ? (
          <LoadingRegion label="Loading this studio’s checklist templates.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {templates.isError ? (
          <InlineAlert tone="danger" title="Could not load the templates" live>
            {describe(templates.error)}
          </InlineAlert>
        ) : null}

        {templates.data ? (
          rows.length === 0 ? (
            <p className="tm-prose">No checklist templates defined yet.</p>
          ) : (
            <ul className="tm-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {rows.map((template) => (
                <li key={template.id} className="tm-row tm-row--between">
                  <span>
                    <strong>{template.name}</strong>{' '}
                    <span className="tm-muted">
                      ({template.labels.length} {template.labels.length === 1 ? 'item' : 'items'})
                    </span>
                  </span>
                  <Button
                    type="button"
                    tone="text"
                    size="accessible"
                    loading={remove.isPending && remove.variables === template.id}
                    loadingLabel="Removing"
                    onClick={() => remove.mutate(template.id)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </AppShell>
  );
}
