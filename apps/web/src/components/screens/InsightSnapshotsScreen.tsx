'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/insights.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { captureSnapshot, listSnapshots } from '../../lib/api/insights-snapshots';
import type { SnapshotKind, SnapshotView } from '../../lib/api/insights-snapshots';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState } from '../help/TeachingEmptyState';
import type { MessageKey } from '../../lib/i18n/t';
import { appIntlLocale } from '../../lib/i18n/app-locale';

export interface InsightSnapshotsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/** The report kinds a snapshot can freeze, in the order the picker shows them. */
const KINDS: readonly { id: SnapshotKind; labelKey: MessageKey }[] = [
  { id: 'portfolio', labelKey: 'InsightSnapshotsScreen.kindPortfolio' },
  { id: 'workload', labelKey: 'InsightSnapshotsScreen.kindWorkload' },
];

/**
 * **Insight snapshots** — x211, module 15 (Insights & reporting). The audit's gap is that insights
 * are live-only, so a studio can read today's numbers but cannot compare them against a stored
 * moment over time. This screen closes it: pick a report kind, capture the current metrics into a
 * snapshot, and see the history — with the latest capture flagged as "current" so an earlier one can
 * be compared against it.
 *
 * The decisions are the sibling insights screens':
 * 1. **Authorization is the API's.** A caller without `work.read` gets the ordinary 403, which
 *    `describe()` turns into a sentence in the panel's own alert; the screen guesses no capability.
 * 2. **No invented numbers.** The payload shown is exactly what the API stored; the screen renders it
 *    as read-only JSON rather than re-deriving any metric of its own.
 * 3. **No charts dependency.** A semantic table with a caption and row scope carries the history.
 */
export function InsightSnapshotsScreen({
  organizationSlug,
  organizationName,
  client,
}: InsightSnapshotsScreenProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const [kind, setKind] = useState<SnapshotKind>('portfolio');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const history = useQuery({
    queryKey: ['insight-snapshots', organizationSlug, kind],
    queryFn: () => listSnapshots(api, organizationSlug, kind),
  });

  const capture = useMutation({
    mutationFn: (): Promise<SnapshotView> => captureSnapshot(api, organizationSlug, kind),
    onSuccess: () => {
      void queries.invalidateQueries({
        queryKey: ['insight-snapshots', organizationSlug, kind],
      });
    },
  });

  const snapshots = history.data ?? [];
  const current = snapshots[0] ?? null;
  const selected = selectedId ? (snapshots.find((s) => s.id === selectedId) ?? null) : null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow={t('InsightSnapshotsScreen.eyebrow')}
      title={t('InsightSnapshotsScreen.title')}
      description={t('InsightSnapshotsScreen.description')}
    >
      <div className="tm-ins tm-ins-tool">
        <section className="tm-panel tm-stack" aria-labelledby="tm-snapshots-heading">
          <h2 id="tm-snapshots-heading" className="tm-eyebrow">
            {t('InsightSnapshotsScreen.heading')}
          </h2>

          <div className="tm-row">
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-snapshot-kind">
                {t('InsightSnapshotsScreen.reportKind')}
              </label>
              <select
                id="tm-snapshot-kind"
                className="tm-field__control"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as SnapshotKind);
                  setSelectedId(null);
                }}
              >
                {KINDS.map(({ id, labelKey }) => (
                  <option key={id} value={id}>
                    {t(labelKey)}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              onClick={() => capture.mutate()}
              loading={capture.isPending}
              loadingLabel={t('InsightSnapshotsScreen.capturingSnapshot')}
            >
              {t('InsightSnapshotsScreen.captureCurrent')}
            </Button>
          </div>

          {capture.isError ? (
            <InlineAlert tone="danger" title={t('InsightSnapshotsScreen.captureErrorTitle')} live>
              {describe(capture.error)}
            </InlineAlert>
          ) : null}

          {history.isPending ? (
            <LoadingRegion
              label={t('InsightSnapshotsScreen.loading')}
              className="tm-stack tm-stack--tight"
            >
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {history.isError ? (
            <InlineAlert tone="danger" title={t('InsightSnapshotsScreen.loadErrorTitle')} live>
              {describe(history.error)}
            </InlineAlert>
          ) : null}

          {history.isSuccess ? (
            <SnapshotHistory
              snapshots={snapshots}
              currentId={current?.id ?? null}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : null}

          {selected && current ? <SnapshotCompare current={current} selected={selected} /> : null}
        </section>
      </div>
    </AppShell>
  );
}

function SnapshotHistory({
  snapshots,
  currentId,
  selectedId,
  onSelect,
}: {
  snapshots: readonly SnapshotView[];
  currentId: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  if (snapshots.length === 0) {
    return (
      <TeachingEmptyState
        title={t('teachEmpty.snapshotsTitle')}
        explanation={t('teachEmpty.snapshotsBody')}
      />
    );
  }

  return (
    <table className="tm-table">
      <caption className="tm-visually-hidden">{t('InsightSnapshotsScreen.tableCaption')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('InsightSnapshotsScreen.colCaptured')}</th>
          <th scope="col">{t('InsightSnapshotsScreen.colState')}</th>
          <th scope="col">{t('InsightSnapshotsScreen.colCompare')}</th>
        </tr>
      </thead>
      <tbody>
        {snapshots.map((snapshot) => (
          <tr key={snapshot.id}>
            <th scope="row" className="tm-mono">
              {formatMoment(snapshot.capturedAt)}
            </th>
            <td>
              {snapshot.id === currentId
                ? t('InsightSnapshotsScreen.currentLatest')
                : t('InsightSnapshotsScreen.historical')}
            </td>
            <td>
              {snapshot.id === currentId ? (
                '—'
              ) : (
                <Button
                  type="button"
                  tone="text"
                  size="compact"
                  onClick={() => onSelect(snapshot.id)}
                  aria-pressed={selectedId === snapshot.id}
                >
                  {t('InsightSnapshotsScreen.compareToCurrent')}
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SnapshotCompare({ current, selected }: { current: SnapshotView; selected: SnapshotView }) {
  const t = useT();
  return (
    <div className="tm-stack tm-stack--tight" aria-live="polite">
      <h3 className="tm-eyebrow">{t('InsightSnapshotsScreen.comparison')}</h3>
      <div className="tm-row">
        <SnapshotPayload
          title={`${t('InsightSnapshotsScreen.currentPrefix')} — ${formatMoment(current.capturedAt)}`}
          view={current}
        />
        <SnapshotPayload
          title={`${t('InsightSnapshotsScreen.selectedPrefix')} — ${formatMoment(selected.capturedAt)}`}
          view={selected}
        />
      </div>
    </div>
  );
}

function SnapshotPayload({ title, view }: { title: string; view: SnapshotView }) {
  return (
    <figure className="tm-stack tm-stack--tight">
      <figcaption className="tm-prose tm-mono">{title}</figcaption>
      <pre className="tm-code-block" aria-label={title}>
        {JSON.stringify(view.payload, null, 2)}
      </pre>
    </figure>
  );
}

/**
 * Format an ISO timestamp for display, following the browser's locale for the reason
 * `SessionsScreen` gives. An unparseable value is shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appIntlLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at);
}
