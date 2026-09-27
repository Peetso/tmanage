'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPersonProfile } from '../../lib/api/person-profile';
import type { PersonProfileView } from '../../lib/api/person-profile';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface PersonProfileScreenProps {
  organizationSlug: string;
  organizationName: string;
  membershipId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Person profile** — x169, the per-member detail behind the People directory (module 14, audit #4).
 * It reads `GET /v1/organizations/:orgSlug/people/:membershipId` (gated on the server by `work.read`)
 * and renders the member's non-sensitive profile: a header (name, role, status), the projects they
 * belong to, and how much open work they own.
 *
 * The decisions are the sibling internal screens':
 * 1. **Authorization is the API's.** A caller without `work.read`, or a cross-tenant/unknown id, gets
 *    the API's 403/404, which `describe()` turns into a sentence in the panel's own alert; the screen
 *    never guesses a capability of its own and never renders blank on a refusal.
 * 2. **No invented data.** Role, projects and the open-work count are the API's projection.
 * 3. **No charts dependency.** Semantic sections and a captioned table carry the data; a11y is
 *    checked against the mounted document, not asserted.
 */
export function PersonProfileScreen({
  organizationSlug,
  organizationName,
  membershipId,
  client,
}: PersonProfileScreenProps) {
  const api = client ?? browserApiClient();

  const profile = useQuery({
    queryKey: ['person-profile', organizationSlug, membershipId],
    queryFn: () => fetchPersonProfile(api, organizationSlug, membershipId),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      title="Person"
      description="One member's role, projects and open work."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-person-heading">
        <h2 id="tm-person-heading" className="tm-eyebrow">
          Profile
        </h2>

        {profile.isPending ? (
          <LoadingRegion label="Loading the profile." className="tm-stack tm-stack--tight">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {profile.isError ? (
          <InlineAlert tone="danger" title="Could not load the profile" live>
            {describe(profile.error)}
          </InlineAlert>
        ) : null}

        {profile.isSuccess ? <ProfileBody profile={profile.data} /> : null}
      </section>
    </AppShell>
  );
}

function ProfileBody({ profile }: { profile: PersonProfileView }) {
  return (
    <>
      <dl className="tm-detail-list">
        <div className="tm-detail-list__pair">
          <dt>Name</dt>
          <dd>{profile.displayName}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Role</dt>
          <dd className="tm-mono">{profile.role}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Status</dt>
          <dd className="tm-mono">{profile.status}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Open work</dt>
          <dd className="tm-mono">{profile.openWorkCount}</dd>
        </div>
      </dl>

      <h3 className="tm-eyebrow" id="tm-person-projects">
        Projects
      </h3>
      {profile.projects.length === 0 ? (
        <p className="tm-prose">This member is not on any projects.</p>
      ) : (
        <table className="tm-table" aria-labelledby="tm-person-projects">
          <caption className="tm-visually-hidden">
            Projects {profile.displayName} belongs to
          </caption>
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Status</th>
              <th scope="col">Role</th>
            </tr>
          </thead>
          <tbody>
            {profile.projects.map((project) => (
              <tr key={project.projectId}>
                <th scope="row">{project.name}</th>
                <td className="tm-mono">{project.status}</td>
                <td className="tm-mono">{project.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}
