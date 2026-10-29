'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Select } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  fetchPlatformOrgMembers,
  runPlatformOrgLifecycle,
} from '../../../lib/api/platform-organizations';
import type {
  PlatformOrgDetailView,
  PlatformOrgLifecycleAct,
} from '../../../lib/api/platform-organizations';
import { useT } from '../../../lib/i18n/use-t';
import type { MessageKey } from '../../../lib/i18n/t';
import type { ScreenProps } from '../shared/platform-kit';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { ConfirmActDialog, ORGS_KEY, orgKey } from './org-kit';
import { OrgPage } from './OrgPage';

/** A7 `/platform/organizations/[id]/lifecycle` — suspend, transfer, archive, delete (frame A7). */
export function PlatformOrgLifecycleScreen({
  client,
  organizationId,
}: ScreenProps & { organizationId: string }) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <OrgPage
      api={api}
      organizationId={organizationId}
      tab="lifecycle"
      title={t('PlatformOrgs.tabLifecycle')}
    >
      {(detail) => <LifecycleBody api={api} detail={detail} />}
    </OrgPage>
  );
}

interface Card {
  act: PlatformOrgLifecycleAct;
  title: MessageKey;
  body: MessageKey;
  button: MessageKey;
  destructive?: boolean;
  requireSlug?: boolean;
}

function LifecycleBody({ api, detail }: { api: ApiClient; detail: PlatformOrgDetailView }) {
  const t = useT();
  const queryClient = useQueryClient();
  const canAct = usePlatformPermissions(api).has('platform.orgs.lifecycle');
  const org = detail.organization;
  const [open, setOpen] = useState<Card | null>(null);
  const [newOwner, setNewOwner] = useState('');
  const members = useQuery({
    queryKey: orgKey(org.id, 'members'),
    queryFn: () => fetchPlatformOrgMembers(api, org.id),
    retry: false,
    enabled: open?.act === 'ownership-transfer',
  });
  const cards: Card[] = [];
  if (org.status === 'active') {
    cards.push({
      act: 'suspension',
      title: 'PlatformOrgs.suspendTitle',
      body: 'PlatformOrgs.suspendBody',
      button: 'PlatformOrgs.suspend',
      destructive: true,
    });
  }
  if (org.status === 'suspended') {
    cards.push({
      act: 'reactivation',
      title: 'PlatformOrgs.reactivateTitle',
      body: 'PlatformOrgs.unsuspendBody',
      button: 'PlatformOrgs.reactivate',
    });
  }
  if (org.status !== 'deleted') {
    cards.push(
      {
        act: 'ownership-transfer',
        title: 'PlatformOrgs.transferTitle',
        body: 'PlatformOrgs.transferBody',
        button: 'PlatformOrgs.transfer',
        requireSlug: true,
      },
      org.status === 'archived'
        ? {
            act: 'unarchive',
            title: 'PlatformOrgs.unarchiveTitle',
            body: 'PlatformOrgs.unarchiveBody',
            button: 'PlatformOrgs.unarchive',
          }
        : {
            act: 'archive',
            title: 'PlatformOrgs.archiveTitle',
            body: 'PlatformOrgs.archiveBody',
            button: 'PlatformOrgs.archive',
          },
      {
        act: 'policy-refresh',
        title: 'PlatformOrgs.policyRefreshTitle',
        body: 'PlatformOrgs.policyRefreshBody',
        button: 'PlatformOrgs.policyRefresh',
      },
      {
        act: 'deletion',
        title: 'PlatformOrgs.deleteTitle',
        body: 'PlatformOrgs.deleteBody',
        button: 'PlatformOrgs.delete',
        destructive: true,
        requireSlug: true,
      },
    );
  }
  const candidates = (members.data?.internal ?? []).filter(
    (m) => m.role !== 'owner' && m.status === 'active',
  );
  return (
    <div className="tm-cc-column">
      {cards.map((card) => (
        <section
          key={card.act}
          className={card.destructive ? 'tm-cc-card tm-cc-card--attention' : 'tm-cc-card'}
          aria-labelledby={`tm-life-${card.act}`}
        >
          <div className="tm-cc-card__head">
            <h2 id={`tm-life-${card.act}`} className="tm-cc-card__title">
              {t(card.title)}
            </h2>
            {canAct ? (
              <Button
                type="button"
                tone={card.destructive ? 'destructive' : 'outline'}
                size="compact"
                onClick={() => {
                  setNewOwner('');
                  setOpen(card);
                }}
              >
                {t(card.button)}…
              </Button>
            ) : null}
          </div>
          <p className="tm-cc-note">
            {card.act === 'deletion'
              ? t('PlatformOrgs.deleteBody').replace('{days}', String(detail.retentionDays))
              : t(card.body)}
          </p>
        </section>
      ))}
      {org.status === 'deleted' ? (
        <p className="tm-cc-note">{t('PlatformOrgs.deletedNoActs')}</p>
      ) : null}
      {open ? (
        <ConfirmActDialog
          title={`${t(open.button)} · ${org.name}`}
          body={
            open.act === 'deletion'
              ? t('PlatformOrgs.deleteBody').replace('{days}', String(detail.retentionDays))
              : t(open.body)
          }
          slug={org.slug}
          requireSlug={open.requireSlug ?? false}
          destructive={open.destructive ?? false}
          confirmLabel={t(open.button)}
          onConfirm={(input) => {
            if (open.act === 'ownership-transfer' && newOwner === '') {
              return Promise.reject(new Error(t('PlatformOrgs.pickNewOwner')));
            }
            return runPlatformOrgLifecycle(api, org.id, open.act, {
              ...input,
              ...(open.act === 'ownership-transfer' ? { newOwnerMembershipId: newOwner } : {}),
            });
          }}
          onClose={(done) => {
            setOpen(null);
            if (done) void queryClient.invalidateQueries({ queryKey: ORGS_KEY });
          }}
        >
          {open.act === 'ownership-transfer' ? (
            <Select
              label={t('PlatformOrgs.newOwner')}
              hint={t('PlatformOrgs.formerOwnerHint')}
              value={newOwner}
              onChange={(e) => setNewOwner(e.target.value)}
            >
              <option value="">{t('PlatformOrgs.pickNewOwner')}</option>
              {candidates.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {m.displayName} · {m.email}
                </option>
              ))}
            </Select>
          ) : null}
        </ConfirmActDialog>
      ) : null}
    </div>
  );
}
