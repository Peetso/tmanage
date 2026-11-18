import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { getPricingSurvey } from '../../lib/api/pricing-survey';

/** The cache key of whether Home asks the 57-17 "what would you pay" question. */
export function pricingSurveyKey(organizationSlug: string) {
  return ['home', 'pricing-survey', organizationSlug] as const;
}

/**
 * Whether Home asks the question, read once per visit. The card draws from it, and the automatic
 * timer reads the same entry so it does not open its own first-visit panel over the card.
 */
export function pricingSurveyQuery(api: ApiClient, organizationSlug: string) {
  return queryOptions({
    queryKey: pricingSurveyKey(organizationSlug),
    queryFn: () => getPricingSurvey(api, organizationSlug),
    retry: false,
    staleTime: Infinity,
  });
}
