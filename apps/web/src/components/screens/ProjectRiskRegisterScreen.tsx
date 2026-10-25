'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import {
  createProjectInternalRisk,
  listProjectInternalRisks,
  updateProjectInternalRisk,
} from '../../lib/api/project-risk-register';
import type {
  ProjectInternalRiskImpact,
  ProjectInternalRiskLikelihood,
  ProjectInternalRiskSeverity,
  ProjectInternalRiskStatus,
  ProjectInternalRiskSummary,
} from '../../lib/api/project-risk-register';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface ProjectRiskRegisterScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The project whose risk register this screen shows — from the `[projectId]` route segment. */
  projectId: string;
  client?: ApiClient;
}

const LEVEL_KEY = {
  low: 'ProjectRiskRegisterScreen.levelLow',
  medium: 'ProjectRiskRegisterScreen.levelMedium',
  high: 'ProjectRiskRegisterScreen.levelHigh',
} as const;

const STATUS_KEY = {
  open: 'ProjectRiskRegisterScreen.statusOpen',
  mitigating: 'ProjectRiskRegisterScreen.statusMitigating',
  mitigated: 'ProjectRiskRegisterScreen.statusMitigated',
  closed: 'ProjectRiskRegisterScreen.statusClosed',
} as const;

const AXES: readonly ('low' | 'medium' | 'high')[] = ['low', 'medium', 'high'];
const STATUSES: readonly ProjectInternalRiskStatus[] = [
  'open',
  'mitigating',
  'mitigated',
  'closed',
];

/**
 * **Project internal risk register (x209).**
 *
 * `38-MODULE-MAP` §Projects & portfolio: a project's internal risks on a likelihood×impact matrix.
 * This screen logs a risk — a title, a likelihood, an impact and a mitigation plan — lists the
 * project's risks in creation order with their computed severity, and moves each through its
 * lifecycle status. It reads `GET …/projects/:id/risk-register` and writes `POST …/risk-register` and
 * `PATCH …/risk-register/:riskId`, gated on the server by `project.manage` (writes) and `work.read`
 * (list).
 *
 * This is the **internal** register, distinct from the client portal risks: it is never shown to a
 * client. As on the sibling screens, **authorization is the API's**: a caller without the capability
 * gets the ordinary refusal, which `describeError()` turns into a sentence.
 */
export function ProjectRiskRegisterScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: ProjectRiskRegisterScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const [title, setTitle] = useState('');
  const [likelihood, setLikelihood] = useState<ProjectInternalRiskLikelihood>('medium');
  const [impact, setImpact] = useState<ProjectInternalRiskImpact>('medium');
  const [mitigation, setMitigation] = useState('');

  const risks = useQuery({
    queryKey: ['project-internal-risks', organizationSlug, projectId],
    queryFn: () => listProjectInternalRisks(api, organizationSlug, projectId),
  });

  async function refetch() {
    await queryClient.invalidateQueries({
      queryKey: ['project-internal-risks', organizationSlug, projectId],
    });
  }

  const create = useMutation({
    mutationFn: () =>
      createProjectInternalRisk(api, organizationSlug, projectId, {
        title: title.trim(),
        likelihood,
        impact,
        ...(mitigation.trim() === '' ? {} : { mitigation: mitigation.trim() }),
      }),
    onSuccess: async () => {
      setTitle('');
      setLikelihood('medium');
      setImpact('medium');
      setMitigation('');
      await refetch();
    },
  });

  const changeStatus = useMutation({
    mutationFn: (vars: { riskId: string; status: ProjectInternalRiskStatus }) =>
      updateProjectInternalRisk(api, organizationSlug, projectId, vars.riskId, {
        status: vars.status,
      }),
    onSuccess: refetch,
  });

  const rows = useMemo(() => risks.data ?? [], [risks.data]);
  const canSubmit = title.trim() !== '';

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
      title={t('ProjectRiskRegisterScreen.title')}
      description={t('ProjectRiskRegisterScreen.description')}
      eyebrow={t('ProjectRiskRegisterScreen.eyebrow')}
      topBar={
        <ProjectTabs organizationSlug={organizationSlug} projectId={projectId} current="risks" />
      }
    >
      <div className="tm-prj tm-prj--sub">
        <div className="tm-prj__grid tm-prj__grid--aside">
          <div className="tm-prj__col tm-prj__col--aside">
            <section className="tm-card tm-prj-card" aria-labelledby="tm-risk-author">
              <h2 id="tm-risk-author" className="tm-prj-eyebrow">
                {t('ProjectRiskRegisterScreen.logARisk')}
              </h2>
              <form className="tm-stack" onSubmit={onSubmit} noValidate>
                <fieldset
                  className="tm-fieldset tm-stack tm-stack--loose"
                  disabled={create.isPending}
                >
                  <Field
                    label={t('ProjectRiskRegisterScreen.riskLabel')}
                    name="title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    hint={t('ProjectRiskRegisterScreen.riskHint')}
                    required
                  />

                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-risk-likelihood">
                      {t('ProjectRiskRegisterScreen.likelihood')}
                    </label>
                    <select
                      id="tm-risk-likelihood"
                      name="likelihood"
                      className="tm-field__control"
                      value={likelihood}
                      onChange={(event) =>
                        setLikelihood(event.target.value as ProjectInternalRiskLikelihood)
                      }
                    >
                      {AXES.map((value) => (
                        <option key={value} value={value}>
                          {t(LEVEL_KEY[value])}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-risk-impact">
                      {t('ProjectRiskRegisterScreen.impact')}
                    </label>
                    <select
                      id="tm-risk-impact"
                      name="impact"
                      className="tm-field__control"
                      value={impact}
                      onChange={(event) =>
                        setImpact(event.target.value as ProjectInternalRiskImpact)
                      }
                    >
                      {AXES.map((value) => (
                        <option key={value} value={value}>
                          {t(LEVEL_KEY[value])}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-risk-mitigation">
                      {t('ProjectRiskRegisterScreen.mitigation')}
                    </label>
                    <textarea
                      id="tm-risk-mitigation"
                      name="mitigation"
                      className="tm-field__control tm-field__control--multiline"
                      rows={3}
                      value={mitigation}
                      onChange={(event) => setMitigation(event.target.value)}
                      aria-describedby="tm-risk-mitigation-hint"
                    />
                    <span className="tm-field__hint" id="tm-risk-mitigation-hint">
                      {t('ProjectRiskRegisterScreen.mitigationHint')}
                    </span>
                  </div>
                </fieldset>

                {create.isError ? (
                  <InlineAlert tone="danger" title={t('ProjectRiskRegisterScreen.logFailed')} live>
                    {describeError(create.error)}
                  </InlineAlert>
                ) : null}

                <div className="tm-row">
                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    loading={create.isPending}
                    loadingLabel={t('ProjectRiskRegisterScreen.saving')}
                    disabled={!canSubmit}
                  >
                    {t('ProjectRiskRegisterScreen.logRisk')}
                  </Button>
                </div>
              </form>
            </section>
          </div>
          <div className="tm-prj__col">
            {risks.isError ? (
              <InlineAlert tone="danger" title={t('ProjectRiskRegisterScreen.loadFailed')} live>
                {describeError(risks.error)}
              </InlineAlert>
            ) : null}

            {risks.isPending ? (
              <LoadingRegion label={t('ProjectRiskRegisterScreen.loading')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {!risks.isPending && !risks.isError && rows.length === 0 ? (
              <InlineAlert tone="neutral" title={t('ProjectRiskRegisterScreen.emptyTitle')}>
                {t('ProjectRiskRegisterScreen.emptyBody')}
              </InlineAlert>
            ) : null}

            {rows.length > 0 ? <SeverityMatrix rows={rows} /> : null}

            {rows.length > 0 && changeStatus.isError ? (
              <InlineAlert tone="danger" title={t('ProjectRiskRegisterScreen.updateFailed')} live>
                {describeError(changeStatus.error)}
              </InlineAlert>
            ) : null}

            {rows.length > 0 ? (
              <section className="tm-card tm-prj-card" aria-labelledby="tm-risks-heading">
                <h2 id="tm-risks-heading" className="tm-prj-eyebrow">
                  {t('ProjectRiskRegisterScreen.risks')}
                </h2>
                <div
                  className="tm-table-scroll"
                  // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
                  // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                  tabIndex={0}
                  role="region"
                  aria-label={t('ProjectRiskRegisterScreen.tableLabel')}
                >
                  <table className="tm-table">
                    <caption className="tm-visually-hidden">
                      {t('ProjectRiskRegisterScreen.captionPrefix')}
                      {rows.length}
                      {t('ProjectRiskRegisterScreen.captionSuffix')}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('ProjectRiskRegisterScreen.colRisk')}</th>
                        <th scope="col">{t('ProjectRiskRegisterScreen.likelihood')}</th>
                        <th scope="col">{t('ProjectRiskRegisterScreen.impact')}</th>
                        <th scope="col">{t('ProjectRiskRegisterScreen.severity')}</th>
                        <th scope="col">{t('ProjectRiskRegisterScreen.status')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((risk) => (
                        <RiskRow
                          key={risk.id}
                          risk={risk}
                          onStatus={(status) => changeStatus.mutate({ riskId: risk.id, status })}
                          busy={changeStatus.isPending}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/** A compact count of risks by computed severity band — the register's headline. */
function SeverityMatrix({ rows }: { rows: readonly ProjectInternalRiskSummary[] }) {
  const t = useT();
  const counts = useMemo(() => {
    const tally: Record<ProjectInternalRiskSeverity, number> = { low: 0, medium: 0, high: 0 };
    for (const risk of rows) tally[risk.severity] += 1;
    return tally;
  }, [rows]);

  return (
    <section className="tm-card tm-prj-card" aria-labelledby="tm-risk-matrix-heading">
      <h2 id="tm-risk-matrix-heading" className="tm-prj-eyebrow">
        {t('ProjectRiskRegisterScreen.severity')}
      </h2>
      <dl className="tm-row">
        {(['high', 'medium', 'low'] as const).map((band) => (
          <div key={band} className="tm-stat">
            <dt className="tm-field__hint">{t(LEVEL_KEY[band])}</dt>
            <dd className="tm-stat__value">{counts[band]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function RiskRow({
  risk,
  onStatus,
  busy,
}: {
  risk: ProjectInternalRiskSummary;
  onStatus: (status: ProjectInternalRiskStatus) => void;
  busy: boolean;
}) {
  const t = useT();
  return (
    <tr>
      <th scope="row" className="tm-table__title">
        {risk.title}
        {risk.mitigation ? <span className="tm-field__hint">{risk.mitigation}</span> : null}
      </th>
      <td>{t(LEVEL_KEY[risk.likelihood])}</td>
      <td>{t(LEVEL_KEY[risk.impact])}</td>
      <td>{t(LEVEL_KEY[risk.severity])}</td>
      <td>
        <div className="tm-field">
          <label className="tm-visually-hidden" htmlFor={`tm-risk-status-${risk.id}`}>
            {t('ProjectRiskRegisterScreen.statusForPrefix')}
            {risk.title}
          </label>
          <select
            id={`tm-risk-status-${risk.id}`}
            className="tm-field__control"
            value={risk.status}
            disabled={busy}
            onChange={(event) => onStatus(event.target.value as ProjectInternalRiskStatus)}
          >
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(STATUS_KEY[value])}
              </option>
            ))}
          </select>
        </div>
      </td>
    </tr>
  );
}
