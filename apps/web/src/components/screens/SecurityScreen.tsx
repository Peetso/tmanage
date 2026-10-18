'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
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
      eyebrow="Preferences · Security"
      title="Access tokens"
      description="Tokens let the TManage MCP server and other tools act as you. A token has your permissions and nothing more, and you can revoke it anytime."
    >
      <div className="tm-prefs">
        <section className="tm-prefs__main" aria-labelledby="tm-pat-list-heading">
          <div className="tm-prefs-card">
            <h2 id="tm-pat-list-heading" className="tm-prefs-eyebrow">
              Your tokens
            </h2>

            {tokens.isPending ? (
              <LoadingRegion label="Loading your personal access tokens">
                <Skeleton />
              </LoadingRegion>
            ) : tokens.isError ? (
              <InlineAlert tone="danger" title="We could not load your tokens">
                {errorMessage(tokens.error)}
              </InlineAlert>
            ) : tokens.data.length === 0 ? (
              <p className="tm-prefs-card__body">You have no personal access tokens yet.</p>
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
                        Revoke
                      </button>
                    ) : (
                      <span className="tm-prefs-token__meta">Revoked</span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {revoke.isError ? (
              <InlineAlert tone="danger" title="We could not revoke that token">
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
              Create a token
            </h2>

            <div className="tm-prefs-field">
              <label className="tm-prefs-field__label" htmlFor="tm-pat-name">
                Name
              </label>
              <input
                id="tm-pat-name"
                className="tm-prefs-field__control"
                type="text"
                value={name}
                maxLength={190}
                placeholder="e.g. Claude Desktop on my laptop"
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>

            <div className="tm-prefs-field">
              <label className="tm-prefs-field__label" htmlFor="tm-pat-expiry">
                Expires in (days, optional)
              </label>
              <input
                id="tm-pat-expiry"
                className="tm-prefs-field__control"
                type="number"
                min={1}
                max={365}
                value={expiry}
                placeholder="Leave blank for no expiry"
                onChange={(event) => setExpiry(event.target.value)}
              />
            </div>

            {create.isError ? (
              <InlineAlert tone="danger" title="We could not create the token">
                {errorMessage(create.error)}
              </InlineAlert>
            ) : null}

            {created ? (
              <InlineAlert tone="success" title="Token created — copy it now">
                <p>
                  This is the only time the token is shown. Paste it into your MCP client
                  configuration now; if you lose it, revoke it and create a new one.
                </p>
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
                {create.isPending ? 'Creating…' : 'Create token'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </AppShell>
  );
}

function TokenRow({ token }: { token: PersonalAccessTokenView }) {
  return (
    <span className="tm-prefs-token__text">
      <span className="tm-prefs-token__name">{token.name}</span>
      <code className="tm-prefs-kbd">{token.tokenPrefix}</code>
      <span className="tm-prefs-token__meta">
        Created {formatDate(token.createdAt)}
        {token.expiresAt ? ` · expires ${formatDate(token.expiresAt)}` : ' · no expiry'}
        {token.lastUsedAt ? ` · last used ${formatDate(token.lastUsedAt)}` : ' · never used'}
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
