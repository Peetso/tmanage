'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { PlatformShell } from '../PlatformShell';
import type { LegacyPlatformSection, PlatformSection, PlatformSubsection } from '../PlatformShell';
import { useT } from '../../../lib/i18n/use-t';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError, NetworkError } from '../../../lib/api/errors';
import { fetchPlatformMe, stepUpPlatform } from '../../../lib/api/platform-admin';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import { PLATFORM_ME_QUERY_KEY } from './usePlatformPermissions';
import { appLocale } from '../../../lib/i18n/app-locale';

/**
 * The pieces every Platform admin screen shares, moved out of `PlatformAdminScreens.tsx`
 * unchanged (PA-02 split): the `me` gate with the step-up form, the reason box, and the
 * formatting helpers. Behaviour is exactly what it was before the split.
 */

export const PLATFORM_ME_KEY = PLATFORM_ME_QUERY_KEY;

export interface ScreenProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

export function describe(error: unknown, t: ReturnType<typeof useT>): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('PlatformAdminScreens.apiNoAnswer');
  return t('PlatformAdminScreens.genericError');
}

export function isStepUpLapse(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'reauthentication_required';
}

export function formatMoment(iso: string | null): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    at,
  );
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)} ${UNITS[unit]}`;
}

export function Loading({ label }: { label: string }) {
  return (
    <LoadingRegion label={label} className="tm-stack tm-stack--tight">
      <Skeleton height="var(--row)" />
      <Skeleton height="var(--row)" />
    </LoadingRegion>
  );
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * Reads `me`, then either refuses (404), asks for the step-up, or renders the screen. The
 * two-step banner shows for an operator without two-step sign-in on every screen.
 */
export function PlatformGate({
  api,
  section,
  subsection,
  crumbs,
  title,
  description,
  actions,
  children,
}: {
  api: ApiClient;
  section: PlatformSection | LegacyPlatformSection;
  subsection?: PlatformSubsection;
  crumbs: readonly string[];
  title: string;
  description?: ReactNode;
  /** Header actions, shown once the step-up is live (they lead to platform actions). */
  actions?: (me: PlatformMeView) => ReactNode;
  children: (me: PlatformMeView) => ReactNode;
}) {
  const t = useT();
  const me = useQuery({
    queryKey: PLATFORM_ME_KEY,
    queryFn: () => fetchPlatformMe(api),
    retry: false,
    // A lapsed confirmation re-opens the step-up form on its own, within a minute.
    refetchInterval: 60_000,
  });

  if (me.isError && me.error instanceof ApiRequestError && me.error.status === 404) {
    return (
      <PlatformShell
        section={section}
        crumbs={[t('PlatformAdminScreens.notFound')]}
        title={t('PlatformAdminScreens.pageNotFound')}
      >
        <InlineAlert tone="neutral" title={t('PlatformAdminScreens.pageDoesNotExist')}>
          <Link href="/organizations">{t('PlatformAdminScreens.backToOrganizations')}</Link>
        </InlineAlert>
      </PlatformShell>
    );
  }

  return (
    <PlatformShell
      section={section}
      {...(subsection ? { subsection } : {})}
      crumbs={crumbs}
      title={title}
      {...(description ? { description } : {})}
      {...(me.isSuccess ? { me: me.data } : {})}
      {...(me.isSuccess && me.data.stepUpExpiresAt !== null && actions
        ? { actions: actions(me.data) }
        : {})}
    >
      {me.isPending ? <Loading label={t('PlatformAdminScreens.checkingAccess')} /> : null}
      {me.isError ? (
        <InlineAlert tone="danger" title={t('PlatformAdminScreens.couldNotOpen')} live>
          {describe(me.error, t)}
        </InlineAlert>
      ) : null}
      {me.isSuccess && !me.data.mfaEnabled ? (
        <InlineAlert tone="warning" title={t('PlatformAdminScreens.setupTwoStepTitle')}>
          {t('PlatformAdminScreens.twoStepBody1')} {stepUpWindow(me.data.stepUpMinutes).count}{' '}
          {t(
            stepUpWindow(me.data.stepUpMinutes).hours
              ? 'PlatformAdminScreens.twoStepBody2Hours'
              : 'PlatformAdminScreens.twoStepBody2',
          )}{' '}
          <Link href="/organizations">{t('PlatformAdminScreens.yourOrganizations')}</Link>.
        </InlineAlert>
      ) : null}
      {me.isSuccess && me.data.stepUpExpiresAt === null ? (
        <StepUpForm api={api} me={me.data} />
      ) : null}
      {me.isSuccess && me.data.stepUpExpiresAt !== null ? children(me.data) : null}
    </PlatformShell>
  );
}

/**
 * The step-up window as the screen says it (PLATFORMFIX): the API's `stepUpMinutes` in whole
 * hours when it is a whole number of hours (the default, 24 hours), otherwise in minutes.
 */
export function stepUpWindow(minutes: number): { readonly count: number; readonly hours: boolean } {
  return minutes >= 60 && minutes % 60 === 0
    ? { count: minutes / 60, hours: true }
    : { count: minutes, hours: false };
}

export function StepUpForm({ api, me }: { api: ApiClient; me: PlatformMeView }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const confirm = useMutation({
    mutationFn: () => stepUpPlatform(api, me.mfaEnabled ? { password, code } : { password }),
    onSuccess: async () => {
      setPassword('');
      setCode('');
      // Every platform query refused before the step-up (`['platform', …]` and the
      // `'platform-…'` keys of the permission screens) loads again now that it is live.
      await queryClient.invalidateQueries({
        predicate: (query) =>
          typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('platform'),
      });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    confirm.mutate();
  }

  return (
    <section className="tm-cc-card" aria-labelledby="tm-platform-step-up-heading">
      <div className="tm-cc-card__head">
        <h2 id="tm-platform-step-up-heading" className="tm-cc-card__title">
          {t('PlatformAdminScreens.confirmItIsYou')}
        </h2>
      </div>
      <p className="tm-cc-note">
        {t('PlatformAdminScreens.stepUpNote1')}
        {me.mfaEnabled ? ` ${t('PlatformAdminScreens.stepUpAndCode')}` : ''}{' '}
        {t('PlatformAdminScreens.stepUpNote2')} {stepUpWindow(me.stepUpMinutes).count}{' '}
        {t(
          stepUpWindow(me.stepUpMinutes).hours
            ? 'PlatformAdminScreens.stepUpHoursWord'
            : 'PlatformAdminScreens.stepUpMinutesWord',
        )}
      </p>
      <form className="tm-stack tm-stack--tight" onSubmit={submit}>
        <Field
          label={t('PlatformAdminScreens.passwordLabel')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        {me.mfaEnabled ? (
          <Field
            label={t('PlatformAdminScreens.twoStepCodeLabel')}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        ) : null}
        {confirm.isError ? (
          <InlineAlert tone="danger" title={t('PlatformAdminScreens.notConfirmed')} live>
            {describe(confirm.error, t)}
          </InlineAlert>
        ) : null}
        <div>
          <Button
            type="submit"
            tone="ink"
            loading={confirm.isPending}
            loadingLabel={t('PlatformAdminScreens.confirming')}
          >
            {t('PlatformAdminScreens.continue')}
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * The reason box every action opens. The action runs only once a reason is typed; a lapsed
 * confirmation re-opens the step-up form through the `me` query.
 */
export function ReasonAction({
  label,
  confirmLabel,
  tone = 'outline',
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  tone?: 'outline' | 'destructive' | 'ink';
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const action = useMutation({
    mutationFn: () => onConfirm(reason.trim()),
    onSuccess: () => {
      setOpen(false);
      setReason('');
    },
    onError: async (error) => {
      if (isStepUpLapse(error)) await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_KEY });
    },
  });

  if (!open) {
    return (
      <Button type="button" tone={tone} size="compact" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }

  return (
    <form
      className="tm-stack tm-stack--tight"
      onSubmit={(event) => {
        event.preventDefault();
        action.mutate();
      }}
    >
      <Field
        label={`${t('PlatformAdminScreens.reasonFor')} “${label}”`}
        hint={t('PlatformAdminScreens.reasonHint')}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        minLength={5}
        maxLength={500}
        required
      />
      {action.isError ? (
        <InlineAlert tone="danger" title={t('PlatformAdminScreens.notDone')} live>
          {describe(action.error, t)}
        </InlineAlert>
      ) : null}
      <div className="tm-cc-hero__actions">
        <Button
          type="submit"
          tone={tone === 'outline' ? 'ink' : tone}
          size="compact"
          loading={action.isPending}
          loadingLabel={t('PlatformAdminScreens.working')}
          disabled={reason.trim().length < 5}
        >
          {confirmLabel}
        </Button>
        <Button type="button" tone="text" size="compact" onClick={() => setOpen(false)}>
          {t('PlatformAdminScreens.cancel')}
        </Button>
      </div>
    </form>
  );
}
