'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { useSelectedPortalProject } from '../shell/PortalProjectSwitcher';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalProjects, listPortalRisks } from '../../lib/api/portal';
import type { ClientRisk, RiskSeverity, RiskStatus } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { shortDay, Tag } from './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState } from '../help/TeachingEmptyState';

type Translate = ReturnType<typeof useT>;

export interface PortalRisksScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **Risks** — the risks the studio published to the client, in the handoff's portal language.
 *
 * `12-PERMISSION-MATRIX` §4 gives the client the "published risk" summary, its severity and its
 * status, which is exactly `clientSummary`, `severity` and `status`; there is no internal note and
 * no title. The design has no frame of its own for this destination — CL-04 carries risk in its
 * inverted "what would put the launch at risk" card — so the most serious open risk leads in that
 * card here, and every published risk follows as a capsule card.
 */
export function PortalRisksScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: PortalRisksScreenProps) {
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const t = useT();

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const project = useSelectedPortalProject(projects.data);
  const projectId = project?.id;

  const risks = useQuery({
    queryKey: ['portal-risks', organizationSlug, projectId],
    queryFn: () => listPortalRisks(api, organizationSlug, projectId!),
    enabled: projectId != null,
  });

  const rows = risks.data ?? [];
  const open = rows.filter((risk) => risk.status === 'open');

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="risks"
      title={
        risks.isSuccess
          ? open.length === 0
            ? t('PortalRisksScreen.nothingThreatens')
            : open.length === 1
              ? t('PortalRisksScreen.oneThingToWatch')
              : `${open.length} ${t('PortalRisksScreen.thingsToWatchSuffix')}`
          : t('PortalRisksScreen.risks')
      }
      eyebrow={
        project ? `${t('PortalRisksScreen.risks')} · ${project.name}` : t('PortalRisksScreen.risks')
      }
    >
      <div className="tm-pt tm-pt--compact">
        {projects.isError ? (
          <InlineAlert tone="danger" title={t('PortalRisksScreen.couldNotLoadPortal')} live>
            {describe(projects.error, t)}
          </InlineAlert>
        ) : null}

        {projects.isPending ? (
          <LoadingRegion label={t('PortalRisksScreen.loadingProject')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : (
          <RisksSection
            organizationSlug={organizationSlug}
            providerName={providerName}
            risks={rows}
            isPending={risks.isPending && projectId != null}
            isError={risks.isError}
            error={risks.error}
            hasProject={projectId != null}
            t={t}
          />
        )}
      </div>
    </ClientPortalShell>
  );
}

interface RisksSectionProps {
  organizationSlug: string;
  providerName: string;
  risks: readonly ClientRisk[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  hasProject: boolean;
  t: Translate;
}

function RisksSection({
  organizationSlug,
  providerName,
  risks,
  isPending,
  isError,
  error,
  hasProject,
  t,
}: RisksSectionProps) {
  if (!hasProject) {
    return (
      <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
        {t('PortalRisksScreen.noProjectLead')} {providerName} {t('PortalRisksScreen.noProjectTail')}
      </p>
    );
  }
  if (isError) {
    return (
      <InlineAlert tone="danger" title={t('PortalRisksScreen.couldNotLoadRisks')} live>
        {describe(error, t)}
      </InlineAlert>
    );
  }
  if (isPending) {
    return (
      <LoadingRegion label={t('PortalRisksScreen.loadingRisks')}>
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  }

  const ordered = [...risks].sort(
    (a, b) =>
      statusWeight(a.status) - statusWeight(b.status) || weight(b.severity) - weight(a.severity),
  );
  const lead = ordered.find((risk) => risk.status === 'open');

  return (
    <div className="tm-pt-split tm-pt-split--aside tm-pt-split--wide">
      <section className="tm-pt-col" aria-labelledby="tm-portal-risks">
        <h2 id="tm-portal-risks" className="tm-pt-eyebrow">
          {t('PortalRisksScreen.sharedByHeading')} {providerName} · {risks.length}{' '}
          {risks.length === 1
            ? t('PortalRisksScreen.riskSingular')
            : t('PortalRisksScreen.riskPlural')}
        </h2>
        {risks.length === 0 ? (
          <TeachingEmptyState
            title={t('teachEmpty.portalRisksTitle')}
            explanation={t('teachEmpty.portalRisksBody').replace('{studio}', providerName)}
          />
        ) : (
          <ul className="tm-pt-list">
            {ordered.map((risk) => (
              <li
                key={risk.id}
                className={risk === lead ? 'tm-pt-action tm-pt-action--lead' : 'tm-pt-action'}
              >
                <span className="tm-pt-action__orb" aria-hidden="true">
                  {risk.status === 'open' ? '!' : '✓'}
                </span>
                <div className="tm-pt-action__body">
                  <div className="tm-pt-action__meta">
                    <Tag tone={severityTone(risk.severity)}>
                      {severityLabel(risk.severity, t)} {t('PortalRisksScreen.severityWord')}
                    </Tag>
                    <Tag tone={risk.status === 'open' ? undefined : 'done'}>
                      {statusLabel(risk.status, t)}
                    </Tag>
                    <span className="tm-pt-mono">
                      {t('PortalRisksScreen.sharedWord')} {shortDay(risk.createdAt)}
                    </span>
                  </div>
                  <p className="tm-pt-action__title">{risk.clientSummary}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="tm-pt-ink tm-pt-ink--tall" aria-labelledby="tm-portal-risk-lead">
        <h2 id="tm-portal-risk-lead" className="tm-pt-eyebrow">
          {t('PortalRisksScreen.launchRiskHeading')}
        </h2>
        <p className="tm-pt-ink__title">
          {lead ? lead.clientSummary : t('PortalRisksScreen.nothingToday')}
        </p>
        <p className="tm-pt-quiet">
          {t('PortalRisksScreen.hearLead')} {providerName} {t('PortalRisksScreen.hearTail')}
        </p>
        <Link
          className="tm-pt-btn tm-pt-btn--lime tm-pt-ink__cta"
          href={`/${organizationSlug}/portal/timeline`}
        >
          {t('PortalRisksScreen.seeTheTimeline')}
        </Link>
      </section>
    </div>
  );
}

function weight(severity: RiskSeverity): number {
  return severity === 'high' ? 3 : severity === 'medium' ? 2 : 1;
}

function statusWeight(status: RiskStatus): number {
  return status === 'open' ? 0 : status === 'mitigated' ? 1 : 2;
}

function severityLabel(severity: RiskSeverity, t: Translate): string {
  switch (severity) {
    case 'high':
      return t('PortalRisksScreen.severityHigh');
    case 'low':
      return t('PortalRisksScreen.severityLow');
    default:
      return t('PortalRisksScreen.severityMedium');
  }
}

function severityTone(severity: RiskSeverity): 'danger' | 'warning' | undefined {
  switch (severity) {
    case 'high':
      return 'danger';
    case 'medium':
      return 'warning';
    default:
      return undefined;
  }
}

function statusLabel(status: RiskStatus, t: Translate): string {
  switch (status) {
    case 'mitigated':
      return t('PortalRisksScreen.statusMitigated');
    case 'closed':
      return t('PortalRisksScreen.statusClosed');
    default:
      return t('PortalRisksScreen.statusOpen');
  }
}

function describe(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('PortalRisksScreen.portalNotAnswering');
  return t('PortalRisksScreen.genericError');
}
