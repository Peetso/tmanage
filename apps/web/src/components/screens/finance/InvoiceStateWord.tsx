'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listClientOrganizations } from '../../../lib/api/clients';
import type { ApiClient } from '../../../lib/api/client';
import { useTOr } from '../../../lib/i18n/use-t-or';

const STATE_WORDS: Record<string, readonly [string, string]> = {
  draft: ['InvoiceList.stateDraft', 'Draft'],
  sent: ['InvoiceList.stateSent', 'Sent'],
  partially_paid: ['InvoiceList.statePartiallyPaid', 'Part paid'],
  paid: ['InvoiceList.statePaid', 'Paid'],
  void: ['InvoiceList.stateVoid', 'Void'],
  credited: ['InvoiceList.stateCredited', 'Credited'],
  overdue: ['InvoiceList.stateOverdue', 'Overdue'],
};

/** The word inside an invoice's state capsule, from the catalog (never the raw API value). */
export function InvoiceStateWord({ stateKey }: { stateKey: string }) {
  const tOr = useTOr();
  const word = STATE_WORDS[stateKey] ?? STATE_WORDS['draft']!;
  return <>{tOr(...word)}</>;
}

/**
 * Client company names by id, for the invoice and retainer screens. The list sits on `org.manage`;
 * a finance member without it gets no names and the screens show a dash, never an id.
 */
export function useClientNames(api: ApiClient, organizationSlug: string): Map<string, string> {
  const clients = useQuery({
    queryKey: ['finance-client-names', organizationSlug],
    queryFn: () => listClientOrganizations(api, organizationSlug),
    retry: false,
  });
  return useMemo(
    () => new Map((clients.data ?? []).map((entry) => [entry.id, entry.name] as const)),
    [clients.data],
  );
}
