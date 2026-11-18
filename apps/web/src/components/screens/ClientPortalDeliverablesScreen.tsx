'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { useSelectedPortalProjectId } from '../shell/PortalProjectSwitcher';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listPortalDeliverableFiles,
  listPortalDeliverables,
  listPortalProjects,
} from '../../lib/api/portal';
import type { PortalDeliverable, PortalDeliverableFile, PortalProject } from '../../lib/api/portal';
import { PORTAL_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { Segmented, shortDay, Tag } from './PortalParts';
import { PortalReviewLink } from './PortalReviewLink';
import { PortalDeliverablePreview } from './PortalDeliverablePreview';
import { PortalSignatureWaitingList } from './esign/PortalSignatureWaitingList';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { withNumerals } from '../../lib/i18n/display-format';
import { pluralPhrase } from '../../lib/i18n/plural';
import { awaitsYou, isFinalReview, reviewLabelKey } from '../../lib/portal-review';

export interface ClientPortalDeliverablesScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **CL-07 Deliverables** — the client portal's deliverables read (x114).
 *
 * What a client sees here is the **published** projection of each deliverable — the exact
 * `12-PERMISSION-MATRIX` §1 allowlist the API freezes at publish (x97), never the internal
 * deliverable record, and no internal stages. Drawn as the handoff's CL-07: a counting headline,
 * an "All / Awaiting a decision / Final" switch, and one card per deliverable in two columns.
 *
 * Files hang off a deliverable: each card reads its file list once for its picture, and the
 * "Show files" disclosure reuses that read. A client organization can be on
 * more than one project; the read is per-project, so the screen fans out one query per project
 * (shared by key with each project's section).
 */
type Filter = 'all' | 'open' | 'final';

export function ClientPortalDeliverablesScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: ClientPortalDeliverablesScreenProps) {
  const describe = useDescribeApiError(PORTAL_LINES);
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const [filter, setFilter] = useState<Filter>('all');

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  // With `?project=` the page is that one shared project; "All projects" (no parameter) lists all.
  const selectedProjectId = useSelectedPortalProjectId();
  const sharedProjects = projects.data ?? [];
  const chosenProjects = sharedProjects.filter((shared) => shared.id === selectedProjectId);
  const loadedProjects = chosenProjects.length > 0 ? chosenProjects : sharedProjects;

  const perProject = useQueries({
    queries: loadedProjects.map((shared) => ({
      queryKey: ['portal-deliverables', organizationSlug, shared.id],
      queryFn: () => listPortalDeliverables(api, organizationSlug, shared.id),
    })),
  });
  const everything = perProject.flatMap((query) => query.data ?? []);
  const finalCount = everything.filter(isFinal).length;
  const openCount = everything.length - finalCount;
  const settled = projects.isSuccess && perProject.every((query) => !query.isPending);

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="deliverables"
      title={
        settled && everything.length > 0
          ? headline(everything.length, finalCount, tOr, locale)
          : t('ClientPortalDeliverablesScreen.deliverables')
      }
      eyebrow={t('ClientPortalDeliverablesScreen.eyebrow')}
      headerAside={
        everything.length > 0 ? (
          <Segmented<Filter>
            label={t('ClientPortalDeliverablesScreen.show')}
            value={filter}
            onChange={setFilter}
            options={[
              { id: 'all', label: t('ClientPortalDeliverablesScreen.all') },
              {
                id: 'open',
                label: `${t('ClientPortalDeliverablesScreen.awaitingPrefix')}${openCount}`,
              },
              {
                id: 'final',
                label: `${t('ClientPortalDeliverablesScreen.finalPrefix')}${finalCount}`,
              },
            ]}
          />
        ) : undefined
      }
    >
      <div className="tm-pt tm-pt--compact">
        {projects.isError ? (
          <InlineAlert tone="danger" title={t('ClientPortalDeliverablesScreen.loadError')} live>
            {describe(projects.error)}
          </InlineAlert>
        ) : null}

        <PortalSignatureWaitingList api={api} organizationSlug={organizationSlug} />

        {projects.isPending ? (
          <LoadingRegion label={t('ClientPortalDeliverablesScreen.loadingLabel')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {projects.isSuccess && loadedProjects.length === 0 ? (
          <section
            className="tm-pt-card tm-pt-card--dashed"
            aria-labelledby="tm-deliverables-empty"
          >
            <h2 id="tm-deliverables-empty" className="tm-pt-card__title">
              {t('ClientPortalDeliverablesScreen.deliverables')}
            </h2>
            <p className="tm-pt-card__body">
              {t('ClientPortalDeliverablesScreen.nothingSharedBefore')}
              {providerName}
              {t('ClientPortalDeliverablesScreen.nothingSharedAfter')}
            </p>
          </section>
        ) : null}

        {loadedProjects.map((shared) => (
          <ProjectDeliverables
            key={shared.id}
            api={api}
            organizationSlug={organizationSlug}
            providerName={providerName}
            project={shared}
            filter={filter}
            labelled={loadedProjects.length > 1}
          />
        ))}
      </div>
    </ClientPortalShell>
  );
}

/**
 * The counting headline, in the locale's plural form. It came from English literals ("Ten pieces
 * of work, none final yet") and so read English on the Arabic portal (TESTUX P0 3).
 */
function headline(
  total: number,
  final: number,
  tOr: (key: string, english: string) => string,
  locale: string,
): string {
  if (final === 0) {
    return pluralPhrase(tOr, locale, 'ClientPortalDeliverablesScreen.headlineNoneFinal', total, {
      one: 'One piece of work, not final yet',
      other: '{count} pieces of work, none final yet',
    });
  }
  if (final === total) {
    return pluralPhrase(tOr, locale, 'ClientPortalDeliverablesScreen.headlineAllFinal', total, {
      one: 'One piece of work, final',
      other: '{count} pieces of work, all final',
    });
  }
  return pluralPhrase(tOr, locale, 'ClientPortalDeliverablesScreen.headlineSomeFinal', total, {
    one: '{count} pieces of work, {final} already final',
    other: '{count} pieces of work, {final} already final',
  }).replace(/\{final\}/gu, final.toLocaleString(withNumerals(locale)));
}

/** Final once its live review is approved — never the projection's frozen `decision`. */
function isFinal(deliverable: PortalDeliverable): boolean {
  return isFinalReview(deliverable.review);
}

/** An enum-looking value (`in_review`) said in words; free text is shown as written. */
function words(value: string): string {
  if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(value)) return value;
  const spaced = value.replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

interface ProjectDeliverablesProps {
  api: ApiClient;
  organizationSlug: string;
  providerName: string;
  project: PortalProject;
  filter: Filter;
  labelled: boolean;
}

/**
 * One shared project's published deliverables. A section of its own so each project loads
 * independently — a slow or failing read on one does not blank the others.
 */
function ProjectDeliverables({
  api,
  organizationSlug,
  providerName,
  project,
  filter,
  labelled,
}: ProjectDeliverablesProps) {
  const describe = useDescribeApiError(PORTAL_LINES);
  const t = useT();
  const headingId = useId();

  const deliverables = useQuery({
    queryKey: ['portal-deliverables', organizationSlug, project.id],
    queryFn: () => listPortalDeliverables(api, organizationSlug, project.id),
  });

  const rows = (deliverables.data ?? []).filter((deliverable) =>
    filter === 'all' ? true : filter === 'final' ? isFinal(deliverable) : !isFinal(deliverable),
  );
  const firstOpen = rows.find((deliverable) => !isFinal(deliverable));

  return (
    <section className="tm-stack" aria-labelledby={headingId}>
      <h2 id={headingId} className={labelled ? 'tm-pt-eyebrow' : 'tm-pt-visually-hidden'}>
        {project.name}
      </h2>

      {deliverables.isError ? (
        <InlineAlert
          tone="danger"
          title={t('ClientPortalDeliverablesScreen.loadErrorSection')}
          live
        >
          {describe(deliverables.error)}
        </InlineAlert>
      ) : null}

      {deliverables.isPending ? (
        <LoadingRegion
          label={`${t('ClientPortalDeliverablesScreen.loadingForPrefix')}${project.name}${t('ClientPortalDeliverablesScreen.loadingForSuffix')}`}
        >
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {deliverables.isSuccess && (deliverables.data ?? []).length === 0 ? (
        <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
          {providerName}
          {t('ClientPortalDeliverablesScreen.notPublishedOnMiddle')}
          {project.name}
          {t('ClientPortalDeliverablesScreen.notPublishedOnSuffix')}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="tm-pt-grid">
          {rows.map((deliverable) => (
            <li key={deliverable.id}>
              <DeliverablePanel
                api={api}
                organizationSlug={organizationSlug}
                deliverable={deliverable}
                lead={deliverable === firstOpen}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface DeliverablePanelProps {
  api: ApiClient;
  organizationSlug: string;
  deliverable: PortalDeliverable;
  lead: boolean;
}

/** One published deliverable version — every field is the x97 allowlist and no more. */
function DeliverablePanel({ api, organizationSlug, deliverable, lead }: DeliverablePanelProps) {
  const t = useT();
  const [filesOpen, setFilesOpen] = useState(false);
  const filesRegionId = useId();
  const review = deliverable.review;
  const href = `/${organizationSlug}/portal/deliverables/${deliverable.id}`;
  // TESTUX P2 19: a forecast day already behind us is not "Expected" any more.
  const forecastPassed =
    deliverable.forecastDate !== null &&
    !isFinal(deliverable) &&
    deliverable.forecastDate < new Date().toISOString().slice(0, 10);

  return (
    <article className={lead ? 'tm-pt-deliv tm-pt-deliv--lead' : 'tm-pt-deliv'}>
      <PortalDeliverablePreview
        api={api}
        organizationSlug={organizationSlug}
        deliverableId={deliverable.deliverableId}
      />

      <div className="tm-pt-action__meta">
        {review ? (
          <Tag
            tone={isFinalReview(review) ? 'done' : lead || awaitsYou(review) ? 'lime' : undefined}
          >
            {isFinalReview(review) ? '✓ ' : ''}
            {t(reviewLabelKey(review))}
          </Tag>
        ) : deliverable.milestoneState ? (
          <Tag tone={lead ? 'lime' : undefined}>{words(deliverable.milestoneState)}</Tag>
        ) : null}
        <span className="tm-pt-mono">
          {deliverable.forecastDate
            ? `${
                forecastPassed
                  ? t('ClientPortalDeliverablesScreen.wasExpectedPrefix')
                  : t('ClientPortalDeliverablesScreen.expectedPrefix')
              }${shortDay(deliverable.forecastDate)}`
            : `${t('ClientPortalDeliverablesScreen.sharedPrefix')}${shortDay(deliverable.publishedAt)}`}
        </span>
      </div>

      <h3 className="tm-pt-deliv__title">
        <Link href={href}>{deliverable.title}</Link>
      </h3>

      {deliverable.summary ? <p className="tm-pt-card__body">{deliverable.summary}</p> : null}

      {deliverable.publishedRisk ? (
        <p className="tm-pt-quiet">
          <strong>{t('ClientPortalDeliverablesScreen.riskLabel')}</strong>{' '}
          {words(deliverable.publishedRisk)}
        </p>
      ) : null}

      {deliverable.approvedContacts.length > 0 ? (
        <p className="tm-pt-quiet">
          {t('ClientPortalDeliverablesScreen.yourContactsPrefix')}
          {deliverable.approvedContacts.join(', ')}
        </p>
      ) : null}

      <div className="tm-pt-deliv__actions">
        <Link className={lead ? 'tm-pt-btn tm-pt-btn--lime' : 'tm-pt-btn'} href={href}>
          {t('ClientPortalDeliverablesScreen.open')}
        </Link>
        <button
          type="button"
          className="tm-pt-btn tm-pt-btn--quiet"
          aria-expanded={filesOpen}
          aria-controls={filesRegionId}
          onClick={() => setFilesOpen((open) => !open)}
        >
          {filesOpen
            ? t('ClientPortalDeliverablesScreen.hideFiles')
            : t('ClientPortalDeliverablesScreen.showFiles')}
        </button>
      </div>

      <div id={filesRegionId} hidden={!filesOpen}>
        {filesOpen ? (
          <DeliverableFiles
            api={api}
            organizationSlug={organizationSlug}
            deliverableId={deliverable.deliverableId}
            deliverableVersionId={deliverable.id}
          />
        ) : null}
      </div>
    </article>
  );
}

interface DeliverableFilesProps {
  api: ApiClient;
  organizationSlug: string;
  deliverableId: string;
  /** R4 slice 8. The published version the Review button opens the viewer for. */
  deliverableVersionId: string;
}

/**
 * The files attached to one deliverable — the same read the card's picture made.
 */
function DeliverableFiles({
  api,
  organizationSlug,
  deliverableId,
  deliverableVersionId,
}: DeliverableFilesProps) {
  const describe = useDescribeApiError(PORTAL_LINES);
  const t = useT();
  const files = useQuery({
    queryKey: ['portal-deliverable-files', organizationSlug, deliverableId],
    queryFn: () => listPortalDeliverableFiles(api, organizationSlug, deliverableId),
  });

  if (files.isError) {
    return (
      <InlineAlert tone="danger" title={t('ClientPortalDeliverablesScreen.filesError')} live>
        {describe(files.error)}
      </InlineAlert>
    );
  }

  if (files.isPending) {
    return (
      <LoadingRegion label={t('ClientPortalDeliverablesScreen.loadingFiles')}>
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  }

  const rows = files.data ?? [];
  if (rows.length === 0) {
    return <p className="tm-pt-quiet">{t('ClientPortalDeliverablesScreen.noFiles')}</p>;
  }

  return (
    <ul className="tm-pt-files">
      {rows.map((file) => (
        <li key={file.id} className="tm-pt-item">
          <span className="tm-pt-file__icon" aria-hidden="true" />
          <div className="tm-pt-item__main">
            <p className="tm-pt-item__title">{file.name}</p>
            <p className="tm-pt-mono">{describeFile(file)}</p>
          </div>
          {file.reviewable ? (
            <PortalReviewLink
              organizationSlug={organizationSlug}
              fileId={file.id}
              fileName={file.name}
              openComments={file.openComments}
              deliverableVersionId={deliverableVersionId}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function describeFile(file: PortalDeliverableFile): string {
  const size = formatBytes(file.sizeBytes);
  return file.mimeType ? `${size} · ${file.mimeType}` : size;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)} ${units[unit]}`;
}
