'use client';

import { useContext, type ReactNode } from 'react';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import {
  DEFAULT_MODULE_ENABLED,
  getResolvedFeatureFlags,
  type OptionalModuleFlag,
} from '../../lib/api/admin-feature-flags';
import { browserApiClient } from '../../lib/api/browser-client';

interface FeatureOnProps {
  readonly organizationSlug: string;
  readonly flag: OptionalModuleFlag;
  readonly children: ReactNode;
}

/**
 * 52-24 — show an entry point only while its rollout flag resolves on for this organization. The
 * server decides (`GET …/feature-flags`, the same read its route gate uses); this only hides the
 * door the API would refuse with 404. While the read is pending or failed the code default
 * stands. Without a query client (static previews) there is nothing to read: the code default.
 */
export function FeatureOn({ organizationSlug, flag, children }: FeatureOnProps) {
  const queryClient = useContext(QueryClientContext);
  if (!queryClient) return DEFAULT_MODULE_ENABLED[flag] ? children : null;
  return (
    <FeatureOnRead organizationSlug={organizationSlug} flag={flag}>
      {children}
    </FeatureOnRead>
  );
}

function FeatureOnRead({ organizationSlug, flag, children }: FeatureOnProps) {
  // Its own cache key: this read goes through the browser client, while a screen (SearchScreen)
  // may read the same endpoint through an injected client. One key with two fetchers lets
  // whichever mounts first answer for both.
  const resolved = useQuery({
    queryKey: ['resolved-feature-flags', organizationSlug, 'shell'],
    queryFn: () => getResolvedFeatureFlags(browserApiClient(), organizationSlug),
  });
  return (resolved.data?.flags[flag] ?? DEFAULT_MODULE_ENABLED[flag]) ? children : null;
}
