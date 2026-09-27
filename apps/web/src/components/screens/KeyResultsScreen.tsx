'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { createKeyResult, listKeyResults, updateKeyResult } from '../../lib/api/key-results';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface KeyResultsScreenProps {
  organizationSlug: string;
  /** The objective whose key results this section shows. */
  objectiveId: string;
  /** The objective's name, for the section heading and accessible labels. */
  objectiveName: string;
  client?: ApiClient;
}

/**
 * **Key results (x207).**
 *
 * `38-MODULE-MAP` §Projects & portfolio ("objectives, key results"): the measurable children of one
 * project objective. This section lists an objective's key results in creation order, adds one, and
 * inline-edits a key result's current value — the progress edit. It reads
 * `GET …/objectives/:id/key-results` and writes `POST …/key-results` and
 * `PATCH …/key-results/:keyResultId`, gated on the server by `project.manage` (create/update) and
 * `work.read` (list).
 *
 * As on the sibling sections, **authorization is the API's** and so is progress: `progressPercent`
 * arrives computed and bounded, and the section renders it rather than recomputing it. A caller without
 * the capability gets the ordinary refusal, which `describeError()` turns into a sentence; the section
 * never guesses a capability of its own and never renders blank on a refusal.
 */
export function KeyResultsScreen({
  organizationSlug,
  objectiveId,
  objectiveName,
  client,
}: KeyResultsScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [targetValue, setTargetValue] = useState('');
  const [unit, setUnit] = useState('');
  /** Per-row draft of the current value being edited inline, keyed by key-result id. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const headingId = `tm-key-results-${objectiveId}`;

  const keyResults = useQuery({
    queryKey: ['key-results', organizationSlug, objectiveId],
    queryFn: () => listKeyResults(api, organizationSlug, objectiveId),
  });

  async function refetch() {
    await queryClient.invalidateQueries({
      queryKey: ['key-results', organizationSlug, objectiveId],
    });
  }

  const createMutation = useMutation({
    mutationFn: () =>
      createKeyResult(api, organizationSlug, objectiveId, {
        title: title.trim(),
        targetValue: Number(targetValue),
        unit: unit.trim(),
      }),
    onSuccess: async () => {
      setTitle('');
      setTargetValue('');
      setUnit('');
      await refetch();
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { readonly keyResultId: string; readonly currentValue: number }) =>
      updateKeyResult(api, organizationSlug, objectiveId, input.keyResultId, {
        currentValue: input.currentValue,
      }),
    onSuccess: async (_result, input) => {
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[input.keyResultId];
        return next;
      });
      await refetch();
    },
  });

  const rows = useMemo(() => keyResults.data ?? [], [keyResults.data]);
  const canSubmit =
    title.trim() !== '' &&
    unit.trim() !== '' &&
    targetValue.trim() !== '' &&
    Number(targetValue) >= 0;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || createMutation.isPending) return;
    createMutation.mutate();
  }

  return (
    <section className="tm-panel tm-stack" aria-labelledby={headingId}>
      <h3 id={headingId} className="tm-eyebrow">
        Key results — {objectiveName}
      </h3>

      <form className="tm-stack" onSubmit={onSubmit} noValidate>
        <fieldset
          className="tm-fieldset tm-stack tm-stack--loose"
          disabled={createMutation.isPending}
        >
          <Field
            label="Title"
            name="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            hint="What this key result measures, e.g. “Trial-to-paid conversion”."
            required
          />
          <Field
            label="Target value"
            name="targetValue"
            type="number"
            min={0}
            inputMode="numeric"
            value={targetValue}
            onChange={(event) => setTargetValue(event.target.value)}
            hint="The value the key result aims at. Progress is measured against it."
            required
          />
          <Field
            label="Unit"
            name="unit"
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            hint="How the target and current values are expressed, e.g. “%”, “customers”."
            required
          />
        </fieldset>

        {createMutation.isError ? (
          <InlineAlert tone="danger" title="Could not add the key result" live>
            {describeError(createMutation.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={createMutation.isPending}
            loadingLabel="Adding"
            disabled={!canSubmit}
          >
            Add key result
          </Button>
        </div>
      </form>

      {keyResults.isError ? (
        <InlineAlert tone="danger" title="Could not load the key results" live>
          {describeError(keyResults.error)}
        </InlineAlert>
      ) : null}

      {keyResults.isPending ? (
        <LoadingRegion label="Loading the objective's key results.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!keyResults.isPending && !keyResults.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No key results yet">
          This objective has no key results. Add the first one above.
        </InlineAlert>
      ) : null}

      {rows.length > 0 && updateMutation.isError ? (
        <InlineAlert tone="danger" title="Could not update the key result" live>
          {describeError(updateMutation.error)}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <div
          className="tm-table-scroll"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
          // (WCAG 2.2 2.1.1), matching the sibling sections' tables.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label={`Key results for ${objectiveName}`}
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Key results for this objective, in creation order, {rows.length} shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">Key result</th>
                <th scope="col">Progress</th>
                <th scope="col">Current</th>
                <th scope="col">Update current</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const draft = drafts[row.id];
                const draftValue = draft ?? String(row.currentValue);
                const rowPending =
                  updateMutation.isPending && updateMutation.variables?.keyResultId === row.id;
                return (
                  <tr key={row.id}>
                    <th scope="row" className="tm-table__title">
                      {row.title}
                    </th>
                    <td>{row.progressPercent}%</td>
                    <td>
                      {row.currentValue} / {row.targetValue} {row.unit}
                    </td>
                    <td>
                      <form
                        className="tm-row"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const value = Number(draftValue);
                          if (!Number.isFinite(value) || value < 0 || rowPending) return;
                          updateMutation.mutate({ keyResultId: row.id, currentValue: value });
                        }}
                        noValidate
                      >
                        <Field
                          label={`Current value for ${row.title}`}
                          name={`current-${row.id}`}
                          type="number"
                          min={0}
                          inputMode="numeric"
                          value={draftValue}
                          onChange={(event) =>
                            setDrafts((previous) => ({ ...previous, [row.id]: event.target.value }))
                          }
                        />
                        <Button
                          type="submit"
                          tone="outline"
                          size="accessible"
                          loading={rowPending}
                          loadingLabel="Saving"
                          disabled={rowPending}
                        >
                          Save
                        </Button>
                      </form>
                    </td>
                  </tr>
                );
              })}
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
