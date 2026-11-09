'use client';

import { useQuery } from '@tanstack/react-query';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { getOrgBranding } from '../../lib/api/org-branding';
import { accentStylesheet } from '../../lib/brand-accent';

/** The query the branding read and the Brand colour card share. */
export function orgBrandingQueryKey(organizationSlug: string): readonly unknown[] {
  return ['org-branding', organizationSlug];
}

/**
 * Applies the company's brand colour to the whole workspace (Peter 2026-11-09). Nothing is drawn
 * until a colour other than the TManage lime has been saved: an unconfigured company (no save
 * yet) keeps the lime, and a reader who may not read the branding (a client) keeps it too.
 */
export function BrandAccentStyle({
  organizationSlug,
  client,
}: {
  organizationSlug: string;
  client?: ApiClient;
}) {
  const api = client ?? browserApiClient();
  const branding = useQuery({
    queryKey: orgBrandingQueryKey(organizationSlug),
    queryFn: () => getOrgBranding(api, organizationSlug),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const data = branding.data;
  if (!data?.updatedAt) return null;
  const css = accentStylesheet(data.accentColor);
  if (css === null) return null;
  return <style data-tm-brand-accent="">{css}</style>;
}
