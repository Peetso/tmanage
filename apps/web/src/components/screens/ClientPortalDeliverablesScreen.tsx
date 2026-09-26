'use client';

import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listPortalDeliverableFiles,
  listPortalDeliverables,
  listPortalProjects,
} from '../../lib/api/portal';
import type { PortalDeliverable, PortalDeliverableFile, PortalProject } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ClientPortalDeliverablesScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **CL-03 Deliverables** — the client portal's deliverables read (x114).
 *
 * `22-SCREEN-BY-SCREEN` §1's third destination. What a client sees here is the **published**
 * projection of each deliverable — the exact `12-PERMISSION-MATRIX` §1 allowlist the API freezes
 * at publish (x97), never the internal deliverable record. `PortalDeliverable` has no owner, no
 * internal state and no draft, so this screen could not render one if it tried.
 *
 * ## Files hang off a deliverable, and load only when asked
 *
 * Each deliverable's files are a second read (`GET …/deliverables/:id/files`), reached through a
 * disclosure so a client with many deliverables issues one file query per deliverable they open,
 * not one per deliverable that exists. The bytes themselves are a later ticket — the portal
 * download proxy (NEXT-SCOPES-9) — so a file is named and sized here, not yet downloadable.
 *
 * ## Deliverables span every shared project
 *
 * A client organization can be on more than one project, and the API's deliverables read is
 * per-project, so this screen fans out: one section per shared project, each loading its own
 * deliverables. The overview's "first project" shortcut would hide the rest.
 */
export function ClientPortalDeliverablesScreen({
  organizationSlug,
  clientName,
  providerName,
  client,
}: ClientPortalDeliverablesScreenProps) {
  const api = client ?? browserApiClient();

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const project = projects.data?.[0];
  const loadedProjects = projects.data ?? [];

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      {...(project ? { projectName: project.name } : {})}
      activeNavigationId="deliverables"
      title="Deliverables"
      description={`What ${providerName} has published to you.`}
    >
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
        <section className="tm-panel tm-stack" aria-labelledby="tm-deliverables-empty">
          <h2 id="tm-deliverables-empty" className="tm-eyebrow">
            Deliverables
          </h2>
          <p className="tm-prose">
            Nothing has been shared with you yet. {providerName} decides what appears here, and they
            will tell you when something does.
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
        />
      ))}

      <BackendPending ticket="portal file downloads — NEXT-SCOPES-9">
        You can see which files are attached to a deliverable and how large they are. Downloading
        them from here is not built yet; until it is, the file is listed rather than hidden.
      </BackendPending>
    </ClientPortalShell>
  );
}

interface ProjectDeliverablesProps {
  api: ApiClient;
  organizationSlug: string;
  providerName: string;
  project: PortalProject;
}

/**
 * One shared project's published deliverables.
 *
 * A section of its own so each project loads independently — a slow or failing read on one does
 * not blank the others.
 */
function ProjectDeliverables({
  api,
  organizationSlug,
  providerName,
  project,
}: ProjectDeliverablesProps) {
  const headingId = useId();

  const deliverables = useQuery({
    queryKey: ['portal-deliverables', organizationSlug, project.id],
    queryFn: () => listPortalDeliverables(api, organizationSlug, project.id),
  });

  const rows = deliverables.data ?? [];

  return (
    <section className="tm-panel tm-stack" aria-labelledby={headingId}>
      <h2 id={headingId} className="tm-eyebrow">
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

      {deliverables.isSuccess && rows.length === 0 ? (
        <p className="tm-prose">
          {providerName} has not published anything on {project.name} yet.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="tm-list tm-stack">
          {rows.map((deliverable) => (
            <li key={deliverable.id}>
              <DeliverablePanel
                api={api}
                organizationSlug={organizationSlug}
                deliverable={deliverable}
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
}

/**
 * One published deliverable version — every field is the x97 allowlist and no more.
 */
function DeliverablePanel({ api, organizationSlug, deliverable }: DeliverablePanelProps) {
  const [filesOpen, setFilesOpen] = useState(false);
  const filesRegionId = useId();

  return (
    <article className="tm-stack tm-stack--tight">
      <p>
        <strong>{deliverable.title}</strong>{' '}
        {deliverable.milestoneState ? (
          <StateCapsule state="current">{deliverable.milestoneState}</StateCapsule>
        ) : null}
      </p>

      {deliverable.summary ? <p className="tm-prose">{deliverable.summary}</p> : null}

      <dl className="tm-detail-list">
        <div className="tm-detail-list__pair">
          <dt>Published</dt>
          <dd>{formatDay(deliverable.publishedAt)}</dd>
        </div>
        {deliverable.forecastDate ? (
          <div className="tm-detail-list__pair">
            <dt>Current estimate</dt>
            <dd>{formatDay(deliverable.forecastDate)}</dd>
          </div>
        ) : null}
        {deliverable.decision ? (
          <div className="tm-detail-list__pair">
            <dt>Decision</dt>
            <dd>{deliverable.decision}</dd>
          </div>
        ) : null}
      </dl>

      {deliverable.publishedRisk ? (
        <p className="tm-prose">
          <strong>Risk:</strong> {deliverable.publishedRisk}
        </p>
      ) : null}

      {deliverable.approvedContacts.length > 0 ? (
        <p className="tm-prose">Your contacts: {deliverable.approvedContacts.join(', ')}</p>
      ) : null}

      <p>
        <button
          type="button"
          className="tm-button tm-button--text"
          aria-expanded={filesOpen}
          aria-controls={filesRegionId}
          onClick={() => setFilesOpen((open) => !open)}
        >
          {filesOpen ? 'Hide files' : 'Show files'}
        </button>
      </p>

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
    return <p className="tm-prose">No files are attached to this deliverable.</p>;
  }

  return (
    <ul className="tm-list tm-stack tm-stack--tight">
      {rows.map((file) => (
        <li key={file.id}>
          {file.name} <span className="tm-prose">{describeFile(file)}</span>
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

function formatDay(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(parsed);
}
