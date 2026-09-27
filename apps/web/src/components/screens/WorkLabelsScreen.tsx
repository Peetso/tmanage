'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  WORK_LABEL_COLORS,
  defineWorkLabel,
  listWorkLabels,
  type WorkLabelColor,
} from '../../lib/api/work-labels';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface WorkLabelsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

/**
 * **x233 — work item labels / tags.** (Work module 7.)
 *
 * The org-scoped label taxonomy the audit found missing: define a reusable label (a name and a colour
 * from a fixed palette) once, then tag work items with it elsewhere. This screen owns the definitions
 * — list them and define a new one; both routes are gated on the server by `work.update` (define) and
 * `work.read` (list), so a member without the capability sees the API's refusal rather than a blank
 * page. Assigning a label to a specific item is the work-item detail screen's job, via
 * {@link WorkItemLabelChips}.
 */
export function WorkLabelsScreen({
  organizationSlug,
  organizationName,
  client,
}: WorkLabelsScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['work-labels', organizationSlug] as const;

  const [name, setName] = useState('');
  const [color, setColor] = useState<WorkLabelColor>(WORK_LABEL_COLORS[0]);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const labels = useQuery({
    queryKey,
    queryFn: () => listWorkLabels(api, organizationSlug),
  });

  const define = useMutation({
    mutationFn: () => defineWorkLabel(api, organizationSlug, { name: name.trim(), color }),
    onSuccess: async () => {
      setName('');
      setColor(WORK_LABEL_COLORS[0]);
      setFailure(undefined);
      await queries.invalidateQueries({ queryKey });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const rows = labels.data ?? [];
  const canDefine = name.trim() !== '' && !define.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Labels"
      description="Define reusable labels, then tag work items with them."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-work-label-new-heading">
        <h2 id="tm-work-label-new-heading" className="tm-eyebrow">
          New label
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
            hint="A short handle, such as Urgent or Needs review."
            required
          />

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-work-label-color">
              Colour
            </label>
            <select
              id="tm-work-label-color"
              className="tm-field__control"
              value={color}
              onChange={(event) => setColor(event.target.value as WorkLabelColor)}
            >
              {WORK_LABEL_COLORS.map((option) => (
                <option key={option} value={option}>
                  {option.charAt(0).toUpperCase() + option.slice(1)}
                </option>
              ))}
            </select>
          </div>

          {failure ? (
            <InlineAlert tone="danger" title="Could not define the label" live>
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
              Define label
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-work-label-list-heading">
        <h2 id="tm-work-label-list-heading" className="tm-eyebrow">
          Labels
        </h2>
        {labels.isPending ? (
          <LoadingRegion label="Loading this studio’s labels.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {labels.isError ? (
          <InlineAlert tone="danger" title="Could not load the labels" live>
            {describe(labels.error)}
          </InlineAlert>
        ) : null}

        {labels.data ? (
          rows.length === 0 ? (
            <p className="tm-prose">No labels defined yet.</p>
          ) : (
            <ul
              className="tm-row tm-row--wrap"
              style={{ listStyle: 'none', padding: 0, margin: 0 }}
            >
              {rows.map((label) => (
                <li key={label.id} data-color={label.color} className="tm-badge">
                  {label.name}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </AppShell>
  );
}
