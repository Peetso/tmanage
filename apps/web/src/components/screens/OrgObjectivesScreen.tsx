'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { KeyResultsScreen } from './KeyResultsScreen';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createOrgObjective,
  listOrgObjectives,
  transitionOrgObjective,
} from '../../lib/api/org-objectives';
import type {
  OrgObjectiveOutcome,
  OrgObjectiveStatus,
  OrgObjectiveSummary,
} from '../../lib/api/org-objectives';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import '../../styles/screens/portfolio.css';

export interface OrgObjectivesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const STATUS_LABEL_KEYS: Readonly<Record<OrgObjectiveStatus, MessageKey>> = {
  open: 'OrgObjectivesScreen.statusOpen',
  met: 'OrgObjectivesScreen.statusMet',
  missed: 'OrgObjectivesScreen.statusMissed',
};

/**
 * **Organization objectives / OKRs (x136) — OBJ-01 hub and OBJ-02 detail.**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Projects: the objectives the whole organization is working
 * toward — the org-level counterpart of `ProjectObjectivesScreen` (x124), with no project. The hub
 * lists the organization's objectives in creation order as OBJ-01 cards (name, a status capsule that
 * carries a word, the target as the card's figure, the description as its evidence line) and closes
 * each open one as `met` or `missed`. Choosing a card opens it as OBJ-02 beside the hub: the
 * description, target and status, and its key results (x207). A dashed card at the foot of the hub
 * sets a new objective. It reads `GET …/objectives` and writes `POST …/objectives` and
 * `PATCH …/objectives/:id`, gated on the server by `project.manage` (writes) and `work.read` (list).
 *
 * As on the sibling work/decision screens, **authorization is the API's**: a caller without the
 * capability gets the ordinary refusal, which `describeError()` turns into a sentence; the screen
 * never guesses a capability of its own and never renders blank on a refusal.
 */
export function OrgObjectivesScreen({
  organizationSlug,
  organizationName,
  client,
}: OrgObjectivesScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const objectives = useQuery({
    queryKey: ['org-objectives', organizationSlug],
    queryFn: () => listOrgObjectives(api, organizationSlug),
  });

  async function refetch() {
    await queryClient.invalidateQueries({
      queryKey: ['org-objectives', organizationSlug],
    });
  }

  const create = useMutation({
    mutationFn: () =>
      createOrgObjective(api, organizationSlug, {
        name: name.trim(),
        ...(description.trim() === '' ? {} : { description: description.trim() }),
        ...(target.trim() === '' ? {} : { target: target.trim() }),
      }),
    onSuccess: async () => {
      setName('');
      setDescription('');
      setTarget('');
      await refetch();
    },
  });

  const transition = useMutation({
    mutationFn: (vars: { objectiveId: string; status: OrgObjectiveOutcome }) =>
      transitionOrgObjective(api, organizationSlug, vars.objectiveId, vars.status),
    onSuccess: refetch,
  });

  const rows = useMemo(() => objectives.data ?? [], [objectives.data]);
  const canSubmit = name.trim() !== '';
  const openCount = rows.filter((objective) => objective.status === 'open').length;
  // OBJ-02 shows the chosen objective; before a choice, the first open one (else the first).
  const selected =
    rows.find((objective) => objective.id === selectedId) ??
    rows.find((objective) => objective.status === 'open') ??
    rows[0] ??
    null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || create.isPending) return;
    create.mutate();
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      eyebrow={
        rows.length > 0
          ? `${t('OrgObjectivesScreen.objectives')} · ${openCount} ${t('OrgObjectivesScreen.openOf')} ${rows.length}`
          : t('OrgObjectivesScreen.objectives')
      }
      title={t('OrgObjectivesScreen.title')}
    >
      {objectives.isError ? (
        <InlineAlert tone="danger" title={t('OrgObjectivesScreen.loadError')} live>
          {describeError(objectives.error)}
        </InlineAlert>
      ) : null}

      <div className="tm-obj">
        <div className="tm-obj__hub">
          {objectives.isPending ? (
            <LoadingRegion label={t('OrgObjectivesScreen.loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!objectives.isPending && !objectives.isError && rows.length === 0 ? (
            <InlineAlert tone="neutral" title={t('OrgObjectivesScreen.emptyTitle')}>
              {t('OrgObjectivesScreen.emptyBody')}
            </InlineAlert>
          ) : null}

          {rows.length > 0 && transition.isError ? (
            <InlineAlert tone="danger" title={t('OrgObjectivesScreen.updateError')} live>
              {describeError(transition.error)}
            </InlineAlert>
          ) : null}

          {rows.length > 0 ? (
            <section aria-labelledby="tm-org-objectives-heading">
              <h2 id="tm-org-objectives-heading" className="tm-visually-hidden">
                {t('OrgObjectivesScreen.objectives')}
              </h2>
              <ul className="tm-obj__list" aria-labelledby="tm-org-objectives-heading">
                {rows.map((objective) => (
                  <li key={objective.id}>
                    <ObjectiveCard
                      objective={objective}
                      selected={selected?.id === objective.id}
                      onSelect={() => setSelectedId(objective.id)}
                      onTransition={(status) =>
                        transition.mutate({ objectiveId: objective.id, status })
                      }
                      busy={transition.isPending}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section
            className="tm-card tm-card--empty tm-obj-compose"
            aria-labelledby="tm-org-objectives-author"
          >
            <details className="tm-obj-compose__toggle" open={rows.length === 0 ? true : undefined}>
              <summary>
                <h2 id="tm-org-objectives-author" className="tm-obj-eyebrow">
                  {t('OrgObjectivesScreen.setAnObjective')}
                </h2>
              </summary>
              <form className="tm-stack" onSubmit={onSubmit} noValidate>
                <fieldset className="tm-fieldset tm-stack" disabled={create.isPending}>
                  <Field
                    label={t('OrgObjectivesScreen.objectiveLabel')}
                    name="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    hint={t('OrgObjectivesScreen.objectiveHint')}
                    required
                  />

                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-org-objective-description">
                      {t('OrgObjectivesScreen.descriptionLabel')}
                    </label>
                    <textarea
                      id="tm-org-objective-description"
                      name="description"
                      className="tm-field__control tm-field__control--multiline"
                      rows={3}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      aria-describedby="tm-org-objective-description-hint"
                    />
                    <span className="tm-field__hint" id="tm-org-objective-description-hint">
                      {t('OrgObjectivesScreen.descriptionHint')}
                    </span>
                  </div>

                  <Field
                    label={t('OrgObjectivesScreen.targetLabel')}
                    name="target"
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    hint={t('OrgObjectivesScreen.targetHint')}
                  />
                </fieldset>

                {create.isError ? (
                  <InlineAlert tone="danger" title={t('OrgObjectivesScreen.setError')} live>
                    {describeError(create.error)}
                  </InlineAlert>
                ) : null}

                <div className="tm-row">
                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    loading={create.isPending}
                    loadingLabel={t('OrgObjectivesScreen.saving')}
                    disabled={!canSubmit}
                  >
                    {t('OrgObjectivesScreen.setObjective')}
                  </Button>
                </div>
              </form>
            </details>
          </section>
        </div>

        {selected ? (
          <ObjectiveDetail
            key={selected.id}
            organizationSlug={organizationSlug}
            objective={selected}
            {...(client ? { client } : {})}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

function ObjectiveCard({
  objective,
  selected,
  onSelect,
  onTransition,
  busy,
}: {
  objective: OrgObjectiveSummary;
  selected: boolean;
  onSelect: () => void;
  onTransition: (status: OrgObjectiveOutcome) => void;
  busy: boolean;
}) {
  const t = useT();
  return (
    <article
      className="tm-card tm-obj-card"
      data-selected={selected ? 'true' : undefined}
      aria-labelledby={`tm-org-objective-${objective.id}`}
    >
      <div className="tm-obj-card__top">
        <h3 id={`tm-org-objective-${objective.id}`} className="tm-obj-card__title">
          <button
            type="button"
            className="tm-obj-card__select"
            aria-pressed={selected}
            onClick={onSelect}
          >
            {objective.name}
          </button>
        </h3>
        <StatusPill status={objective.status} />
      </div>

      {objective.target || objective.description ? (
        <div className="tm-obj-card__body">
          {objective.target ? (
            <div className="tm-obj-card__metric">
              <span className="tm-obj-card__value">{objective.target}</span>
              <span className="tm-obj-card__label">{t('OrgObjectivesScreen.targetWord')}</span>
            </div>
          ) : null}
          {objective.target && objective.description ? (
            <span className="tm-obj-card__rule" aria-hidden="true" />
          ) : null}
          {objective.description ? (
            <p className="tm-obj-card__text">{objective.description}</p>
          ) : null}
        </div>
      ) : null}

      {objective.status === 'open' ? (
        <div className="tm-obj-card__actions">
          <Button
            type="button"
            tone="ink"
            size="compact"
            onClick={() => onTransition('met')}
            disabled={busy}
          >
            {t('OrgObjectivesScreen.markMet')}
          </Button>
          <Button
            type="button"
            tone="outline"
            size="compact"
            onClick={() => onTransition('missed')}
            disabled={busy}
          >
            {t('OrgObjectivesScreen.markMissed')}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function ObjectiveDetail({
  organizationSlug,
  objective,
  client,
}: {
  organizationSlug: string;
  objective: OrgObjectiveSummary;
  client?: ApiClient;
}) {
  const t = useT();
  return (
    <section className="tm-obj__detail" aria-labelledby="tm-org-objective-detail">
      <div>
        <p className="tm-obj-eyebrow">{t('OrgObjectivesScreen.objectiveDetail')}</p>
        <h2 id="tm-org-objective-detail" className="tm-obj-detail__title">
          {objective.name}
        </h2>
      </div>

      <div className="tm-card tm-obj-detail__card">
        <p className="tm-obj-detail__prose">
          {objective.description ?? t('OrgObjectivesScreen.noDescription')}
        </p>
        <div className="tm-obj-detail__rule" aria-hidden="true" />
        <dl className="tm-obj-detail__stats">
          <div>
            <dt>{t('OrgObjectivesScreen.targetLabel')}</dt>
            <dd className="tm-obj-detail__figure">{objective.target ?? '—'}</dd>
          </div>
          <div>
            <dt>{t('OrgObjectivesScreen.statusWord')}</dt>
            <dd>
              <StatusPill status={objective.status} />
            </dd>
          </div>
        </dl>
      </div>

      <KeyResultsScreen
        organizationSlug={organizationSlug}
        objectiveId={objective.id}
        objectiveName={objective.name}
        {...(client ? { client } : {})}
      />
    </section>
  );
}

function StatusPill({ status }: { status: OrgObjectiveStatus }) {
  const t = useT();
  return (
    <span className="tm-obj-pill" data-status={status}>
      {t(STATUS_LABEL_KEYS[status])}
    </span>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
