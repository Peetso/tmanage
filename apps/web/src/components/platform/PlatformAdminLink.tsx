'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { fetchPlatformMe } from '../../lib/api/platform-admin';

/**
 * The small "Platform admin" entry at the foot of the rail, beside the account orb. It renders
 * nothing unless the API answers `GET /v1/platform/me` — which it does only for a person whose
 * verified email is in `PLATFORM_ADMIN_EMAILS`; everyone else gets a 404 and sees no entry.
 * Mount it only where a `QueryClient` is in the tree.
 */
export function PlatformAdminLink() {
  const t = useT();
  const me = useQuery({
    queryKey: ['platform', 'me', 'menu'],
    queryFn: () => fetchPlatformMe(browserApiClient()),
    retry: false,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  if (!me.isSuccess) return null;
  return (
    <Link href="/platform" className="tm-rail__item">
      <span className="tm-rail__orb" aria-hidden="true">
        ◎
      </span>
      <span className="tm-rail__label">{t('PlatformAdminLink.label')}</span>
    </Link>
  );
}
