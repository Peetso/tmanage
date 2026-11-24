'use client';

import { LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { PersonProfileScreen } from '../screens/PersonProfileScreen';
import { AiProfileScreen } from './AiProfileScreen';
import { useAiEmployeeList } from './use-ai-employees';

/**
 * `/[orgSlug]/people/[membershipId]`: one address for every member. The AI-employee list (already
 * read by People, so usually cached) says whether this membership is an AI employee; if it is,
 * S6 draws; otherwise, or when AI employees are switched off or hidden from this reader (the list
 * answers 404/403), the person profile draws as before. A failed list read falls back to the
 * person profile too, whose own read then answers for the membership.
 */
export function MembershipProfile({
  organizationSlug,
  organizationName,
  membershipId,
  client,
}: {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly membershipId: string;
  readonly client?: ApiClient;
}) {
  const tOr = useTOr();
  const api = client ?? browserApiClient();
  const list = useAiEmployeeList(api, organizationSlug);

  if (list.isPending) {
    return (
      <LoadingRegion label={tOr('AiWizard.loading', 'Loading…')} className="tm-aie-profile-loading">
        <Skeleton height="var(--app-row)" />
        <Skeleton height="var(--app-row)" />
      </LoadingRegion>
    );
  }

  const ai = list.data?.aiEmployees.find((entry) => entry.membershipId === membershipId);
  if (ai) {
    return (
      <AiProfileScreen
        organizationSlug={organizationSlug}
        organizationName={organizationName}
        ai={ai}
        client={api}
      />
    );
  }
  return (
    <PersonProfileScreen
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      membershipId={membershipId}
      {...(client === undefined ? {} : { client })}
    />
  );
}
