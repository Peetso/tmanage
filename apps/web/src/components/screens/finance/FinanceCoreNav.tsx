'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { Capability } from '@tmanage/domain';
import type { ApiClient } from '../../../lib/api/client';
import { readOrganizationMe, type OrganizationMe } from '../../../lib/api/permission-matrix';
import { listPeople } from '../../../lib/api/people';
import { useTOr } from '../../../lib/i18n/use-t-or';

export type FinanceCoreTab = 'profile' | 'rates' | 'timesheets' | 'expenses';

const TABS: readonly (readonly [FinanceCoreTab, string, string])[] = [
  ['profile', 'FinanceCore.tabProfile', 'Profile'],
  ['rates', 'FinanceCore.tabRates', 'Rate cards'],
  ['timesheets', 'FinanceCore.tabTimesheets', 'Timesheets'],
  ['expenses', 'FinanceCore.tabExpenses', 'Expenses'],
];

/** The four finance tabs of part 1 (Figma "R31 A10a Finance", section 508:30241). */
export function FinanceCoreNav({
  organizationSlug,
  active,
}: {
  organizationSlug: string;
  active: FinanceCoreTab;
}) {
  const tOr = useTOr();
  return (
    <nav className="tm-segmented" aria-label={tOr('FinanceCore.subnav', 'Finance sections')}>
      {TABS.map(([id, key, english]) => (
        <Link
          key={id}
          href={`/${organizationSlug}/finance/${id}`}
          aria-current={id === active ? 'page' : undefined}
        >
          {tOr(key, english)}
        </Link>
      ))}
    </nav>
  );
}

/** The caller's membership and capabilities, to hide actions the API would refuse. */
export function useFinanceMe(
  api: ApiClient,
  organizationSlug: string,
): {
  me: OrganizationMe | undefined;
  can: (capability: Capability) => boolean;
} {
  const query = useQuery({
    queryKey: ['organization-me', organizationSlug],
    queryFn: () => readOrganizationMe(api, organizationSlug),
  });
  const me = query.data;
  return { me, can: (capability) => me?.capabilities.includes(capability) ?? false };
}

/** A membership id as a person's name ("You" for the caller), for approver tables. */
export function usePersonName(
  api: ApiClient,
  organizationSlug: string,
  myMembershipId: string | undefined,
  enabled: boolean,
): (membershipId: string) => string {
  const tOr = useTOr();
  const people = useQuery({
    queryKey: ['finance-people', organizationSlug],
    queryFn: () => listPeople(api, organizationSlug, { limit: 200 }),
    enabled,
  });
  return (membershipId) => {
    if (membershipId === myMembershipId) return tOr('FinanceCore.you', 'You');
    const found = people.data?.people.find((person) => person.membershipId === membershipId);
    return found?.displayName ?? tOr('FinanceCore.member', 'Team member');
  };
}
