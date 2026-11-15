import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from './api/client';
import type { ApprovalRecordEvidence } from './api/approval-records';
import { getClientOrganization, listClientPeople } from './api/clients';
import { useMembers } from './use-members';

export interface ApproverName {
  /** The person's name, or null while unknown (the caller says "a team member" / "a client"). */
  readonly name: string | null;
  /** The client company for a client approver, else null. */
  readonly company: string | null;
}

/**
 * 52-19. A sealed record names its approver by id only (by design); the name comes from the
 * existing directories — team members for an internal approver, the client company's people for a
 * client. A refused or failed lookup leaves the name null rather than guessing.
 */
export function useApproverName(
  api: ApiClient,
  organizationSlug: string,
  approver: ApprovalRecordEvidence['approver'] | null,
): ApproverName {
  const members = useMembers(api, organizationSlug);
  const companyId = approver?.kind === 'client' ? approver.clientOrganizationId : null;
  const people = useQuery({
    queryKey: ['client-people', organizationSlug, companyId],
    queryFn: () => listClientPeople(api, organizationSlug, companyId ?? ''),
    enabled: companyId !== null,
    retry: false,
    staleTime: 60_000,
  });
  const company = useQuery({
    queryKey: ['client-organization', organizationSlug, companyId],
    queryFn: () => getClientOrganization(api, organizationSlug, companyId ?? ''),
    enabled: companyId !== null,
    retry: false,
    staleTime: 60_000,
  });
  if (!approver) return { name: null, company: null };
  if (approver.kind === 'internal') {
    const member = members.members.find((m) => m.userId === approver.userId);
    return { name: member?.displayName ?? null, company: null };
  }
  const person = people.data?.find((p) => p.userId === approver.userId);
  return { name: person?.displayName ?? null, company: company.data?.name ?? null };
}
