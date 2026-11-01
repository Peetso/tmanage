'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/insights.css';
import { useT } from '../../lib/i18n/use-t';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  addInsightAnnotation,
  deleteInsightAnnotation,
  listInsightAnnotations,
} from '../../lib/api/insight-annotations';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { appLocale } from '../../lib/i18n/app-locale';

export interface InsightAnnotationsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The snapshot whose figure this thread annotates. */
  snapshotId: string;
  /** The caller's own membership id, so their own notes carry a delete affordance. */
  currentMembershipId?: string;
  client?: ApiClient;
}

const MAX_NOTE_LENGTH = 2000;

/** Render an ISO instant as a readable local date-time, falling back to the raw value. */
function formatInstant(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString(appLocale());
}

/**
 * **Insight annotations (module 15, Insights & reporting, INS-01 "every score is explainable", x271).**
 *
 * The annotation thread under a snapshot figure: a member reads the notes attached to an insight
 * snapshot, adds one that explains the figure, and removes one they authored. Persisted behind
 * `work.read`; the server resolves the snapshot tenant-scoped (an unknown one is a 404), authors every
 * note as the caller, and refuses a delete of another member's note (403).
 */
export function InsightAnnotationsScreen({
  organizationSlug,
  organizationName,
  snapshotId,
  currentMembershipId,
  client,
}: InsightAnnotationsScreenProps) {
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const t = useT();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const annotations = useQuery({
    queryKey: ['insight-annotations', organizationSlug, snapshotId],
    queryFn: () => listInsightAnnotations(api, organizationSlug, snapshotId),
  });

  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const invalidate = () =>
    queries.invalidateQueries({ queryKey: ['insight-annotations', organizationSlug, snapshotId] });

  const add = useMutation({
    mutationFn: () => addInsightAnnotation(api, organizationSlug, snapshotId, note.trim()),
    onSuccess: () => {
      setNote('');
      void invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string): Promise<void> =>
      deleteInsightAnnotation(api, organizationSlug, snapshotId, id),
    onSuccess: () => void invalidate(),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const trimmed = note.trim();
    if (trimmed.length === 0) {
      setFormError(t('InsightAnnotationsScreen.noteRequired'));
      return;
    }
    if (trimmed.length > MAX_NOTE_LENGTH) {
      setFormError(t('InsightAnnotationsScreen.noteTooLong'));
      return;
    }
    add.mutate();
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={t('InsightAnnotationsScreen.eyebrow')}
      title={t('InsightAnnotationsScreen.title')}
      description={t('InsightAnnotationsScreen.description')}
    >
      <div className="tm-ins tm-ins-tool">
        <form
          className="tm-panel tm-stack"
          aria-labelledby="tm-annotation-heading"
          onSubmit={submit}
        >
          <h2 id="tm-annotation-heading" className="tm-eyebrow">
            {t('InsightAnnotationsScreen.addHeading')}
          </h2>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-annotation-note">
              {t('InsightAnnotationsScreen.noteLabel')}
            </label>
            <textarea
              id="tm-annotation-note"
              className="tm-field__control"
              value={note}
              placeholder={t('InsightAnnotationsScreen.notePlaceholder')}
              maxLength={MAX_NOTE_LENGTH}
              rows={3}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          {formError ? (
            <InlineAlert tone="danger" title={t('InsightAnnotationsScreen.checkTitle')}>
              {formError}
            </InlineAlert>
          ) : null}

          {add.isError ? (
            <InlineAlert tone="danger" title={t('InsightAnnotationsScreen.addErrorTitle')}>
              {errorMessage(add.error)}
            </InlineAlert>
          ) : null}

          <div>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending
                ? t('InsightAnnotationsScreen.adding')
                : t('InsightAnnotationsScreen.addButton')}
            </Button>
          </div>
        </form>

        {annotations.isPending ? (
          <LoadingRegion label={t('InsightAnnotationsScreen.loading')}>
            <Skeleton />
          </LoadingRegion>
        ) : annotations.isError ? (
          <InlineAlert tone="danger" title={t('InsightAnnotationsScreen.loadErrorTitle')}>
            {errorMessage(annotations.error)}
          </InlineAlert>
        ) : annotations.data.length === 0 ? (
          <InlineAlert tone="neutral" title={t('InsightAnnotationsScreen.emptyTitle')}>
            {t('InsightAnnotationsScreen.emptyBody')}
          </InlineAlert>
        ) : (
          <ul className="tm-list tm-stack" aria-label={t('InsightAnnotationsScreen.listLabel')}>
            {annotations.data.map((annotation) => (
              <li key={annotation.id} className="tm-row tm-row--between">
                <div className="tm-stack tm-stack--tight">
                  <span>{annotation.note}</span>
                  <span className="tm-muted">{formatInstant(annotation.createdAt)}</span>
                </div>
                {currentMembershipId && annotation.authorMembershipId === currentMembershipId ? (
                  <Button
                    type="button"
                    tone="text"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(annotation.id)}
                  >
                    {t('InsightAnnotationsScreen.remove')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {remove.isError ? (
          <InlineAlert tone="danger" title={t('InsightAnnotationsScreen.removeErrorTitle')}>
            {errorMessage(remove.error)}
          </InlineAlert>
        ) : null}
      </div>
    </AppShell>
  );
}
