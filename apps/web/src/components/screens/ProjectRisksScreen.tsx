'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { createProjectRisk, listProjectRisks } from '../../lib/api/portal';
import type { ProjectRisk, RiskSeverity, RiskStatus } from '../../lib/api/portal';
import { PORTAL_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectRisksScreenProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  client?: ApiClient;
}

const SEVERITIES: readonly RiskSeverity[] = ['low', 'medium', 'high'];
const STATUSES: readonly RiskStatus[] = ['open', 'mitigated', 'closed'];

const SEVERITY_KEY = {
  low: 'ProjectRisksScreen.severityLow',
  medium: 'ProjectRisksScreen.severityMedium',
  high: 'ProjectRisksScreen.severityHigh',
} as const;

const STATUS_KEY = {
  open: 'ProjectRisksScreen.statusOpen',
  mitigated: 'ProjectRisksScreen.statusMitigated',
  closed: 'ProjectRisksScreen.statusClosed',
} as const;

/**
 * **Project risks — internal compose (x140).**
 *
 * The internal half of SEC / Portal risks: a manager records a risk against a project and reads the
 * full register back, including the `internalNote` — the substance the client never sees. The compose
 * form separates the two audiences explicitly: `clientSummary` is the text the client is shown, and
 * `internalNote` is labelled internal-only, so the boundary the API enforces is visible in the UI.
 *
 * On the internal `projects` path behind `project.manage`; a client principal never reaches it. The
 * published client-facing view is `PortalRisksScreen`, on `/portal`.
 */
export function ProjectRisksScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: ProjectRisksScreenProps) {
  const describe = useDescribeApiError(PORTAL_LINES);
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const risks = useQuery({
    queryKey: ['project-risks', organizationSlug, projectId],
    queryFn: () => listProjectRisks(api, organizationSlug, projectId),
  });

  const [title, setTitle] = useState('');
  const [clientSummary, setClientSummary] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [severity, setSeverity] = useState<RiskSeverity>('medium');
  const [status, setStatus] = useState<RiskStatus>('open');
  const [published, setPublished] = useState(true);

  const create = useMutation({
    mutationFn: () =>
      createProjectRisk(api, organizationSlug, projectId, {
        title: title.trim(),
        clientSummary: clientSummary.trim(),
        internalNote: internalNote.trim() === '' ? null : internalNote.trim(),
        severity,
        status,
        published,
      }),
    onSuccess: () => {
      setTitle('');
      setClientSummary('');
      setInternalNote('');
      setSeverity('medium');
      setStatus('open');
      setPublished(true);
      void queryClient.invalidateQueries({
        queryKey: ['project-risks', organizationSlug, projectId],
      });
    },
  });

  const canSubmit = title.trim() !== '' && clientSummary.trim() !== '' && !create.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={t('ProjectRisksScreen.title')}
      description={t('ProjectRisksScreen.description')}
      eyebrow={t('ProjectRisksScreen.eyebrow')}
      topBar={
        <ProjectTabs organizationSlug={organizationSlug} projectId={projectId} current="risks" />
      }
    >
      <div className="tm-prj tm-prj--sub">
        <div className="tm-prj__grid tm-prj__grid--aside">
          <div className="tm-prj__col tm-prj__col--aside">
            <section className="tm-card tm-prj-card" aria-labelledby="tm-risks-compose">
              <h2 id="tm-risks-compose" className="tm-prj-eyebrow">
                {t('ProjectRisksScreen.recordARisk')}
              </h2>
              <form
                className="tm-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canSubmit) create.mutate();
                }}
              >
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-risk-title">
                    {t('ProjectRisksScreen.internalTitle')}
                  </label>
                  <input
                    id="tm-risk-title"
                    className="tm-field__control"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={300}
                    required
                  />
                  <p className="tm-field__hint">{t('ProjectRisksScreen.internalTitleHint')}</p>
                </div>

                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-risk-client-summary">
                    {t('ProjectRisksScreen.clientSummary')}
                  </label>
                  <textarea
                    id="tm-risk-client-summary"
                    className="tm-field__control"
                    value={clientSummary}
                    onChange={(event) => setClientSummary(event.target.value)}
                    maxLength={2000}
                    rows={3}
                    required
                  />
                  <p className="tm-field__hint">{t('ProjectRisksScreen.clientSummaryHint')}</p>
                </div>

                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-risk-internal-note">
                    {t('ProjectRisksScreen.internalNote')}
                  </label>
                  <textarea
                    id="tm-risk-internal-note"
                    className="tm-field__control"
                    value={internalNote}
                    onChange={(event) => setInternalNote(event.target.value)}
                    maxLength={5000}
                    rows={3}
                  />
                  <p className="tm-field__hint">{t('ProjectRisksScreen.internalNoteHint')}</p>
                </div>

                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-risk-severity">
                    {t('ProjectRisksScreen.severity')}
                  </label>
                  <select
                    id="tm-risk-severity"
                    className="tm-field__control"
                    value={severity}
                    onChange={(event) => setSeverity(event.target.value as RiskSeverity)}
                  >
                    {SEVERITIES.map((value) => (
                      <option key={value} value={value}>
                        {t(SEVERITY_KEY[value])}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-risk-status">
                    {t('ProjectRisksScreen.status')}
                  </label>
                  <select
                    id="tm-risk-status"
                    className="tm-field__control"
                    value={status}
                    onChange={(event) => setStatus(event.target.value as RiskStatus)}
                  >
                    {STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {t(STATUS_KEY[value])}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="tm-choice tm-choice--inline">
                  <input
                    className="tm-choice__input"
                    type="checkbox"
                    checked={published}
                    onChange={(event) => setPublished(event.target.checked)}
                  />
                  <span className="tm-choice__name">{t('ProjectRisksScreen.publishNow')}</span>
                </label>

                {create.isError ? (
                  <InlineAlert tone="danger" title={t('ProjectRisksScreen.recordFailed')} live>
                    {describe(create.error)}
                  </InlineAlert>
                ) : null}

                <div className="tm-row">
                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    disabled={!canSubmit}
                    loading={create.isPending}
                    loadingLabel={t('ProjectRisksScreen.recording')}
                  >
                    {t('ProjectRisksScreen.recordRisk')}
                  </Button>
                </div>
              </form>
            </section>
          </div>
          <div className="tm-prj__col">
            <section className="tm-card tm-prj-card" aria-labelledby="tm-risks-list">
              <h2 id="tm-risks-list" className="tm-prj-eyebrow">
                {t('ProjectRisksScreen.recordedRisks')}
              </h2>
              {risks.isError ? (
                <InlineAlert tone="danger" title={t('ProjectRisksScreen.loadFailed')} live>
                  {describe(risks.error)}
                </InlineAlert>
              ) : risks.isPending ? (
                <LoadingRegion label={t('ProjectRisksScreen.loading')}>
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : (risks.data ?? []).length === 0 ? (
                <p className="tm-prose">{t('ProjectRisksScreen.empty')}</p>
              ) : (
                <ol className="tm-list tm-stack">
                  {(risks.data ?? []).map((risk) => (
                    <RiskRow key={risk.id} risk={risk} />
                  ))}
                </ol>
              )}
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function RiskRow({ risk }: { risk: ProjectRisk }) {
  const t = useT();
  return (
    <li className="tm-stack tm-stack--tight">
      <div className="tm-row tm-row--wrap">
        <h3 className="tm-heading-3">{risk.title}</h3>
        <StateCapsule state={severityCapsule(risk.severity)}>
          {t(SEVERITY_KEY[risk.severity])}
        </StateCapsule>
        <StateCapsule state={statusCapsule(risk.status)}>{t(STATUS_KEY[risk.status])}</StateCapsule>
        <StateCapsule state={risk.published ? 'client' : 'neutral'} className="tm-push-end">
          {risk.published ? t('ProjectRisksScreen.published') : t('ProjectRisksScreen.draft')}
        </StateCapsule>
      </div>
      <p className="tm-prose">{risk.clientSummary}</p>
      {risk.internalNote ? (
        <p className="tm-field__hint">
          {t('ProjectRisksScreen.internalPrefix')}
          {risk.internalNote}
        </p>
      ) : null}
    </li>
  );
}

function severityCapsule(severity: RiskSeverity): CapsuleState {
  switch (severity) {
    case 'high':
      return 'blocked';
    case 'low':
      return 'neutral';
    default:
      return 'waiting';
  }
}

function statusCapsule(status: RiskStatus): CapsuleState {
  switch (status) {
    case 'mitigated':
      return 'current';
    case 'closed':
      return 'done';
    default:
      return 'future';
  }
}
