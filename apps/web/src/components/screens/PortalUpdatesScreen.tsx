'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalMilestones, listPortalProjects, listPortalUpdates } from '../../lib/api/portal';
import type { ClientMilestone, PortalProject } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { longDay, shortDay, Tag } from './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';

type Translate = ReturnType<typeof useT>;

export interface PortalUpdatesScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **CL-11 Updates** — written narrative, not an activity log.
 *
 * The updates the studio wrote and published on the client's first shared project (CL-03's
 * `listPortalUpdates`; the API returns only `published` rows, newest first). Drawn as the
 * handoff's CL-11: the newest update in an ink-outlined card with the rest beneath it, and on the
 * right the inverted "where the project stands" card with the agreed date and estimate, then the
 * dates still ahead from the published milestones.
 *
 * The notification feed (`NOTIF-001`) is a different thing and lives at `/portal/inbox`; this
 * destination is the studio's own words.
 */
export function PortalUpdatesScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: PortalUpdatesScreenProps) {
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

  const project = projects.data?.[0];
  const projectId = project?.id;

  const updates = useQuery({
    queryKey: ['portal-updates', organizationSlug, projectId],
    queryFn: () => listPortalUpdates(api, organizationSlug, projectId!),
    enabled: projectId != null,
  });

  const milestones = useQuery({
    queryKey: ['portal-milestones', organizationSlug, projectId],
    queryFn: () => listPortalMilestones(api, organizationSlug, projectId!),
    enabled: projectId != null,
  });

  const rows = updates.data ?? [];

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="updates"
      title={t('PortalUpdatesScreen.title')}
      eyebrow={`${t('PortalUpdatesScreen.updatesWrittenBy')} ${providerName}`}
    >
      <div className="tm-pt tm-pt--compact">
        {projects.isError || updates.isError ? (
          <InlineAlert tone="danger" title={t('PortalUpdatesScreen.couldNotLoadUpdates')} live>
            {describe(projects.error ?? updates.error, t)}
          </InlineAlert>
        ) : null}

        {projects.isPending || (updates.isPending && projectId != null) ? (
          <LoadingRegion label={t('PortalUpdatesScreen.loadingUpdates')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        <div className="tm-pt-split tm-pt-split--aside">
          <section
            className="tm-pt-col"
            aria-label={`${t('PortalUpdatesScreen.updatesFrom')} ${providerName}`}
          >
            {!projects.isPending && project == null ? (
              <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
                {t('PortalUpdatesScreen.noProjectLead')} {providerName}{' '}
                {t('PortalUpdatesScreen.noProjectTail')}
              </p>
            ) : null}

            {updates.isSuccess && rows.length === 0 ? (
              <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
                {providerName} {t('PortalUpdatesScreen.noUpdatesTail')}
              </p>
            ) : null}

            {rows.length > 0 ? (
              <ol className="tm-pt-list">
                {rows.map((update, index) => (
                  <li
                    key={update.id}
                    className={
                      index === 0
                        ? 'tm-pt-card tm-pt-card--lg tm-pt-card--lead tm-pt-update'
                        : 'tm-pt-card tm-pt-card--lg tm-pt-update'
                    }
                  >
                    <div className="tm-pt-action__meta">
                      {index === 0 ? (
                        <Tag tone="lime">{t('PortalUpdatesScreen.latest')}</Tag>
                      ) : null}
                      <time className="tm-pt-mono" dateTime={update.createdAt}>
                        {weekday(update.createdAt)} · {providerName}
                      </time>
                    </div>
                    <h2
                      className={index === 0 ? 'tm-pt-update__title--lead' : 'tm-pt-update__title'}
                    >
                      {update.title}
                    </h2>
                    <p className="tm-pt-update__body">{update.body}</p>
                    {index === 0 ? (
                      <div className="tm-pt-form__actions">
                        <Link
                          className="tm-pt-btn tm-pt-btn--lime"
                          href={`/${organizationSlug}/portal/actions`}
                        >
                          {t('PortalUpdatesScreen.seeWhatNeedsYou')}
                        </Link>
                        <Link
                          className="tm-pt-btn"
                          href={`/${organizationSlug}/portal/requests/new`}
                        >
                          {t('PortalUpdatesScreen.askAQuestion')}
                        </Link>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
          </section>

          {project ? (
            <div className="tm-pt-col">
              <ProjectStands project={project} t={t} />
              <ComingUp milestones={milestones.data ?? []} t={t} />
            </div>
          ) : null}
        </div>
      </div>
    </ClientPortalShell>
  );
}

function ProjectStands({ project, t }: { project: PortalProject; t: Translate }) {
  return (
    <section className="tm-pt-ink" aria-labelledby="tm-updates-stands">
      <h2 id="tm-updates-stands" className="tm-pt-eyebrow">
        {t('PortalUpdatesScreen.whereStands')}
      </h2>
      <p className="tm-pt-ink__big">
        {project.committedAt ? shortDay(project.committedAt) : t('PortalUpdatesScreen.noDateYet')}
      </p>
      <p className="tm-pt-quiet">
        {project.committedAt
          ? t('PortalUpdatesScreen.dateAgreed')
          : t('PortalUpdatesScreen.noDateAgreed')}
      </p>
      <hr className="tm-pt-ink__rule" />
      <p className="tm-pt-ink__big tm-pt-ink__big--lime">
        {project.forecastAt ? shortDay(project.forecastAt) : '—'}
      </p>
      <p className="tm-pt-quiet">
        {project.forecastAt
          ? t('PortalUpdatesScreen.currentEstimate')
          : t('PortalUpdatesScreen.noEstimate')}
      </p>
    </section>
  );
}

function ComingUp({ milestones, t }: { milestones: readonly ClientMilestone[]; t: Translate }) {
  const ahead = milestones
    .filter((milestone) => milestone.status !== 'met')
    .sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'))
    .slice(0, 3);
  if (ahead.length === 0) return null;
  return (
    <section className="tm-pt-card" aria-labelledby="tm-updates-dates">
      <h2 id="tm-updates-dates" className="tm-pt-eyebrow">
        {t('PortalUpdatesScreen.datesAhead')}
      </h2>
      <ul className="tm-pt-rows">
        {ahead.map((milestone) => (
          <li key={milestone.id}>
            <div className="tm-pt-item__main">
              <p className="tm-pt-rows__title">{milestone.title}</p>
              <p className="tm-pt-quiet">
                {milestone.dueOn
                  ? `${milestone.status === 'missed' ? t('PortalUpdatesScreen.wasDue') : t('PortalUpdatesScreen.committed')} ${longDay(milestone.dueOn)}`
                  : t('PortalUpdatesScreen.noDateYetLower')}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function weekday(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  }).format(parsed);
}

function describe(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('PortalUpdatesScreen.portalNotAnswering');
  return t('PortalUpdatesScreen.genericError');
}
