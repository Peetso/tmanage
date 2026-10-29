'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../../lib/api/client';
import { fetchPlatformOrg, runPlatformOrgLifecycle } from '../../../lib/api/platform-organizations';
import type { PlatformOrgDetailView } from '../../../lib/api/platform-organizations';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformGate } from '../shared/platform-kit';
import { ConfirmActDialog, OrgBanners, OrgHeader, ORGS_KEY, orgKey } from './org-kit';
import type { OrgTab } from './org-kit';

/**
 * The frame every organization tab shares (A3–A7): the gate, the organization's detail, the
 * header with its tabs, and the suspended/deleted banners (with Restore on a deleted one).
 */
export function OrgPage({
  api,
  organizationId,
  tab,
  title,
  children,
}: {
  api: ApiClient;
  organizationId: string;
  tab: OrgTab;
  title: string;
  children: (detail: PlatformOrgDetailView, me: PlatformMeView) => ReactNode;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [restoring, setRestoring] = useState(false);
  const detail = useQuery({
    queryKey: orgKey(organizationId),
    queryFn: () => fetchPlatformOrg(api, organizationId),
    retry: false,
  });
  const name = detail.data?.organization.name ?? t('PlatformOrgs.listCrumb');
  return (
    <PlatformGate
      api={api}
      section="organizations"
      crumbs={[t('PlatformOrgs.listCrumb'), name, title]}
      title={detail.data?.organization.name ?? title}
    >
      {(me) => (
        <div className="tm-cc-column">
          {detail.isPending ? <PlatformPageState state="loading" /> : null}
          {detail.isError ? (
            <PlatformPageState
              state="error"
              error={detail.error}
              onRetry={() => void detail.refetch()}
            />
          ) : null}
          {detail.isSuccess ? (
            <>
              <OrgHeader
                organization={detail.data.organization}
                tab={tab}
                memberCount={detail.data.organization.people}
              />
              <OrgBanners
                organization={detail.data.organization}
                restoreDaysLeft={detail.data.restoreDaysLeft}
                onRestore={() => setRestoring(true)}
              />
              {children(detail.data, me)}
              {restoring ? (
                <ConfirmActDialog
                  title={`${t('PlatformOrgs.restore')} ${detail.data.organization.name}`}
                  body={t('PlatformOrgs.restoreBody')}
                  slug={detail.data.organization.slug}
                  requireSlug={false}
                  confirmLabel={t('PlatformOrgs.restore')}
                  onConfirm={(input) =>
                    runPlatformOrgLifecycle(api, organizationId, 'restore', input)
                  }
                  onClose={(done) => {
                    setRestoring(false);
                    if (done) void queryClient.invalidateQueries({ queryKey: ORGS_KEY });
                  }}
                />
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </PlatformGate>
  );
}
