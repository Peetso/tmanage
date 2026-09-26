'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { createProjectRisk, listProjectRisks } from '../../lib/api/portal';
import type { ProjectRisk, RiskSeverity, RiskStatus } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectRisksScreenProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  client?: ApiClient;
}

const SEVERITIES: readonly RiskSeverity[] = ['low', 'medium', 'high'];
const STATUSES: readonly RiskStatus[] = ['open', 'mitigated', 'closed'];

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
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

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
      title="Project risks"
      description="Record a risk for this project, and choose what the client is told."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-risks-compose">
        <h2 id="tm-risks-compose" className="tm-eyebrow">
          Record a risk
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
              Internal title
            </label>
            <input
              id="tm-risk-title"
              className="tm-field__control"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={300}
              required
            />
            <p className="tm-field__hint">Staff-facing. The client never sees this.</p>
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-risk-client-summary">
              Client summary
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
            <p className="tm-field__hint">Shown to the client when this risk is published.</p>
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-risk-internal-note">
              Internal note (optional)
            </label>
            <textarea
              id="tm-risk-internal-note"
              className="tm-field__control"
              value={internalNote}
              onChange={(event) => setInternalNote(event.target.value)}
              maxLength={5000}
              rows={3}
            />
            <p className="tm-field__hint">Internal-only. Never projected to the client.</p>
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-risk-severity">
              Severity
            </label>
            <select
              id="tm-risk-severity"
              className="tm-field__control"
              value={severity}
              onChange={(event) => setSeverity(event.target.value as RiskSeverity)}
            >
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {severityLabel(value)}
                </option>
              ))}
            </select>
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-risk-status">
              Status
            </label>
            <select
              id="tm-risk-status"
              className="tm-field__control"
              value={status}
              onChange={(event) => setStatus(event.target.value as RiskStatus)}
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value)}
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
            <span className="tm-choice__name">Publish to the client now</span>
          </label>

          {create.isError ? (
            <InlineAlert tone="danger" title="Could not record the risk" live>
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
              loadingLabel="Recording"
            >
              Record risk
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-risks-list">
        <h2 id="tm-risks-list" className="tm-eyebrow">
          Recorded risks
        </h2>
        {risks.isError ? (
          <InlineAlert tone="danger" title="Could not load risks" live>
            {describe(risks.error)}
          </InlineAlert>
        ) : risks.isPending ? (
          <LoadingRegion label="Loading risks">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : (risks.data ?? []).length === 0 ? (
          <p className="tm-prose">No risks recorded for this project yet.</p>
        ) : (
          <ol className="tm-list tm-stack">
            {(risks.data ?? []).map((risk) => (
              <RiskRow key={risk.id} risk={risk} />
            ))}
          </ol>
        )}
      </section>
    </AppShell>
  );
}

function RiskRow({ risk }: { risk: ProjectRisk }) {
  return (
    <li className="tm-stack tm-stack--tight">
      <div className="tm-row tm-row--wrap">
        <h3 className="tm-heading-3">{risk.title}</h3>
        <StateCapsule state={severityCapsule(risk.severity)}>
          {severityLabel(risk.severity)}
        </StateCapsule>
        <StateCapsule state={statusCapsule(risk.status)}>{statusLabel(risk.status)}</StateCapsule>
        <StateCapsule state={risk.published ? 'client' : 'neutral'} className="tm-push-end">
          {risk.published ? 'Published' : 'Draft'}
        </StateCapsule>
      </div>
      <p className="tm-prose">{risk.clientSummary}</p>
      {risk.internalNote ? <p className="tm-field__hint">Internal: {risk.internalNote}</p> : null}
    </li>
  );
}

function severityLabel(severity: RiskSeverity): string {
  switch (severity) {
    case 'high':
      return 'High';
    case 'low':
      return 'Low';
    default:
      return 'Medium';
  }
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

function statusLabel(status: RiskStatus): string {
  switch (status) {
    case 'mitigated':
      return 'Mitigated';
    case 'closed':
      return 'Closed';
    default:
      return 'Open';
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

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
