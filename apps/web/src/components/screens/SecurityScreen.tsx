'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
} from '../../lib/api/personal-access-tokens';
import type {
  CreatedPersonalAccessTokenView,
  PersonalAccessTokenView,
} from '../../lib/api/personal-access-tokens';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/preferences.css';

export interface SecurityScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Security — personal access tokens (module 20 Preferences & accessibility).**
 *
 * The member's own API credentials for the TManage MCP server (and any other programmatic
 * client). A member creates a token (naming it, optionally with an expiry), copies the plaintext
 * — shown once, right after creation, and never again — and revokes any token they no longer
 * want. Everything is scoped to the caller's own membership by the server, behind `work.read`.
 *
 * The organization name is still a fixture, the reason every sibling settings screen gives: no
 * endpoint returns the current organization's profile by slug.
 */
export function SecurityScreen({
  organizationSlug,
  organizationName,
  client,
}: SecurityScreenProps) {
  const t = useT();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['personal-access-tokens', organizationSlug] as const;

  const tokens = useQuery({
    queryKey,
    queryFn: () => listPersonalAccessTokens(api, organizationSlug),
  });

  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('');
  const [created, setCreated] = useState<CreatedPersonalAccessTokenView | null>(null);

  const create = useMutation({
    mutationFn: (): Promise<CreatedPersonalAccessTokenView> => {
      const trimmedExpiry = expiry.trim();
      const expiresInDays = trimmedExpiry === '' ? null : Number(trimmedExpiry);
      return createPersonalAccessToken(api, organizationSlug, {
        name: name.trim(),
        expiresInDays,
      });
    },
    onSuccess: (result) => {
      setCreated(result);
      setName('');
      setExpiry('');
      void queries.invalidateQueries({ queryKey });
    },
  });

  const revoke = useMutation({
    mutationFn: (tokenId: string) => revokePersonalAccessToken(api, organizationSlug, tokenId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey });
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={t('SecurityScreen.eyebrow')}
      title={t('SecurityScreen.title')}
      description={t('SecurityScreen.description')}
    >
      <div className="tm-prefs">
        <section className="tm-prefs__main" aria-labelledby="tm-pat-list-heading">
          <div className="tm-prefs-card">
            <h2 id="tm-pat-list-heading" className="tm-prefs-eyebrow">
              {t('SecurityScreen.yourTokensHeading')}
            </h2>

            {tokens.isPending ? (
              <LoadingRegion label={t('SecurityScreen.loading')}>
                <Skeleton />
              </LoadingRegion>
            ) : tokens.isError ? (
              <InlineAlert tone="danger" title={t('SecurityScreen.loadError')}>
                {errorMessage(tokens.error)}
              </InlineAlert>
            ) : tokens.data.length === 0 ? (
              <p className="tm-prefs-card__body">{t('SecurityScreen.emptyBody')}</p>
            ) : (
              <ul className="tm-prefs-tokens">
                {tokens.data.map((token) => (
                  <li key={token.id} className="tm-prefs-token">
                    <TokenRow token={token} />
                    {token.revokedAt === null ? (
                      <button
                        type="button"
                        className="tm-prefs-capsule"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(token.id)}
                      >
                        {t('SecurityScreen.revoke')}
                      </button>
                    ) : (
                      <span className="tm-prefs-token__meta">{t('SecurityScreen.revoked')}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {revoke.isError ? (
              <InlineAlert tone="danger" title={t('SecurityScreen.revokeError')}>
                {errorMessage(revoke.error)}
              </InlineAlert>
            ) : null}
          </div>
        </section>

        <div className="tm-prefs__side">
          <form
            className="tm-prefs-card"
            aria-labelledby="tm-pat-create-heading"
            onSubmit={(event) => {
              event.preventDefault();
              setCreated(null);
              create.mutate();
            }}
          >
            <h2 id="tm-pat-create-heading" className="tm-prefs-card__title">
              {t('SecurityScreen.createHeading')}
            </h2>

            <div className="tm-prefs-field">
              <label className="tm-prefs-field__label" htmlFor="tm-pat-name">
                {t('SecurityScreen.nameLabel')}
              </label>
              <input
                id="tm-pat-name"
                className="tm-prefs-field__control"
                type="text"
                value={name}
                maxLength={190}
                placeholder={t('SecurityScreen.namePlaceholder')}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>

            <div className="tm-prefs-field">
              <label className="tm-prefs-field__label" htmlFor="tm-pat-expiry">
                {t('SecurityScreen.expiryLabel')}
              </label>
              <input
                id="tm-pat-expiry"
                className="tm-prefs-field__control"
                type="number"
                min={1}
                max={365}
                value={expiry}
                placeholder={t('SecurityScreen.expiryPlaceholder')}
                onChange={(event) => setExpiry(event.target.value)}
              />
            </div>

            {create.isError ? (
              <InlineAlert tone="danger" title={t('SecurityScreen.createError')}>
                {errorMessage(create.error)}
              </InlineAlert>
            ) : null}

            {created ? (
              <InlineAlert tone="success" title={t('SecurityScreen.createdTitle')}>
                <p>{t('SecurityScreen.createdBody')}</p>
                <code className="tm-prefs-secret" data-testid="tm-pat-secret">
                  {created.token}
                </code>
              </InlineAlert>
            ) : null}

            <div>
              <button
                type="submit"
                className="tm-prefs-capsule tm-prefs-capsule--ink"
                disabled={create.isPending || name.trim() === ''}
              >
                {create.isPending ? t('SecurityScreen.creating') : t('SecurityScreen.createButton')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </AppShell>
  );
}

function TokenRow({ token }: { token: PersonalAccessTokenView }) {
  const t = useT();
  return (
    <span className="tm-prefs-token__text">
      <span className="tm-prefs-token__name">{token.name}</span>
      <code className="tm-prefs-kbd">{token.tokenPrefix}</code>
      <span className="tm-prefs-token__meta">
        {t('SecurityScreen.createdWord')} {formatDate(token.createdAt)}
        {token.expiresAt
          ? ` · ${t('SecurityScreen.expiresWord')} ${formatDate(token.expiresAt)}`
          : ` · ${t('SecurityScreen.noExpiry')}`}
        {token.lastUsedAt
          ? ` · ${t('SecurityScreen.lastUsedWord')} ${formatDate(token.lastUsedAt)}`
          : ` · ${t('SecurityScreen.neverUsed')}`}
      </span>
    </span>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
