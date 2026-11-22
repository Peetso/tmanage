'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Radio, RadioGroup, Select } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import { listPlatformCompanies, stepUpPlatform } from '../../../lib/api/platform-admin';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  MICRO_USD_PER_CENT,
  grantAiPack,
  releaseAiReserve,
  setAiTestListEntry,
  updateAiBudget,
} from '../../../lib/api/ai-spend';
import type {
  AiAdminPool,
  AiBudgetView,
  AiPackRequestQueueView,
  AiPoolClass,
  AiTestListEntryView,
} from '../../../lib/api/ai-spend';
import { useFormCheck } from '../../../lib/forms/form-check';
import { useAiText } from '../../ai-chat/use-ai-text';
import type { AiTextKey } from '../../ai-chat/use-ai-text';
import { PLATFORM_ME_QUERY_KEY } from '../shared/usePlatformPermissions';
import { PlatformDialog, platformErrorText } from '../shared/ReasonDialog';
import { useT } from '../../../lib/i18n/use-t';
import {
  POOL_CLASSES,
  capsTotalWith,
  centsOf,
  dollarsToCents,
  packSizes,
  poolRow,
  stepUpFresh,
  usd,
} from './ai-spend-model';

export const AI_BUDGET_KEY = ['platform', 'ai-budget'] as const;
export const AI_TEST_LIST_KEY = ['platform', 'ai-test-list'] as const;

export const POOL_LABEL: Record<AiAdminPool, AiTextKey> = {
  customers: 'AiSpend.pool.customers',
  testing: 'AiSpend.pool.testing',
  reserve: 'AiSpend.pool.reserve',
};

const REASON_MIN = 5;
const REASON_MAX = 500;

/** The reason every change carries (`requireReason`: 5 to 500 characters), written to the log. */
function ReasonField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}) {
  const { t } = useAiText();
  return (
    <Field
      label={t('AiSpend.reason')}
      name="reason"
      placeholder={t('AiSpend.reasonPlaceholder')}
      hint={t('AiSpend.reasonHint')}
      value={value}
      minLength={REASON_MIN}
      maxLength={REASON_MAX}
      required
      autoComplete="off"
      onChange={(event) => onChange(event.target.value)}
      {...(error === undefined ? {} : { error })}
    />
  );
}

function useDialogFocus() {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);
  return ref;
}

function Actions({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  const { t } = useAiText();
  return (
    <div className="tm-ais-dialog__actions">
      {children}
      <span className="tm-ais-spacer" />
      <Button type="button" tone="text" onClick={onCancel}>
        {t('AiSpend.cancel')}
      </Button>
    </div>
  );
}

function ErrorLine({ error }: { error: unknown }) {
  const t = useT();
  return (
    <InlineAlert tone="danger" live>
      {platformErrorText(error, t)}
    </InlineAlert>
  );
}

interface DialogBase {
  readonly api: ApiClient;
  readonly onClose: (done: boolean) => void;
}

/** Figma G13 v2 785:48413 (Change cap) and 785:48502 (above the ceiling). */
export function ChangeCapDialog({
  api,
  view,
  pool,
  onClose,
}: DialogBase & { readonly view: AiBudgetView; readonly pool: AiAdminPool }) {
  const { t, locale } = useAiText();
  const queryClient = useQueryClient();
  const form = useDialogFocus();
  const row = poolRow(view, pool);
  const [amount, setAmount] = useState(String(centsOf(view.capsMicroUsd[pool]) / 100));
  const [applyTo, setApplyTo] = useState<'this_month' | 'next_month'>('this_month');
  const [reason, setReason] = useState('');
  const check = useFormCheck({
    messages: { amount: t('AiSpend.cap.amountError'), reason: t('AiSpend.reasonError') },
  });
  const cents = dollarsToCents(amount);
  const total = cents === null ? null : capsTotalWith(view, pool, cents * MICRO_USD_PER_CENT);
  const aboveCeiling = total !== null && total > view.ceilingMicroUsd;
  const save = useMutation({
    mutationFn: () =>
      updateAiBudget(api, {
        customersCents: pool === 'customers' ? cents! : centsOf(view.capsMicroUsd.customers),
        testingCents: pool === 'testing' ? cents! : centsOf(view.capsMicroUsd.testing),
        reserveCents: pool === 'reserve' ? cents! : centsOf(view.capsMicroUsd.reserve),
        sonnetEnabled: view.sonnetEnabled,
        applyTo,
        reason: reason.trim(),
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(AI_BUDGET_KEY, next);
      onClose(true);
    },
  });
  const amountError =
    cents === null && amount.trim() !== ''
      ? t('AiSpend.cap.amountError')
      : aboveCeiling
        ? t('AiSpend.cap.aboveCeiling', {
            total: usd(total, locale),
            ceiling: usd(view.ceilingMicroUsd, locale),
          })
        : check.error('amount');

  return (
    <PlatformDialog
      title={t('AiSpend.cap.title', { pool: t(POOL_LABEL[pool]) })}
      onClose={() => onClose(false)}
    >
      <form
        ref={form}
        noValidate
        className="tm-stack"
        {...check.handlers(() => {
          if (cents !== null && !aboveCeiling && !save.isPending) save.mutate();
        })}
      >
        <Field
          label={t('AiSpend.cap.newCap')}
          name="amount"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          required
          value={amount}
          hint={t('AiSpend.cap.spent', { amount: usd(row.settledMicroUsd, locale) })}
          onChange={(event) => setAmount(event.target.value)}
          {...(amountError === undefined ? {} : { error: amountError })}
        />
        <RadioGroup legend={t('AiSpend.cap.appliesFrom')}>
          <Radio
            label={t('AiSpend.cap.thisMonth')}
            checked={applyTo === 'this_month'}
            onChange={() => setApplyTo('this_month')}
          />
          <Radio
            label={t('AiSpend.cap.nextMonth')}
            checked={applyTo === 'next_month'}
            onChange={() => setApplyTo('next_month')}
          />
        </RadioGroup>
        {total !== null && !aboveCeiling ? (
          <p className="tm-ais-muted">
            {t('AiSpend.cap.together', {
              ceiling: usd(view.ceilingMicroUsd, locale),
              total: usd(total, locale),
            })}
          </p>
        ) : null}
        <ReasonField value={reason} onChange={setReason} error={check.error('reason')} />
        {save.isError ? <ErrorLine error={save.error} /> : null}
        <Actions onCancel={() => onClose(false)}>
          <Button type="submit" tone="ink" disabled={aboveCeiling} loading={save.isPending}>
            {t('AiSpend.cap.save')}
          </Button>
        </Actions>
      </form>
    </PlatformDialog>
  );
}

/**
 * Figma 785:48709 (Release reserve), 785:48801 (not enough reserve), 785:48886 (confirm it's you
 * again). The API wants a step-up confirmed in the last 15 minutes; when the current one is older
 * the dialog asks for the password (and code) first, then moves the money in the same submit.
 */
export function ReleaseReserveDialog({
  api,
  view,
  me,
  now = () => new Date(),
  onClose,
}: DialogBase & {
  readonly view: AiBudgetView;
  readonly me: PlatformMeView;
  readonly now?: () => Date;
}) {
  const { t, locale } = useAiText();
  const queryClient = useQueryClient();
  const form = useDialogFocus();
  const free = poolRow(view, 'reserve').remainingMicroUsd;
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState<AiPoolClass>('customers');
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stale, setStale] = useState(false);
  const needsStepUp = stale || !stepUpFresh(me.stepUpExpiresAt, me.stepUpMinutes, now());
  const check = useFormCheck({
    messages: {
      amount: t('AiSpend.reserve.amountError'),
      reason: t('AiSpend.reasonError'),
    },
  });
  const cents = dollarsToCents(amount);
  const tooMuch = cents !== null && cents * MICRO_USD_PER_CENT > free;
  const move = useMutation({
    mutationFn: async () => {
      if (needsStepUp) {
        await stepUpPlatform(
          api,
          me.stepUpNeedsAuthenticatorCode
            ? { password, code: code.replace(/\D/gu, '') }
            : { password },
        );
      }
      return releaseAiReserve(api, { to, amountCents: cents!, reason: reason.trim() });
    },
    onSuccess: async (next) => {
      queryClient.setQueryData(AI_BUDGET_KEY, next);
      await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
      onClose(true);
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
        setStale(true);
        setPassword('');
      }
    },
  });
  const refusedStepUp =
    move.error instanceof ApiRequestError && move.error.code === 'reauthentication_required';
  const amountError =
    cents === null && amount.trim() !== ''
      ? t('AiSpend.reserve.amountError')
      : tooMuch
        ? t('AiSpend.reserve.notEnough', { amount: usd(free, locale) })
        : check.error('amount');
  const label =
    cents !== null && cents > 0
      ? t('AiSpend.reserve.move', { amount: usd(cents * MICRO_USD_PER_CENT, locale) })
      : t('AiSpend.reserve.moveEmpty');

  return (
    <PlatformDialog title={t('AiSpend.reserve.title')} onClose={() => onClose(false)}>
      <form
        ref={form}
        noValidate
        className="tm-stack"
        {...check.handlers(() => {
          if (cents !== null && cents > 0 && !tooMuch && !move.isPending) move.mutate();
        })}
      >
        <Field
          label={t('AiSpend.reserve.amount')}
          name="amount"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          required
          value={amount}
          hint={t('AiSpend.reserve.free', { amount: usd(free, locale) })}
          onChange={(event) => setAmount(event.target.value)}
          {...(amountError === undefined ? {} : { error: amountError })}
        />
        <Select
          label={t('AiSpend.reserve.to')}
          name="to"
          value={to}
          onChange={(event) => setTo(event.target.value as AiPoolClass)}
        >
          {POOL_CLASSES.map((pool) => (
            <option key={pool} value={pool}>
              {t(POOL_LABEL[pool])}
            </option>
          ))}
        </Select>
        <ReasonField value={reason} onChange={setReason} error={check.error('reason')} />
        {needsStepUp ? (
          <div className="tm-ais-confirm">
            <p className="tm-ais-confirm__title">{t('AiSpend.reserve.confirmTitle')}</p>
            {stale || refusedStepUp ? (
              <InlineAlert tone="warning" live>
                {t('AiSpend.reserve.staleStepUp')}
              </InlineAlert>
            ) : (
              <p className="tm-ais-muted">{t('AiSpend.reserve.confirmBody')}</p>
            )}
            <Field
              label={t('AiSpend.reserve.password')}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              {...(check.error('password') === undefined ? {} : { error: check.error('password') })}
            />
            {me.stepUpNeedsAuthenticatorCode ? (
              <Field
                label={t('AiSpend.reserve.code')}
                name="code"
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
                {...(check.error('code') === undefined ? {} : { error: check.error('code') })}
              />
            ) : null}
          </div>
        ) : null}
        {move.isError && !refusedStepUp ? <ErrorLine error={move.error} /> : null}
        <Actions onCancel={() => onClose(false)}>
          <Button type="submit" tone="ink" disabled={tooMuch} loading={move.isPending}>
            {label}
          </Button>
        </Actions>
      </form>
    </PlatformDialog>
  );
}

/** Figma 785:48973: which pool a test workspace pays from, or remove it from the list. */
export function WorkspaceOptionsDialog({
  api,
  entry,
  onClose,
}: DialogBase & { readonly entry: AiTestListEntryView }) {
  const { t } = useAiText();
  const queryClient = useQueryClient();
  const form = useDialogFocus();
  const [poolClass, setPoolClass] = useState<AiPoolClass>(entry.poolClass);
  const [reason, setReason] = useState('');
  const [intent, setIntent] = useState<'save' | 'remove'>('save');
  const check = useFormCheck({ messages: { reason: t('AiSpend.reasonError') } });
  const save = useMutation({
    mutationFn: (remove: boolean) =>
      setAiTestListEntry(
        api,
        entry.organizationId,
        remove
          ? { onTestList: false, reason: reason.trim() }
          : { onTestList: true, poolClass, reason: reason.trim() },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: AI_TEST_LIST_KEY });
      onClose(true);
    },
  });

  return (
    <PlatformDialog
      title={t('AiSpend.workspace.title', { name: entry.name })}
      onClose={() => onClose(false)}
    >
      <form
        ref={form}
        noValidate
        className="tm-stack"
        {...check.handlers(() => {
          if (!save.isPending) save.mutate(intent === 'remove');
        })}
      >
        <RadioGroup legend={t('AiSpend.workspace.paysFrom')}>
          {POOL_CLASSES.map((pool) => (
            <Radio
              key={pool}
              label={t(
                pool === 'customers' ? 'AiSpend.workspace.customers' : 'AiSpend.workspace.testing',
              )}
              checked={poolClass === pool}
              onChange={() => setPoolClass(pool)}
            />
          ))}
        </RadioGroup>
        <hr className="tm-ais-divider" />
        <p className="tm-ais-muted">{t('AiSpend.workspace.removeNote')}</p>
        <div>
          <Button
            type="submit"
            tone="destructive"
            loading={save.isPending && intent === 'remove'}
            onClick={() => setIntent('remove')}
          >
            {t('AiSpend.workspace.remove')}
          </Button>
        </div>
        <ReasonField value={reason} onChange={setReason} error={check.error('reason')} />
        {save.isError ? <ErrorLine error={save.error} /> : null}
        <Actions onCancel={() => onClose(false)}>
          <Button
            type="submit"
            tone="ink"
            loading={save.isPending && intent === 'save'}
            onClick={() => setIntent('save')}
          >
            {t('AiSpend.workspace.save')}
          </Button>
        </Actions>
      </form>
    </PlatformDialog>
  );
}

/** "Add workspace" (no frame of its own; built from the options dialog 785:48973). */
export function AddWorkspaceDialog({
  api,
  listed,
  onClose,
}: DialogBase & { readonly listed: ReadonlySet<string> }) {
  const { t } = useAiText();
  const queryClient = useQueryClient();
  const form = useDialogFocus();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [poolClass, setPoolClass] = useState<AiPoolClass>('testing');
  const [reason, setReason] = useState('');
  const check = useFormCheck({ messages: { reason: t('AiSpend.reasonError') } });
  const companies = useQuery({
    queryKey: ['platform', 'ai-test-list', 'companies', search.trim()],
    queryFn: () => listPlatformCompanies(api, search),
    enabled: search.trim().length >= 2,
    retry: false,
  });
  const options = (companies.data ?? []).filter((company) => !listed.has(company.id));
  const add = useMutation({
    mutationFn: () =>
      setAiTestListEntry(api, picked!, { onTestList: true, poolClass, reason: reason.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: AI_TEST_LIST_KEY });
      onClose(true);
    },
  });

  return (
    <PlatformDialog title={t('AiSpend.add.title')} onClose={() => onClose(false)}>
      <form
        ref={form}
        noValidate
        className="tm-stack"
        {...check.handlers(() => {
          if (picked !== null && !add.isPending) add.mutate();
        })}
      >
        <Field
          label={t('AiSpend.add.search')}
          type="search"
          name="search"
          autoComplete="off"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPicked(null);
          }}
        />
        {search.trim().length >= 2 && companies.isSuccess ? (
          options.length === 0 ? (
            <p className="tm-ais-muted">{t('AiSpend.add.none')}</p>
          ) : (
            <RadioGroup legend={t('AiSpend.add.workspace')}>
              {options.slice(0, 8).map((company) => (
                <Radio
                  key={company.id}
                  label={company.name}
                  checked={picked === company.id}
                  onChange={() => setPicked(company.id)}
                />
              ))}
            </RadioGroup>
          )
        ) : null}
        <RadioGroup legend={t('AiSpend.workspace.paysFrom')}>
          {POOL_CLASSES.map((pool) => (
            <Radio
              key={pool}
              label={t(
                pool === 'customers' ? 'AiSpend.workspace.customers' : 'AiSpend.workspace.testing',
              )}
              checked={poolClass === pool}
              onChange={() => setPoolClass(pool)}
            />
          ))}
        </RadioGroup>
        <ReasonField value={reason} onChange={setReason} error={check.error('reason')} />
        {add.isError ? <ErrorLine error={add.error} /> : null}
        <Actions onCancel={() => onClose(false)}>
          <Button type="submit" tone="ink" disabled={picked === null} loading={add.isPending}>
            {t('AiSpend.add.confirm')}
          </Button>
        </Actions>
      </form>
    </PlatformDialog>
  );
}

/** Figma 785:49055: grant extra credits, answering an open request or on the admin's own. */
export function GrantDialog({
  api,
  entry,
  request,
  maxPackCredits,
  onClose,
}: DialogBase & {
  readonly entry: Pick<AiTestListEntryView, 'organizationId' | 'name'>;
  readonly request: AiPackRequestQueueView | null;
  readonly maxPackCredits: number;
}) {
  const { t, number } = useAiText();
  const queryClient = useQueryClient();
  const form = useDialogFocus();
  const sizes = packSizes(maxPackCredits);
  const [size, setSize] = useState(sizes.includes(5000) ? 5000 : sizes[sizes.length - 1]!);
  const [reason, setReason] = useState('');
  // One key per opened dialog: a retried submit replays the grant instead of granting twice.
  const [key] = useState(() => globalThis.crypto.randomUUID());
  const check = useFormCheck({ messages: { reason: t('AiSpend.reasonError') } });
  const grant = useMutation({
    mutationFn: () =>
      grantAiPack(api, entry.organizationId, {
        sizeCredits: size,
        requestId: request?.id ?? null,
        reason: reason.trim(),
        idempotencyKey: key,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: AI_TEST_LIST_KEY });
      onClose(true);
    },
  });

  return (
    <PlatformDialog
      title={t('AiSpend.grant.title', { name: entry.name })}
      onClose={() => onClose(false)}
    >
      <form
        ref={form}
        noValidate
        className="tm-stack"
        {...check.handlers(() => {
          if (!grant.isPending) grant.mutate();
        })}
      >
        <Select
          label={t('AiSpend.grant.credits')}
          name="size"
          value={String(size)}
          hint={t('AiSpend.grant.expiry')}
          onChange={(event) => setSize(Number(event.target.value))}
        >
          {sizes.map((option) => (
            <option key={option} value={option}>
              {number(option)}
            </option>
          ))}
        </Select>
        <ReasonField value={reason} onChange={setReason} error={check.error('reason')} />
        {grant.isError ? <ErrorLine error={grant.error} /> : null}
        <Actions onCancel={() => onClose(false)}>
          <Button type="submit" tone="ink" loading={grant.isPending}>
            {t('AiSpend.grant.confirm', { count: number(size) })}
          </Button>
        </Actions>
      </form>
    </PlatformDialog>
  );
}
