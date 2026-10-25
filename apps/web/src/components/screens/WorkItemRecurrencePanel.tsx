'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  clearWorkItemRecurrence,
  generateNextOccurrence,
  getWorkItemRecurrence,
  setWorkItemRecurrence,
  WORK_ITEM_RECURRENCE_FREQS,
  type NextOccurrence,
  type WorkItemRecurrenceFreq,
} from '../../lib/api/work-item-recurrence';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface WorkItemRecurrencePanelProps {
  organizationSlug: string;
  workItemId: string;
  api: ApiClient;
}

function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString();
}

/**
 * **x257 — a work item's recurrence rule.** (Work module 7; the audit's "Work built; no recurrence
 * rule".)
 *
 * The recurrence editor on a work item: choose a cadence (`daily`/`weekly`/`monthly`), an interval
 * and an optional end date, save it (behind `work.update`), and clear it. The "Generate next"
 * action computes the next occurrence in-app from the rule — it creates no work item here; that path
 * stays in the work service. Behind `work.read` to view, `work.update` to change.
 *
 * It is mounted additively beside the rest of the detail screen (disjoint from the checklist,
 * comments and watchers panels), reads its own query, and invalidates that query on every write so
 * the editor reflects the server. The PUT upserts the single rule, so a repeat save is harmless.
 */
export function WorkItemRecurrencePanel({
  organizationSlug,
  workItemId,
  api,
}: WorkItemRecurrencePanelProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const queries = useQueryClient();
  const queryKey = ['work-item-recurrence', organizationSlug, workItemId] as const;
  const [freq, setFreq] = useState<WorkItemRecurrenceFreq>('weekly');
  const [interval, setInterval] = useState('1');
  const [until, setUntil] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<NextOccurrence | undefined>(undefined);

  const rule = useQuery({
    queryKey,
    queryFn: () => getWorkItemRecurrence(api, organizationSlug, workItemId),
  });

  // Seed the editor from the stored rule when it loads or changes.
  useEffect(() => {
    const current = rule.data;
    if (current) {
      setFreq(current.freq as WorkItemRecurrenceFreq);
      setInterval(String(current.interval));
      setUntil(current.until ? current.until.slice(0, 10) : '');
    }
  }, [rule.data]);

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const save = useMutation({
    mutationFn: () =>
      setWorkItemRecurrence(api, organizationSlug, workItemId, {
        freq,
        interval: Number(interval),
        until: until.trim() === '' ? null : new Date(`${until}T00:00:00.000Z`).toISOString(),
      }),
    onSuccess: () => {
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const clear = useMutation({
    mutationFn: () => clearWorkItemRecurrence(api, organizationSlug, workItemId),
    onSuccess: () => {
      setFailure(undefined);
      setPreview(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const generate = useMutation({
    mutationFn: () => generateNextOccurrence(api, organizationSlug, workItemId),
    onSuccess: (next) => {
      setFailure(undefined);
      setPreview(next);
    },
    onError: (error) => setFailure(describe(error)),
  });

  const intervalValue = Number(interval);
  const intervalValid =
    Number.isInteger(intervalValue) && intervalValue >= 1 && intervalValue <= 365;
  const pending = save.isPending || clear.isPending || generate.isPending;
  const hasRule = Boolean(rule.data);

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-work-recurrence">
      <h2 id="tm-work-recurrence" className="tm-eyebrow">
        {t('WorkItemRecurrencePanel.heading')}
      </h2>

      {rule.isPending ? (
        <LoadingRegion label={t('WorkItemRecurrencePanel.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {rule.isError ? (
        <InlineAlert tone="danger" title={t('WorkItemRecurrencePanel.loadError')} live>
          {describe(rule.error)}
        </InlineAlert>
      ) : null}

      {rule.data !== undefined ? (
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (intervalValid && !pending) save.mutate();
          }}
        >
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-work-recurrence-freq">
              {t('WorkItemRecurrencePanel.repeats')}
            </label>
            <select
              id="tm-work-recurrence-freq"
              className="tm-field__control"
              value={freq}
              onChange={(event) => setFreq(event.target.value as WorkItemRecurrenceFreq)}
            >
              {WORK_ITEM_RECURRENCE_FREQS.map((option) => (
                <option key={option} value={option}>
                  {option.charAt(0).toUpperCase() + option.slice(1)}
                </option>
              ))}
            </select>
          </div>

          <Field
            label={t('WorkItemRecurrencePanel.interval')}
            name="interval"
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            value={interval}
            onChange={(event) => setInterval(event.target.value)}
            hint={t('WorkItemRecurrencePanel.intervalHint')}
            error={
              interval.trim() !== '' && !intervalValid
                ? t('WorkItemRecurrencePanel.intervalError')
                : undefined
            }
            required
          />

          <Field
            label={t('WorkItemRecurrencePanel.until')}
            name="until"
            type="date"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
            hint={t('WorkItemRecurrencePanel.untilHint')}
          />

          {failure ? (
            <InlineAlert tone="danger" title={t('WorkItemRecurrencePanel.failureTitle')} live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={save.isPending}
              loadingLabel={t('WorkItemRecurrencePanel.saving')}
              disabled={!intervalValid || pending}
            >
              {hasRule
                ? t('WorkItemRecurrencePanel.updateRecurrence')
                : t('WorkItemRecurrencePanel.setRecurrence')}
            </Button>
            {hasRule ? (
              <>
                <Button
                  type="button"
                  tone="outline"
                  size="accessible"
                  loading={generate.isPending}
                  loadingLabel={t('WorkItemRecurrencePanel.computing')}
                  disabled={pending}
                  onClick={() => generate.mutate()}
                >
                  {t('WorkItemRecurrencePanel.generateNext')}
                </Button>
                <Button
                  type="button"
                  tone="text"
                  size="accessible"
                  loading={clear.isPending}
                  loadingLabel={t('WorkItemRecurrencePanel.clearing')}
                  disabled={pending}
                  onClick={() => clear.mutate()}
                >
                  {t('WorkItemRecurrencePanel.clear')}
                </Button>
              </>
            ) : null}
          </div>
        </form>
      ) : null}

      {preview ? (
        <p className="tm-prose" aria-live="polite">
          {preview.exhausted || preview.nextAt === null
            ? t('WorkItemRecurrencePanel.ruleEnded')
            : `${t('WorkItemRecurrencePanel.nextOccurrencePrefix')} ${formatWhen(preview.nextAt)}.`}
        </p>
      ) : null}

      {rule.data === null && !rule.isPending ? (
        <p className="tm-prose">{t('WorkItemRecurrencePanel.doesNotRepeat')}</p>
      ) : null}
    </section>
  );
}
