'use client';

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { WORK_ITEM_STATES } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import { Announce, Button, Checkbox, InlineAlert, Select } from '@tmanage/ui';
import {
  bulkTransitionWorkItems,
  type BulkTransitionOutcome,
  type BulkTransitionView,
} from '../../lib/api/work-bulk-transition';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { stateLabel } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

/** The minimum a row needs to be selected and transitioned in bulk. */
export interface BulkSelectableWorkItem {
  readonly id: string;
  readonly title: string;
  readonly state: WorkItemState;
}

export interface WorkBulkActionBarProps {
  organizationSlug: string;
  /** The rows the surrounding list is showing — the pool the bar selects from. */
  items: readonly BulkSelectableWorkItem[];
  api: ApiClient;
  /** Called after a batch runs so the list can refetch and reflect the moved rows. */
  onApplied?: (result: BulkTransitionView) => void;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

/** Per-outcome wording — plain, so a mixed batch reads as a plain list of what happened. */
const OUTCOME_LABEL: Record<BulkTransitionOutcome, string> = {
  applied: 'moved',
  not_found: 'not found',
  forbidden: 'not allowed',
  skipped_invalid: 'not a valid move',
  conflict: 'changed meanwhile',
};

/**
 * **x206 — the work list's bulk-action bar.** (Work module 7; `22-SCREEN-BY-SCREEN` §5's "bulk
 * actions" for the work table.)
 *
 * A distinct component from the list and board screens on purpose: it owns nothing but the
 * selection and the one action, so a screen can mount it beside its table without either
 * reaching into the other. Multi-select the visible rows, pick a target state, apply — and the
 * batch is not all-or-nothing, so the result is read back per item. The server re-validates
 * every id against the single-item state machine and tenant scope; this bar only decides which
 * ids to send and shows what came back.
 */
export function WorkBulkActionBar({
  organizationSlug,
  items,
  api,
  onApplied,
}: WorkBulkActionBarProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = useState<WorkItemState>('done');
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<BulkTransitionView | undefined>(undefined);

  // Only ids still present in the list can be acted on — a row that scrolled out of the loaded
  // set is not one this bar can honestly claim to move.
  const selectable = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const chosen = useMemo(
    () => [...selected].filter((id) => selectable.has(id)),
    [selected, selectable],
  );

  const apply = useMutation({
    mutationFn: () =>
      bulkTransitionWorkItems(api, organizationSlug, { ids: chosen, targetStatus: target }),
    onSuccess: (result) => {
      setFailure(undefined);
      setOutcome(result);
      setSelected(new Set());
      onApplied?.(result);
    },
    onError: (error) => {
      setOutcome(undefined);
      setFailure(describe(error));
    },
  });

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-work-bulk">
      <h2 id="tm-work-bulk" className="tm-eyebrow">
        Bulk status change
      </h2>

      {items.length === 0 ? (
        <p className="tm-prose">No work items to act on.</p>
      ) : (
        <>
          <ul className="tm-list" aria-label="Select work items to change">
            {items.map((item) => (
              <li key={item.id}>
                <Checkbox
                  label={`${item.title} — ${stateLabel(item.state)}`}
                  checked={selected.has(item.id)}
                  disabled={apply.isPending}
                  onChange={() => toggle(item.id)}
                />
              </li>
            ))}
          </ul>

          <Select
            label="Move selected to"
            value={target}
            disabled={apply.isPending}
            onChange={(event) => setTarget(event.target.value as WorkItemState)}
          >
            {WORK_ITEM_STATES.map((state) => (
              <option key={state} value={state}>
                {stateLabel(state)}
              </option>
            ))}
          </Select>

          <Button
            tone="ink"
            disabled={chosen.length === 0 || apply.isPending}
            loading={apply.isPending}
            onClick={() => apply.mutate()}
          >
            {chosen.length === 0
              ? 'Select items to change'
              : `Change ${chosen.length} to ${stateLabel(target)}`}
          </Button>
        </>
      )}

      {failure ? (
        <InlineAlert tone="danger" title="That did not go through" live>
          {failure}
        </InlineAlert>
      ) : null}

      {outcome ? (
        <div className="tm-stack">
          <Announce
            message={`${outcome.appliedCount} of ${outcome.results.length} moved to ${stateLabel(
              outcome.targetStatus,
            )}.`}
          />
          <p className="tm-prose">
            {outcome.appliedCount} of {outcome.results.length} moved to{' '}
            {stateLabel(outcome.targetStatus)}.
          </p>
          {outcome.results.some((result) => result.outcome !== 'applied') ? (
            <ul className="tm-list" aria-label="Items that did not move">
              {outcome.results
                .filter((result) => result.outcome !== 'applied')
                .map((result) => (
                  <li key={result.id} className="tm-prose">
                    {result.id}: {OUTCOME_LABEL[result.outcome]}
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
