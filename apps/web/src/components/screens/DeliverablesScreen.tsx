'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { createDeliverable, listDeliverables } from '../../lib/api/deliverables';
import type { DeliverableState, DeliverableView } from '../../lib/api/deliverables';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface DeliverablesScreenProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  client?: ApiClient;
}

/** `Deliverables.*` keys arrive with the P7 catalog fragment; the prefix is checked here. */
export type DeliverablesKey = `Deliverables.${string}`;

export function useDeliverablesT(): (key: DeliverablesKey) => string {
  const t = useT();
  return (key) => t(key as MessageKey);
}

export const STATE_KEY: Readonly<Record<DeliverableState, DeliverablesKey>> = {
  draft: 'Deliverables.stateDraft',
  in_review: 'Deliverables.stateInReview',
  changes_requested: 'Deliverables.stateChangesRequested',
  approved: 'Deliverables.stateApproved',
};

export function stateCapsule(state: DeliverableState): CapsuleState {
  switch (state) {
    case 'approved':
      return 'done';
    case 'in_review':
      return 'client';
    case 'changes_requested':
      return 'waiting';
    default:
      return 'neutral';
  }
}

export function describeDeliverableError(error: unknown, t: (key: DeliverablesKey) => string) {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('Deliverables.errorOffline');
  return t('Deliverables.errorGeneric');
}

export function deliverablesQueryKey(organizationSlug: string, projectId: string) {
  return ['deliverables', organizationSlug, projectId] as const;
}

/**
 * **Team deliverables — list and create (BG2, Figma DEL-01).**
 *
 * One project's deliverables with their review state and latest version; a short form creates a
 * new one. The detail (versions, uploads, Send for approval) is `DeliverableDetailScreen`.
 */
export function DeliverablesScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: DeliverablesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useDeliverablesT();
  const queryKey = deliverablesQueryKey(organizationSlug, projectId);

  const deliverables = useQuery({
    queryKey,
    queryFn: () => listDeliverables(api, organizationSlug, projectId),
  });

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const create = useMutation({
    mutationFn: () =>
      createDeliverable(api, organizationSlug, {
        projectId,
        title: title.trim(),
        description: description.trim() === '' ? null : description.trim(),
      }),
    onSuccess: () => {
      setTitle('');
      setDescription('');
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const canSubmit = title.trim() !== '' && !create.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={t('Deliverables.title')}
      description={t('Deliverables.description')}
      eyebrow={t('Deliverables.eyebrow')}
      topBar={<ProjectTabs organizationSlug={organizationSlug} projectId={projectId} />}
    >
      <div className="tm-prj tm-prj--sub">
        <div className="tm-prj__grid tm-prj__grid--aside">
          <div className="tm-prj__col">
            <section className="tm-card tm-prj-card" aria-labelledby="tm-deliverables-list">
              <h2 id="tm-deliverables-list" className="tm-prj-eyebrow">
                {t('Deliverables.listHeading')}
              </h2>
              {deliverables.isError ? (
                <InlineAlert tone="danger" title={t('Deliverables.loadFailed')} live>
                  {describeDeliverableError(deliverables.error, t)}
                </InlineAlert>
              ) : deliverables.isPending ? (
                <LoadingRegion label={t('Deliverables.loading')}>
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : (deliverables.data ?? []).length === 0 ? (
                <p className="tm-prose">{t('Deliverables.empty')}</p>
              ) : (
                <ul className="tm-list tm-stack">
                  {(deliverables.data ?? []).map((deliverable) => (
                    <DeliverableRow
                      key={deliverable.id}
                      deliverable={deliverable}
                      href={`/${organizationSlug}/projects/${encodeURIComponent(projectId)}/deliverables/${encodeURIComponent(deliverable.id)}`}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>
          <div className="tm-prj__col tm-prj__col--aside">
            <section className="tm-card tm-prj-card" aria-labelledby="tm-deliverables-new">
              <h2 id="tm-deliverables-new" className="tm-prj-eyebrow">
                {t('Deliverables.newHeading')}
              </h2>
              <form
                className="tm-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canSubmit) create.mutate();
                }}
              >
                <Field
                  label={t('Deliverables.titleLabel')}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={300}
                  required
                />
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-deliverable-description">
                    {t('Deliverables.descriptionLabel')}
                  </label>
                  <textarea
                    id="tm-deliverable-description"
                    className="tm-field__control"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={5000}
                    rows={3}
                  />
                </div>
                {create.isError ? (
                  <InlineAlert tone="danger" title={t('Deliverables.createFailed')} live>
                    {describeDeliverableError(create.error, t)}
                  </InlineAlert>
                ) : null}
                <div className="tm-row">
                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    disabled={!canSubmit}
                    loading={create.isPending}
                    loadingLabel={t('Deliverables.creating')}
                  >
                    {t('Deliverables.create')}
                  </Button>
                </div>
              </form>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function DeliverableRow({ deliverable, href }: { deliverable: DeliverableView; href: string }) {
  const t = useDeliverablesT();
  return (
    <li className="tm-stack tm-stack--tight">
      <div className="tm-row tm-row--wrap">
        <h3 className="tm-heading-3">
          <Link href={href}>{deliverable.title}</Link>
        </h3>
        {deliverable.latestVersionNo !== null ? (
          <span className="tm-meta-mono">v{deliverable.latestVersionNo}</span>
        ) : null}
        <StateCapsule state={stateCapsule(deliverable.state)} className="tm-push-end">
          {t(STATE_KEY[deliverable.state])}
        </StateCapsule>
      </div>
      {deliverable.description ? <p className="tm-prose">{deliverable.description}</p> : null}
      {deliverable.latestVersionNo === null ? (
        <p className="tm-field__hint">{t('Deliverables.noVersions')}</p>
      ) : null}
    </li>
  );
}
