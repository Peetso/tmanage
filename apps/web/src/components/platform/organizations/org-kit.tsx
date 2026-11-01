'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, StatusDot } from '@tmanage/ui';
import type { StatusTone } from '@tmanage/ui';
import { ApiRequestError } from '../../../lib/api/errors';
import type {
  PlatformOrgHealth,
  PlatformOrgStatus,
  PlatformOrgSummaryView,
} from '../../../lib/api/platform-organizations';
import { useT } from '../../../lib/i18n/use-t';
import type { MessageKey } from '../../../lib/i18n/t';
import {
  PlatformDialog,
  PlatformDialogActions,
  platformErrorText,
  REASON_MAX,
  REASON_MIN,
} from '../shared/ReasonDialog';
import { PLATFORM_ME_QUERY_KEY } from '../shared/usePlatformPermissions';
import { SupportModeEntry } from '../support/SupportModeEntry';
import { appLocale } from '../../../lib/i18n/app-locale';

/**
 * Pieces every Platform admin · Organizations screen (A1–A7, A9) shares: the status dot, the
 * health and plan chips, the storage bar, the organization header with its tabs, and the
 * typed-slug confirmation the destructive acts use.
 */

export const ORGS_KEY = ['platform', 'organizations'] as const;

export function orgKey(id: string, ...rest: string[]) {
  return ['platform', 'organizations', id, ...rest] as const;
}

const STATUS_TONE: Record<PlatformOrgStatus, StatusTone> = {
  active: 'success',
  suspended: 'danger',
  deleted: 'warning',
  archived: 'neutral',
};

const STATUS_LABEL: Record<PlatformOrgStatus, MessageKey> = {
  active: 'PlatformOrgs.statusActive',
  suspended: 'PlatformOrgs.statusSuspended',
  deleted: 'PlatformOrgs.statusDeleted',
  archived: 'PlatformOrgs.statusArchived',
};

export function OrgStatus({ status }: { status: PlatformOrgStatus }) {
  const t = useT();
  return <StatusDot tone={STATUS_TONE[status]}>{t(STATUS_LABEL[status])}</StatusDot>;
}

const HEALTH: Record<PlatformOrgHealth, { key: MessageKey; className: string }> = {
  good: { key: 'PlatformOrgs.healthGood', className: 'tm-cc-pill tm-cc-pill--on' },
  check: { key: 'PlatformOrgs.healthCheck', className: 'tm-cc-pill tm-cc-pill--warning' },
  failing: { key: 'PlatformOrgs.healthFailing', className: 'tm-cc-pill tm-cc-pill--danger' },
};

export function OrgHealth({ health }: { health: PlatformOrgHealth }) {
  const t = useT();
  return <span className={HEALTH[health].className}>{t(HEALTH[health].key)}</span>;
}

const PLAN_LABEL: Record<string, MessageKey> = {
  free: 'PlatformOrgs.planFree',
  starter: 'PlatformOrgs.planStarter',
  studio: 'PlatformOrgs.planStudio',
  business: 'PlatformOrgs.planBusiness',
  enterprise: 'PlatformOrgs.planEnterprise',
};

export function usePlanLabel() {
  const t = useT();
  return (plan: string | null) =>
    plan && PLAN_LABEL[plan] ? t(PLAN_LABEL[plan]) : t('PlatformOrgs.planFree');
}

export function PlanChip({ plan }: { plan: string | null }) {
  const label = usePlanLabel();
  return <span className="tm-cc-pill tm-cc-pill--muted">{label(plan)}</span>;
}

const GB = 1024 ** 3;

export function formatGb(bytes: number): string {
  const value = bytes / GB;
  if (value === 0) return '0';
  return value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
}

/** "38 / 100 GB" with a bar; red when over the limit. */
export function StorageBar({ used, limit }: { used: number; limit: number }) {
  const t = useT();
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  const over = limit > 0 && used > limit;
  return (
    <div className="tm-stack tm-stack--tight">
      <span className="tm-cc-cell-mono" {...(over ? { style: { color: 'var(--tm-danger)' } } : {})}>
        {formatGb(used)} / {formatGb(limit)} {t('PlatformOrgs.gb')}
      </span>
      <span className="tm-cc-bar" aria-hidden="true">
        <span
          className="tm-cc-bar__fill"
          style={{
            inlineSize: `${Math.round(share * 100)}%`,
            ...(over ? { background: 'var(--tm-danger)' } : {}),
          }}
        />
      </span>
    </div>
  );
}

export function formatDay(iso: string | null): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return new Intl.DateTimeFormat(appLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(at);
}

export function useRelative() {
  const t = useT();
  return (iso: string | null): string => {
    if (iso === null) return t('PlatformOrgs.never');
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (Number.isNaN(minutes)) return '—';
    if (minutes < 1) return t('PlatformOrgs.justNow');
    if (minutes < 60) return `${minutes} ${t('PlatformOrgs.minutesAgo')}`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} ${t('PlatformOrgs.hoursAgo')}`;
    return `${Math.round(hours / 24)} ${t('PlatformOrgs.daysAgo')}`;
  };
}

export function initials(name: string): string {
  return (
    name
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '·'
  );
}

export type OrgTab =
  'overview' | 'settings' | 'plan' | 'members' | 'content' | 'activity' | 'lifecycle';

const TABS: readonly { id: OrgTab; key: MessageKey; href: (id: string) => string }[] = [
  {
    id: 'overview',
    key: 'PlatformOrgs.tabOverview',
    href: (id) => `/platform/organizations/${id}`,
  },
  {
    id: 'settings',
    key: 'PlatformOrgs.tabSettings',
    href: (id) => `/platform/organizations/${id}/settings`,
  },
  { id: 'plan', key: 'PlatformOrgs.tabPlan', href: (id) => `/platform/organizations/${id}/plan` },
  {
    id: 'members',
    key: 'PlatformOrgs.tabMembers',
    href: (id) => `/platform/organizations/${id}/members`,
  },
  {
    id: 'content',
    key: 'PlatformOrgs.tabContent',
    href: (id) => `/platform/organizations/${id}/content`,
  },
  {
    id: 'activity',
    key: 'PlatformOrgs.tabActivity',
    href: (id) => `/platform/activity?organizationId=${id}`,
  },
  {
    id: 'lifecycle',
    key: 'PlatformOrgs.tabLifecycle',
    href: (id) => `/platform/organizations/${id}/lifecycle`,
  },
];

/** A3's header (avatar, name, status, plan, mono facts, Support mode) and the tab row. */
export function OrgHeader({
  organization,
  tab,
  memberCount,
}: {
  organization: PlatformOrgSummaryView;
  tab: OrgTab;
  memberCount?: number;
}) {
  const t = useT();
  return (
    <div className="tm-stack">
      <section className="tm-cc-card tm-cc-hero" aria-label={organization.name}>
        <div className="tm-cc-person">
          <span className="tm-cc-avatar" aria-hidden="true">
            {initials(organization.name)}
          </span>
          <div className="tm-stack tm-stack--tight">
            <div className="tm-cc-hero__actions">
              <h2 className="tm-cc-card__title">{organization.name}</h2>
              <OrgStatus status={organization.status} />
              <PlanChip plan={organization.plan} />
            </div>
            <p className="tm-cc-cell-mono">
              {organization.slug} · {t('PlatformOrgs.idShort')} {organization.id.slice(0, 4)}…
              {organization.id.slice(-4)} · {t('PlatformOrgs.ownerShort')}{' '}
              {organization.ownerEmail ?? '—'} · {t('PlatformOrgs.createdShort')}{' '}
              {formatDay(organization.createdAt)}
            </p>
          </div>
        </div>
        <div className="tm-cc-hero__actions">
          <Link
            className="tm-cc-row-button"
            href={`/platform/organizations/${organization.id}/lifecycle`}
          >
            {t('PlatformOrgs.actions')}
          </Link>
          {organization.status !== 'deleted' ? (
            <SupportModeEntry
              organizationId={organization.id}
              organizationName={organization.name}
              status={organization.status}
            />
          ) : null}
        </div>
      </section>
      <nav aria-label={t('PlatformOrgs.tabsLabel')} className="tm-chip-row">
        {TABS.map((item) => (
          <Link
            key={item.id}
            href={item.href(organization.id)}
            className={item.id === tab ? 'tm-chip tm-chip--active' : 'tm-chip'}
            {...(item.id === tab ? { 'aria-current': 'page' as const } : {})}
          >
            {t(item.key)}
            {item.id === 'members' && memberCount !== undefined ? ` ${memberCount}` : ''}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** The suspended and deleted banners under the header. */
export function OrgBanners({
  organization,
  restoreDaysLeft,
  onRestore,
}: {
  organization: PlatformOrgSummaryView;
  restoreDaysLeft: number | null;
  onRestore?: () => void;
}) {
  const t = useT();
  if (organization.status === 'deleted') {
    return (
      <InlineAlert tone="warning" title={t('PlatformOrgs.deletedBannerTitle')}>
        {t('PlatformOrgs.deletedBannerBody')} {formatDay(organization.purgeAfter)}.{' '}
        {onRestore ? (
          <Button type="button" tone="outline" size="compact" onClick={onRestore}>
            {t('PlatformOrgs.restoreDaysLeft').replace('{days}', String(restoreDaysLeft ?? 0))}
          </Button>
        ) : null}
      </InlineAlert>
    );
  }
  if (organization.status === 'suspended') {
    return (
      <InlineAlert tone="danger" title={t('PlatformOrgs.suspendedBannerTitle')}>
        {t('PlatformOrgs.suspendedBannerBody')} {formatDay(organization.suspendedAt)}.
      </InlineAlert>
    );
  }
  return null;
}

/**
 * Confirm a lifecycle act: optional preview, the typed slug when asked ("Must match exactly"),
 * and the required reason. The confirm button stays disabled until both are valid.
 */
export function ConfirmActDialog({
  title,
  body,
  slug,
  requireSlug,
  confirmLabel,
  destructive = false,
  children,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  body?: ReactNode;
  slug: string;
  requireSlug: boolean;
  confirmLabel: string;
  destructive?: boolean;
  children?: ReactNode;
  onConfirm: (input: { reason: string; confirmSlug?: string }) => Promise<unknown>;
  onClose: (done: boolean) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const first = useRef<HTMLDivElement>(null);
  const trimmed = reason.trim();
  const reasonOk = trimmed.length >= REASON_MIN && trimmed.length <= REASON_MAX;
  const slugOk = !requireSlug || typed.trim() === slug;
  const act = useMutation({
    mutationFn: () =>
      onConfirm({ reason: trimmed, ...(requireSlug ? { confirmSlug: typed.trim() } : {}) }),
    onSuccess: () => onClose(true),
    onError: async (error) => {
      if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
        await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
      }
    },
  });
  useEffect(() => {
    first.current?.querySelector('input')?.focus();
  }, []);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (slugOk && reasonOk) act.mutate();
  }
  return (
    <PlatformDialog
      eyebrow={`${t('PlatformShared.platformAdmin')} · ${t('PlatformShared.reasonRequiredTag')}`}
      title={title}
      onClose={() => onClose(false)}
    >
      <form className="tm-stack" onSubmit={submit} noValidate>
        {body ? <p className="tm-cc-note">{body}</p> : null}
        {children}
        <div ref={first} className="tm-stack tm-stack--tight">
          {requireSlug ? (
            <Field
              label={t('PlatformOrgs.typeSlug')}
              hint={`${t('PlatformOrgs.mustMatch')} · ${slug}`}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          ) : null}
          <Field
            label={t('PlatformShared.reasonRequired')}
            placeholder={t('PlatformShared.reasonPlaceholder')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={REASON_MAX}
            required
          />
        </div>
        {act.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(act.error, t)}
          </InlineAlert>
        ) : null}
        <PlatformDialogActions>
          <Button type="button" tone="outline" onClick={() => onClose(false)}>
            {t('PlatformShared.cancel')}
          </Button>
          <Button
            type="submit"
            tone={destructive ? 'destructive' : 'ink'}
            disabled={!slugOk || !reasonOk}
            loading={act.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {confirmLabel}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}
