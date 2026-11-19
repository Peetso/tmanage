'use client';

import Link from 'next/link';
import { InlineAlert } from '@tmanage/ui';
import { useClientsT } from './InviteClientDialog';
import type { ClientSummaryProject } from '../../lib/api/client-summary';
import { describePeopleError, initialsOf } from '../screens/peopleShared';
import { BandCapsule } from '../overview/DeliveryBlock';
import { clientViewHref, projectHref } from '../overview/overview-links';
import { useOverviewCopy } from '../overview/use-overview-copy';
import '../../styles/screens/clients.css';

export interface ClientProjectsPanelProps {
  organizationSlug: string;
  clientOrganizationId: string;
  /** The projects shared with the client, as the shared-projects read returns them. */
  projects: readonly { readonly id: string; readonly name: string }[];
  pending: boolean;
  error: unknown;
  /** Health bands by project id from the page's summary read; a project without one draws none. */
  bands: ReadonlyMap<string, ClientSummaryProject['band']>;
  /** `?health=at-risk`: only red and amber projects (review FIGMA-C fix 9). */
  atRisk: boolean;
}

const AT_RISK = new Set(['red', 'amber']);

/**
 * The client page's Projects tab (ONEPAGE, B04; before it a card of the page, B10): each project
 * shared with the company, opening the project, with its health capsule where the viewer may read
 * it. The Risks block's "See projects at risk" opens it narrowed to the projects at risk.
 */
export function ClientProjectsPanel({
  organizationSlug,
  clientOrganizationId,
  projects,
  pending,
  error,
  bands,
  atRisk,
}: ClientProjectsPanelProps) {
  const t = useClientsT();
  const copy = useOverviewCopy();
  const shown = atRisk
    ? projects.filter((project) => AT_RISK.has(bands.get(project.id) ?? 'neutral'))
    : projects;

  return (
    <section
      className="tm-card cl-card cl-card--organizations cl-card--projects"
      aria-labelledby="cl-company-projects-title"
    >
      <h2 id="cl-company-projects-title" className="cl-card__title">
        {t('Clients.sharedProjectsTitle')}
        <span className="cl-count cl-count--client">{shown.length}</span>
      </h2>
      {atRisk ? (
        <p className="tm-ov-filter">
          {copy.text('Overview.atRiskFilter')}
          <Link href={clientViewHref(organizationSlug, clientOrganizationId, 'projects')}>
            {copy.text('Overview.showAllProjects')}
          </Link>
        </p>
      ) : null}
      {error ? (
        <InlineAlert tone="danger" title={t('Clients.loadFailed')} live>
          {describePeopleError(error)}
        </InlineAlert>
      ) : shown.length === 0 ? (
        <p className="cl-empty">
          {pending
            ? ''
            : atRisk
              ? copy.text('Overview.noProjectsAtRisk')
              : t('Clients.sharedProjectsNone')}
        </p>
      ) : (
        <ul className="cl-list" aria-label={t('Clients.sharedProjectsTitle')}>
          {shown.map((project) => {
            const band = bands.get(project.id);
            return (
              <li key={project.id} className="cl-item">
                <Link
                  className="cl-row cl-row--link"
                  href={projectHref(organizationSlug, project.id)}
                >
                  <span className="cl-orb" aria-hidden="true">
                    {initialsOf(project.name)}
                  </span>
                  <span className="cl-row__text">
                    <span className="cl-row__name cl-break">{project.name}</span>
                  </span>
                  {band ? <BandCapsule band={band} copy={copy} /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
