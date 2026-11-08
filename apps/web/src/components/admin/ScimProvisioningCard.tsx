'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { useDescribeApiError } from '../../lib/api/describe-error';
import {
  createScimKey,
  readScimSettings,
  revokeScimKey,
  type ScimSettingsView,
} from '../../lib/api/scim';
import { useTOr } from '../../lib/i18n/use-t-or';

const K = 'ScimProvisioningCard';

export function scimProvisioningQueryKey(organizationSlug: string) {
  return ['admin-scim-provisioning', organizationSlug] as const;
}

/**
 * 54-16 — "User provisioning (SCIM)" (Figma R49 L3 592:34040), beside company sign-in. The owner
 * names and creates a bearer key for the identity provider, copies it once, and revokes keys. The
 * card hides for everyone but the company owner (the API answers 403). Without company sign-in it
 * only says to set that up first.
 */
export function ScimProvisioningCard({
  api,
  organizationSlug,
}: {
  api: ApiClient;
  organizationSlug: string;
}) {
  const tr = useTOr();
  const describeError = useDescribeApiError();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: scimProvisioningQueryKey(organizationSlug),
    queryFn: () => readScimSettings(api, organizationSlug),
  });
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);

  const refresh = (view?: ScimSettingsView) => {
    if (view) queryClient.setQueryData(scimProvisioningQueryKey(organizationSlug), view);
    else
      void queryClient.invalidateQueries({ queryKey: scimProvisioningQueryKey(organizationSlug) });
  };
  const create = useMutation({
    mutationFn: () => createScimKey(api, organizationSlug, name),
    onSuccess: (created) => {
      setSecret(created.secret);
      setName('');
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (keyId: string) => revokeScimKey(api, organizationSlug, keyId),
    onSuccess: (view) => {
      setSecret(null);
      refresh(view);
    },
  });

  const hidden =
    settings.isError &&
    settings.error instanceof ApiRequestError &&
    (settings.error.status === 403 || settings.error.status === 404);
  if (hidden) return null;
  const view = settings.data;

  return (
    <section className="tm-cc-card" aria-labelledby="tm-admin-scim">
      <div className="tm-stack">
        <h2 id="tm-admin-scim" className="tm-cc-rows__title">
          {tr(`${K}.heading`, 'User provisioning (SCIM)')}
        </h2>
        <p className="tm-cc-rows__sub">
          {tr(
            `${K}.lede`,
            'Your identity provider can add, update and remove people for you. It works only while company sign-in is set up.',
          )}
        </p>
      </div>

      {settings.isError ? (
        <InlineAlert tone="danger" title={tr(`${K}.loadError`, 'Could not load provisioning')}>
          {describeError(settings.error)}
        </InlineAlert>
      ) : null}
      {settings.isPending ? (
        <LoadingRegion label={tr(`${K}.loading`, 'Loading provisioning')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {view && !view.available ? (
        <InlineAlert tone="warning">
          {tr(`${K}.needsSso`, 'Set up company sign-in first to create provisioning keys.')}
        </InlineAlert>
      ) : null}

      {view?.available ? (
        <form
          className="tm-stack"
          noValidate
          aria-label={tr(`${K}.heading`, 'User provisioning (SCIM)')}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (!create.isPending && name.trim() !== '') create.mutate();
          }}
        >
          <Field
            label={tr(`${K}.keyName`, 'Key name')}
            autoComplete="off"
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <div className="tm-cc-card tm-stack">
            <p className="tm-cc-rows__sub">{tr(`${K}.forIdp`, 'For your identity provider')}</p>
            <code dir="ltr">
              {tr(`${K}.baseUrl`, 'SCIM base URL')} · {view.baseUrl}
            </code>
            <code dir="ltr">
              {tr(`${K}.auth`, 'Authentication')} · {tr(`${K}.bearer`, 'Bearer key')}
            </code>
          </div>
          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              disabled={name.trim() === ''}
              loading={create.isPending}
              loadingLabel={tr(`${K}.creating`, 'Creating')}
            >
              {tr(`${K}.create`, 'Create key')}
            </Button>
          </div>
          {secret ? (
            <InlineAlert
              tone="success"
              title={tr(`${K}.copyNow`, 'Copy this key now. It is shown only once.')}
              live
            >
              <code dir="ltr" data-testid="scim-secret">
                {secret}
              </code>
            </InlineAlert>
          ) : null}
          {create.isError || revoke.isError ? (
            <InlineAlert
              tone="danger"
              title={tr(`${K}.saveError`, 'Could not change provisioning keys')}
              live
            >
              {describeError(create.error ?? revoke.error)}
            </InlineAlert>
          ) : null}
          <div className="tm-cc-card tm-stack">
            <p className="tm-cc-rows__sub">{tr(`${K}.activeKeys`, 'Active keys')}</p>
            {view.keys.length === 0 ? (
              <p className="tm-cc-rows__sub">{tr(`${K}.noKeys`, 'No keys yet.')}</p>
            ) : (
              <ul className="tm-stack" aria-label={tr(`${K}.activeKeys`, 'Active keys')}>
                {view.keys.map((key) => (
                  <li key={key.id} className="tm-row">
                    <code dir="ltr">
                      {key.name} · {key.prefix}…
                    </code>
                    <span className="tm-cc-rows__sub">
                      {tr(`${K}.created`, 'Created {date}').replace(
                        '{date}',
                        key.createdAt.slice(0, 10),
                      )}
                      {' · '}
                      {key.lastUsedAt
                        ? tr(`${K}.lastUsed`, 'Last used {date}').replace(
                            '{date}',
                            key.lastUsedAt.slice(0, 10),
                          )
                        : tr(`${K}.neverUsed`, 'Never used')}
                    </span>
                    <Button
                      type="button"
                      tone="outline"
                      size="accessible"
                      loading={revoke.isPending && revoke.variables === key.id}
                      loadingLabel={tr(`${K}.revoking`, 'Revoking')}
                      aria-label={tr(`${K}.revokeNamed`, 'Revoke {name}').replace(
                        '{name}',
                        key.name,
                      )}
                      onClick={() => revoke.mutate(key.id)}
                    >
                      {tr(`${K}.revoke`, 'Revoke')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <p className="tm-cc-rows__sub">
              {tr(
                `${K}.deactivateNote`,
                'People removed in your provider are deactivated here. The company owner is never deactivated.',
              )}
            </p>
          </div>
        </form>
      ) : null}
    </section>
  );
}
