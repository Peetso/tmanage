'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listPortalDeliverableFiles,
  listPortalDeliverables,
  listPortalProjects,
} from '../../lib/api/portal';
import type { PortalDeliverable, PortalDeliverableFile, PortalProject } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { Segmented, shortDay, Tag } from './PortalParts';

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
 * Files hang off a deliverable and load only when its disclosure opens, so a client with many
 * deliverables issues one file query per deliverable they open. A client organization can be on
 * more than one project; the read is per-project, so the screen fans out one query per project
 * (shared by key with each project's section).
 */
type Filter = 'all' | 'open' | 'final';

export function ClientPortalDeliverablesScreen({
  organizationSlug,
  clientName,
  providerName,
  client,
}: ClientPortalDeliverablesScreenProps) {
  const api = client ?? browserApiClient();
  const [filter, setFilter] = useState<Filter>('all');

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const loadedProjects = projects.data ?? [];

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
        settled && everything.length > 0 ? headline(everything.length, finalCount) : 'Deliverables'
      }
      eyebrow="Deliverables · what you will receive"
      headerAside={
        everything.length > 0 ? (
          <Segmented<Filter>
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { id: 'all', label: 'All' },
              { id: 'open', label: `Awaiting a decision · ${openCount}` },
              { id: 'final', label: `Final · ${finalCount}` },
            ]}
          />
        ) : undefined
      }
    >
      <div className="tm-pt tm-pt--compact">
        {projects.isError ? (
          <InlineAlert tone="danger" title="Could not load your deliverables" live>
            {describe(projects.error)}
          </InlineAlert>
        ) : null}

        {projects.isPending ? (
          <LoadingRegion label="Loading your deliverables.">
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
              Deliverables
            </h2>
            <p className="tm-pt-card__body">
              Nothing has been shared with you yet. {providerName} decides what appears here, and
              they will tell you when something does.
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

const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

function headline(total: number, final: number): string {
  const count = COUNT_WORDS[total] ?? String(total);
  const pieces = `${count} piece${total === 1 ? '' : 's'} of work`;
  if (final === 0) return `${pieces}, none final yet`;
  if (final === total) return `${pieces}, all final`;
  return `${pieces}, ${(COUNT_WORDS[final] ?? String(final)).toLowerCase()} already final`;
}

function isFinal(deliverable: PortalDeliverable): boolean {
  return deliverable.decision !== null;
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
        <InlineAlert tone="danger" title="Could not load these deliverables" live>
          {describe(deliverables.error)}
        </InlineAlert>
      ) : null}

      {deliverables.isPending ? (
        <LoadingRegion label={`Loading deliverables for ${project.name}.`}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {deliverables.isSuccess && (deliverables.data ?? []).length === 0 ? (
        <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
          {providerName} has not published anything on {project.name} yet.
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
  const [filesOpen, setFilesOpen] = useState(false);
  const filesRegionId = useId();
  const final = isFinal(deliverable);
  const href = `/${organizationSlug}/portal/deliverables/${deliverable.id}`;

  return (
    <article className={lead ? 'tm-pt-deliv tm-pt-deliv--lead' : 'tm-pt-deliv'}>
      <div className="tm-pt-preview" aria-hidden="true">
        nothing to show yet
      </div>

      <div className="tm-pt-action__meta">
        {final ? (
          <Tag tone="done">✓ {words(deliverable.decision!)}</Tag>
        ) : deliverable.milestoneState ? (
          <Tag tone={lead ? 'lime' : undefined}>{words(deliverable.milestoneState)}</Tag>
        ) : null}
        <span className="tm-pt-mono">
          {deliverable.forecastDate
            ? `Expected ${shortDay(deliverable.forecastDate)}`
            : `Shared ${shortDay(deliverable.publishedAt)}`}
        </span>
      </div>

      <h3 className="tm-pt-deliv__title">
        <Link href={href}>{deliverable.title}</Link>
      </h3>

      {deliverable.summary ? <p className="tm-pt-card__body">{deliverable.summary}</p> : null}

      {deliverable.publishedRisk ? (
        <p className="tm-pt-quiet">
          <strong>Risk:</strong> {words(deliverable.publishedRisk)}
        </p>
      ) : null}

      {deliverable.approvedContacts.length > 0 ? (
        <p className="tm-pt-quiet">Your contacts: {deliverable.approvedContacts.join(', ')}</p>
      ) : null}

      <div className="tm-pt-deliv__actions">
        <Link className={lead ? 'tm-pt-btn tm-pt-btn--lime' : 'tm-pt-btn'} href={href}>
          Open
        </Link>
        <button
          type="button"
          className="tm-pt-btn tm-pt-btn--quiet"
          aria-expanded={filesOpen}
          aria-controls={filesRegionId}
          onClick={() => setFilesOpen((open) => !open)}
        >
          {filesOpen ? 'Hide files' : 'Show files'}
        </button>
      </div>

      <div id={filesRegionId} hidden={!filesOpen}>
        {filesOpen ? (
          <DeliverableFiles
            api={api}
            organizationSlug={organizationSlug}
            deliverableId={deliverable.deliverableId}
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
}

/**
 * The files attached to one deliverable, fetched the first time the disclosure opens.
 */
function DeliverableFiles({ api, organizationSlug, deliverableId }: DeliverableFilesProps) {
  const files = useQuery({
    queryKey: ['portal-deliverable-files', organizationSlug, deliverableId],
    queryFn: () => listPortalDeliverableFiles(api, organizationSlug, deliverableId),
  });

  if (files.isError) {
    return (
      <InlineAlert tone="danger" title="Could not load these files" live>
        {describe(files.error)}
      </InlineAlert>
    );
  }

  if (files.isPending) {
    return (
      <LoadingRegion label="Loading files.">
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  }

  const rows = files.data ?? [];
  if (rows.length === 0) {
    return <p className="tm-pt-quiet">No files are attached to this deliverable.</p>;
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
        </li>
      ))}
    </ul>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
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
