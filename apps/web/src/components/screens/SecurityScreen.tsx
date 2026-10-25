'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  InlineAlert,
  LoadingRegion,
  Skeleton,
  StateCapsule,
  type CapsuleState,
} from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  DEFAULT_TOKEN_EXPIRY,
  TOKEN_EXPIRY_CHOICES,
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
  tokenStatus,
} from '../../lib/api/personal-access-tokens';
import type {
  CreatedPersonalAccessTokenView,
  PersonalAccessTokenView,
  TokenExpiryDays,
  TokenStatus,
} from '../../lib/api/personal-access-tokens';
import { describeApiErrorNow, OFFLINE_LINES } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/access-security.css';

export interface SecurityScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** "Now", for the expiry status. Injected by tests. */
  now?: () => Date;
}

/**
 * **Access tokens (t2-d) — the one place a member creates, reads and revokes their tokens.**
 *
 * A token lets another tool (Claude, ChatGPT, a script) work in TManage as the member. Every token
 * expires: the create dialog requires 30, 90 or 365 days and never sends `null`. The plaintext is
 * shown once, in the dialog, right after creation. Revoking (or removing an expired token) asks
 * first. Revoked tokens leave the list. The server scopes everything to the caller's membership.
 */
export function SecurityScreen({
  organizationSlug,
  organizationName,
  client,
  now = () => new Date(),
}: SecurityScreenProps) {
  const t = useT();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['personal-access-tokens', organizationSlug] as const;

  const tokens = useQuery({
    queryKey,
    queryFn: () => listPersonalAccessTokens(api, organizationSlug),
  });

  const [creating, setCreating] = useState<{ name: string } | null>(null);
  const [confirming, setConfirming] = useState<PersonalAccessTokenView | null>(null);

  const revoke = useMutation({
    mutationFn: (tokenId: string) => revokePersonalAccessToken(api, organizationSlug, tokenId),
    onSuccess: (_, tokenId) => {
      queries.setQueryData<readonly PersonalAccessTokenView[]>(queryKey, (old) =>
        old?.filter((token) => token.id !== tokenId),
      );
      setConfirming(null);
      void queries.invalidateQueries({ queryKey });
    },
  });

  const at = now();
  const visible = (tokens.data ?? []).filter((token) => token.revokedAt === null);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={t('AccessTokens.eyebrow')}
      title={t('AccessTokens.title')}
      description={t('AccessTokens.description')}
    >
      <div className="tm-sec">
        <section className="tm-sec-card" aria-label={t('AccessTokens.title')}>
          <div>
            <Button tone="ink" onClick={() => setCreating({ name: '' })}>
              {t('AccessTokens.newToken')}
            </Button>
          </div>

          {tokens.isPending ? (
            <LoadingRegion label={t('AccessTokens.loading')}>
              <Skeleton />
            </LoadingRegion>
          ) : tokens.isError ? (
            <InlineAlert tone="danger" title={t('AccessTokens.loadError')}>
              {errorMessage(tokens.error)}
            </InlineAlert>
          ) : visible.length === 0 ? (
            <p className="tm-sec-card__body">{t('AccessTokens.empty')}</p>
          ) : (
            <ul className="tm-sec-tokens">
              {visible.map((token) => {
                const status = tokenStatus(token, at);
                return (
                  <li key={token.id} className="tm-sec-token" data-testid="tm-token-row">
                    <TokenText token={token} status={status} now={at} />
                    <StateCapsule state={CAPSULE[status]}>{t(STATUS_LABEL[status])}</StateCapsule>
                    <Button
                      tone="text"
                      className="tm-sec-token__action"
                      aria-label={`${t(ACTION_LABEL[status])} ${token.name}`}
                      onClick={() =>
                        status === 'expiring'
                          ? setCreating({ name: token.name })
                          : setConfirming(token)
                      }
                    >
                      {t(ACTION_LABEL[status])}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          <InlineAlert tone="neutral">{t('AccessTokens.defaultNote')}</InlineAlert>
        </section>
      </div>

      {creating ? (
        <CreateTokenDialog
          initialName={creating.name}
          onClose={() => setCreating(null)}
          create={(input) => createPersonalAccessToken(api, organizationSlug, input)}
          onCreated={() => void queries.invalidateQueries({ queryKey })}
        />
      ) : null}

      {confirming ? (
        <Dialog
          title={
            tokenStatus(confirming, at) === 'expired'
              ? t('AccessTokens.confirmRemoveTitle')
              : t('AccessTokens.confirmRevokeTitle')
          }
          onClose={() => setConfirming(null)}
        >
          <p className="tm-sec-card__body">
            <strong>{confirming.name}</strong> · {t('AccessTokens.confirmRevokeBody')}
          </p>
          {revoke.isError ? (
            <InlineAlert tone="danger" title={t('AccessTokens.revokeError')} live>
              {errorMessage(revoke.error)}
            </InlineAlert>
          ) : null}
          <div className="tm-sec-actions">
            <Button tone="outline" onClick={() => setConfirming(null)}>
              {t('AccessTokens.cancel')}
            </Button>
            <Button
              tone="destructive"
              loading={revoke.isPending}
              loadingLabel={t('AccessTokens.revoking')}
              onClick={() => revoke.mutate(confirming.id)}
            >
              {tokenStatus(confirming, at) === 'expired'
                ? t('AccessTokens.remove')
                : t('AccessTokens.revoke')}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </AppShell>
  );
}

const CAPSULE: Record<TokenStatus, CapsuleState> = {
  active: 'done',
  expiring: 'waiting',
  expired: 'archived',
  revoked: 'archived',
};

const STATUS_LABEL: Record<TokenStatus, MessageKey> = {
  active: 'AccessTokens.statusActive',
  expiring: 'AccessTokens.statusExpiring',
  expired: 'AccessTokens.statusExpired',
  revoked: 'AccessTokens.statusExpired',
};

const ACTION_LABEL: Record<TokenStatus, MessageKey> = {
  active: 'AccessTokens.revoke',
  expiring: 'AccessTokens.renew',
  expired: 'AccessTokens.remove',
  revoked: 'AccessTokens.remove',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function TokenText({
  token,
  status,
  now,
}: {
  token: PersonalAccessTokenView;
  status: TokenStatus;
  now: Date;
}) {
  const t = useT();
  const format = useDisplayFormatters();
  const day = (iso: string) => format.day(iso, { day: 'numeric', month: 'short' });
  const parts: string[] = [];
  if (status === 'expired' && token.expiresAt) {
    parts.push(`${t('AccessTokens.expiredOn')} ${day(token.expiresAt)}`);
  } else {
    parts.push(`${t('AccessTokens.createdOn')} ${day(token.createdAt)}`);
    if (token.expiresAt && status === 'expiring') {
      const days = Math.max(
        1,
        Math.ceil((new Date(token.expiresAt).getTime() - now.getTime()) / DAY_MS),
      );
      parts.push(
        `${t('AccessTokens.expiresInPrefix')} ${days} ${t('AccessTokens.expiresInSuffix')}`,
      );
    } else if (token.expiresAt) {
      parts.push(`${t('AccessTokens.expiresOn')} ${day(token.expiresAt)}`);
    }
    if (token.lastUsedAt) {
      parts.push(
        new Date(token.lastUsedAt).toDateString() === now.toDateString()
          ? t('AccessTokens.usedToday')
          : `${t('AccessTokens.usedOn')} ${day(token.lastUsedAt)}`,
      );
    }
  }
  return (
    <span className="tm-sec-token__text">
      <span className="tm-sec-token__name">{token.name}</span>
      <span className="tm-sec-token__meta">{parts.join(' · ')}</span>
    </span>
  );
}

function CreateTokenDialog({
  initialName,
  onClose,
  create,
  onCreated,
}: {
  initialName: string;
  onClose: () => void;
  create: (input: {
    name: string;
    expiresInDays: TokenExpiryDays;
  }) => Promise<CreatedPersonalAccessTokenView>;
  onCreated: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(initialName);
  const [expiry, setExpiry] = useState<TokenExpiryDays>(DEFAULT_TOKEN_EXPIRY);
  const [created, setCreated] = useState<CreatedPersonalAccessTokenView | null>(null);
  const [copied, setCopied] = useState(false);
  const nameId = useId();

  const mutation = useMutation({
    mutationFn: () => create({ name: name.trim(), expiresInDays: expiry }),
    onSuccess: (result) => {
      setCreated(result);
      onCreated();
    },
  });

  if (created) {
    return (
      <Dialog title={t('AccessTokens.createdTitle')} onClose={onClose}>
        <p className="tm-sec-card__body">{t('AccessTokens.createdBody')}</p>
        <code className="tm-sec-secret" dir="ltr" data-testid="tm-token-secret">
          {created.token}
        </code>
        <div className="tm-sec-actions">
          <Button
            tone="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(created.token).then(() => setCopied(true));
            }}
          >
            {copied ? t('AccessTokens.copied') : t('AccessTokens.copy')}
          </Button>
          <Button tone="ink" onClick={onClose}>
            {t('AccessTokens.done')}
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={t('AccessTokens.dialogTitle')} onClose={onClose}>
      <form
        className="tm-sec-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <div className="tm-sec-field">
          <label className="tm-sec-field__label" htmlFor={nameId}>
            {t('AccessTokens.nameLabel')}
          </label>
          <input
            id={nameId}
            className="tm-sec-input"
            type="text"
            value={name}
            maxLength={190}
            placeholder={t('AccessTokens.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        <fieldset className="tm-sec-field tm-sec-fieldset">
          <legend className="tm-sec-field__label">{t('AccessTokens.expiryLabel')}</legend>
          <div className="tm-sec-choices">
            {TOKEN_EXPIRY_CHOICES.map((days) => (
              <label key={days} className="tm-sec-choice">
                <input
                  type="radio"
                  name="tm-token-expiry"
                  value={days}
                  checked={expiry === days}
                  onChange={() => setExpiry(days)}
                  required
                />
                {t(EXPIRY_LABEL[days])}
              </label>
            ))}
          </div>
        </fieldset>
        {mutation.isError ? (
          <InlineAlert tone="danger" title={t('AccessTokens.createError')} live>
            {errorMessage(mutation.error)}
          </InlineAlert>
        ) : null}
        <div className="tm-sec-actions">
          <Button tone="outline" onClick={onClose}>
            {t('AccessTokens.cancel')}
          </Button>
          <Button
            tone="ink"
            type="submit"
            disabled={name.trim() === ''}
            loading={mutation.isPending}
            loadingLabel={t('AccessTokens.creating')}
          >
            {t('AccessTokens.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const EXPIRY_LABEL: Record<TokenExpiryDays, MessageKey> = {
  30: 'AccessTokens.days30',
  90: 'AccessTokens.days90',
  365: 'AccessTokens.days365',
};

/** A modal card on a scrim: labelled, Escape closes it, focus starts inside it. */
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node && !node.contains(document.activeElement)) node.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="tm-sec-dialog-scrim">
      <div
        ref={ref}
        className="tm-sec-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="tm-sec-card__title">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

export function errorMessage(error: unknown): string {
  return describeApiErrorNow(error, OFFLINE_LINES);
}
