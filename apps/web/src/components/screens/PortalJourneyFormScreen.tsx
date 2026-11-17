'use client';

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { getPortalJourneyForm, submitPortalJourneyForm } from '../../lib/api/portal';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { IntakeForm, sendFailure, type IntakeFormValues } from './PublicFormScreen';

export interface PortalJourneyFormScreenProps {
  organizationSlug: string;
  stepId: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **52-27 Journey form step** — the client fills the form their journey step asks for, inside the
 * portal, with the same intake form the public page shows. The answers go to the step's own route:
 * the server checks them, stores them and marks the step done from what it stored.
 */
export function PortalJourneyFormScreen({
  organizationSlug,
  stepId,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: PortalJourneyFormScreenProps) {
  const t = useT();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const portal = `/${organizationSlug}/portal`;
  const definition = useQuery({
    queryKey: ['portal-journey-form', organizationSlug, stepId],
    queryFn: () => getPortalJourneyForm(api, organizationSlug, stepId),
    retry: false,
  });

  const send = async (values: IntakeFormValues) => {
    try {
      const { reference } = await submitPortalJourneyForm(api, organizationSlug, stepId, values);
      void queryClient.invalidateQueries({ queryKey: ['portal-journey', organizationSlug] });
      return { kind: 'sent', reference } as const;
    } catch (error) {
      return sendFailure(error);
    }
  };

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      title={definition.data?.title ?? t('PortalJourney.formStep')}
      eyebrow={<Link href={portal}>‹ {t('PortalJourney.backToProject')}</Link>}
    >
      <IntakeForm
        definition={definition}
        send={send}
        embedded={{ backHref: portal, backLabel: t('PortalJourney.backToProject') }}
      />
    </ClientPortalShell>
  );
}
