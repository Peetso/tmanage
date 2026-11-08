'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, Switch } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { useDescribeApiError } from '../../lib/api/describe-error';
import {
  readSsoConnection,
  removeSsoConnection,
  saveSsoConnection,
  splitDomains,
  type SsoConnectionView,
  type SsoProtocol,
} from '../../lib/api/sso';
import { useTOr } from '../../lib/i18n/use-t-or';

const K = 'CompanySignInCard';

export function companySignInQueryKey(organizationSlug: string) {
  return ['admin-company-sign-in', organizationSlug] as const;
}

/**
 * 54-14 — "Company sign-in" (Figma R41 L1 568:33048): the organization's OpenID Connect provider.
 * 54-15 (Figma R42 L3 573:32541): a protocol choice, OpenID Connect or SAML 2.0. For SAML the owner
 * pastes the IdP metadata or its entity ID, sign-in URL and signing certificate, and copies the
 * entity ID and reply URL (ACS) this server shows into the IdP.
 * The company owner alone sees it (the API answers 403 to everyone else, and the card hides). The
 * client secret is write-only: once saved, the field is empty and says it is stored encrypted.
 */
export function CompanySignInCard({
  api,
  organizationSlug,
}: {
  api: ApiClient;
  organizationSlug: string;
}) {
  const tr = useTOr();
  const describeError = useDescribeApiError();
  const queryClient = useQueryClient();
  const connection = useQuery({
    queryKey: companySignInQueryKey(organizationSlug),
    queryFn: () => readSsoConnection(api, organizationSlug),
  });

  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [domains, setDomains] = useState('');
  const [enforce, setEnforce] = useState(false);
  const [autoJoin, setAutoJoin] = useState(false);
  const [protocol, setProtocol] = useState<SsoProtocol>('oidc');
  const [idpMetadataXml, setIdpMetadataXml] = useState('');
  const [idpEntityId, setIdpEntityId] = useState('');
  const [idpSsoUrl, setIdpSsoUrl] = useState('');
  const [idpCertificate, setIdpCertificate] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [saved, setSaved] = useState(false);

  const seed = (view: SsoConnectionView) => {
    setIssuer(view.issuer);
    setClientId(view.clientId);
    setClientSecret('');
    setDomains(view.allowedDomains.join(', '));
    setEnforce(view.enforce);
    setAutoJoin(view.autoJoin);
    setProtocol(view.protocol);
    setIdpMetadataXml('');
    setIdpEntityId(view.samlEntityId);
    setIdpSsoUrl(view.samlSsoUrl);
    setIdpCertificate('');
  };

  useEffect(() => {
    if (!connection.data || seeded) return;
    seed(connection.data);
    setSeeded(true);
  }, [connection.data, seeded]);

  const onDone = (view: SsoConnectionView) => {
    seed(view);
    queryClient.setQueryData(companySignInQueryKey(organizationSlug), view);
  };
  const save = useMutation({
    mutationFn: () =>
      saveSsoConnection(api, organizationSlug, {
        protocol,
        saml: { idpMetadataXml, idpEntityId, idpSsoUrl, idpCertificate },
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        clientSecret,
        allowedDomains: splitDomains(domains),
        enforce,
        autoJoin,
      }),
    onSuccess: (view) => {
      setSaved(true);
      onDone(view);
    },
  });
  const remove = useMutation({
    mutationFn: () => removeSsoConnection(api, organizationSlug),
    onSuccess: (view) => {
      setSaved(false);
      onDone(view);
    },
  });

  const hidden =
    connection.isError &&
    connection.error instanceof ApiRequestError &&
    (connection.error.status === 403 || connection.error.status === 404);
  if (hidden) return null;

  const view = connection.data;
  const busy = save.isPending || remove.isPending;
  const saml = protocol === 'saml';
  const storageMissing = !saml && view !== undefined && !view.secretStorageReady;

  return (
    <section className="tm-cc-card" aria-labelledby="tm-admin-company-sign-in">
      <div className="tm-stack">
        <h2 id="tm-admin-company-sign-in" className="tm-cc-rows__title">
          {tr(`${K}.heading`, 'Company sign-in')}
        </h2>
        <p className="tm-cc-rows__sub">
          {tr(`${K}.lede`, 'Let people sign in with your company identity provider.')}
        </p>
      </div>

      {connection.isError ? (
        <InlineAlert tone="danger" title={tr(`${K}.loadError`, 'Could not load company sign-in')}>
          {describeError(connection.error)}
        </InlineAlert>
      ) : null}
      {connection.isPending ? (
        <LoadingRegion label={tr(`${K}.loading`, 'Loading company sign-in')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {view ? (
        <form
          className="tm-stack"
          noValidate
          aria-label={tr(`${K}.heading`, 'Company sign-in')}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setSaved(false);
            if (!busy) save.mutate();
          }}
        >
          {storageMissing ? (
            <InlineAlert tone="warning">
              {tr(`${K}.noStorage`, 'Secret storage is not set up on this server yet.')}
            </InlineAlert>
          ) : null}
          <div className="tm-stack" role="group" aria-labelledby="tm-admin-sso-protocol">
            <p id="tm-admin-sso-protocol" className="tm-cc-rows__sub">
              {tr(`${K}.protocol`, 'Protocol')}
            </p>
            <div className="tm-row">
              {(['oidc', 'saml'] as const).map((option) => (
                <Button
                  key={option}
                  type="button"
                  tone={protocol === option ? 'ink' : 'outline'}
                  size="accessible"
                  aria-pressed={protocol === option}
                  disabled={busy}
                  onClick={() => setProtocol(option)}
                >
                  {option === 'oidc' ? 'OpenID Connect' : 'SAML 2.0'}
                </Button>
              ))}
            </div>
          </div>
          <fieldset className="tm-stack" disabled={busy || storageMissing}>
            {saml ? (
              <>
                <Field
                  label={tr(`${K}.samlMetadata`, 'IdP metadata XML')}
                  hint={tr(
                    `${K}.samlMetadataHint`,
                    'Paste the metadata file from your identity provider, or fill in the three fields below.',
                  )}
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                  value={idpMetadataXml}
                  onChange={(event) => setIdpMetadataXml(event.target.value)}
                />
                <Field
                  label={tr(`${K}.samlEntityId`, 'IdP entity ID')}
                  hint={tr(`${K}.samlEntityIdHint`, 'Also called the issuer.')}
                  dir="ltr"
                  autoComplete="off"
                  value={idpEntityId}
                  onChange={(event) => setIdpEntityId(event.target.value)}
                />
                <Field
                  label={tr(`${K}.samlSsoUrl`, 'Sign-in URL')}
                  hint={tr(
                    `${K}.samlSsoUrlHint`,
                    'The HTTP-Redirect address of your identity provider.',
                  )}
                  type="url"
                  dir="ltr"
                  value={idpSsoUrl}
                  onChange={(event) => setIdpSsoUrl(event.target.value)}
                />
                <Field
                  label={tr(`${K}.samlCertificate`, 'Signing certificate')}
                  hint={
                    view.samlCertificate
                      ? tr(
                          `${K}.samlCertificateKept`,
                          'Stored: SHA-256 {fingerprint}, valid until {date}. Paste a new one to replace it.',
                        )
                          .replace('{fingerprint}', view.samlCertificate.fingerprint)
                          .replace('{date}', view.samlCertificate.expiresAt.slice(0, 10))
                      : tr(
                          `${K}.samlCertificateHint`,
                          'The X.509 certificate your provider signs with.',
                        )
                  }
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                  value={idpCertificate}
                  onChange={(event) => setIdpCertificate(event.target.value)}
                />
              </>
            ) : (
              <>
                <Field
                  label={tr(`${K}.issuer`, 'Issuer URL')}
                  hint={tr(`${K}.issuerHint`, 'The address of your identity provider.')}
                  type="url"
                  dir="ltr"
                  value={issuer}
                  onChange={(event) => setIssuer(event.target.value)}
                  required
                />
                <Field
                  label={tr(`${K}.clientId`, 'Client ID')}
                  hint={tr(`${K}.clientIdHint`, 'From the app you registered with your provider.')}
                  dir="ltr"
                  autoComplete="off"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  required
                />
                <Field
                  label={tr(`${K}.clientSecret`, 'Client secret')}
                  hint={
                    view.hasClientSecret
                      ? tr(`${K}.clientSecretKept`, 'Stored encrypted. Leave empty to keep it.')
                      : tr(`${K}.clientSecretHint`, 'Stored encrypted and never shown again.')
                  }
                  type="password"
                  dir="ltr"
                  autoComplete="new-password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
              </>
            )}
            <Field
              label={tr(`${K}.domains`, 'Allowed email domains')}
              hint={tr(`${K}.domainsHint`, 'Separate several domains with commas.')}
              dir="ltr"
              value={domains}
              onChange={(event) => setDomains(event.target.value)}
              required
            />
            {saml ? (
              <div className="tm-cc-card tm-stack">
                <p className="tm-cc-rows__sub">
                  {tr(`${K}.samlForIdp`, 'For your identity provider')}
                </p>
                <code dir="ltr">
                  {tr(`${K}.samlSpEntityId`, 'Entity ID')} · {view.spEntityId}
                </code>
                <code dir="ltr">
                  {tr(`${K}.samlAcs`, 'Reply URL (ACS)')} · {view.acsUrl}
                </code>
              </div>
            ) : (
              <div className="tm-cc-card tm-stack">
                <p className="tm-cc-rows__sub">
                  {tr(`${K}.redirect`, 'Redirect URL for your provider')}
                </p>
                <code dir="ltr">{view.redirectUri}</code>
              </div>
            )}
            <Switch
              label={tr(`${K}.enforce`, 'Require company sign-in')}
              hint={tr(
                `${K}.enforceHint`,
                'Members can no longer sign in with a password. The company owner still can.',
              )}
              checked={enforce}
              onChange={(event) => setEnforce(event.target.checked)}
            />
            <Switch
              label={tr(`${K}.autoJoin`, 'Add new people from these domains')}
              hint={tr(
                `${K}.autoJoinHint`,
                'Off: only people already invited or already members can sign in.',
              )}
              checked={autoJoin}
              onChange={(event) => setAutoJoin(event.target.checked)}
            />
            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={save.isPending}
                loadingLabel={tr(`${K}.saving`, 'Saving')}
              >
                {tr(`${K}.save`, 'Save')}
              </Button>
              {view.configured ? (
                <Button
                  type="button"
                  tone="outline"
                  size="accessible"
                  loading={remove.isPending}
                  loadingLabel={tr(`${K}.removing`, 'Removing')}
                  onClick={() => remove.mutate()}
                >
                  {tr(`${K}.remove`, 'Remove connection')}
                </Button>
              ) : null}
            </div>
          </fieldset>

          {save.isError || remove.isError ? (
            <InlineAlert
              tone="danger"
              title={tr(`${K}.saveError`, 'Could not save company sign-in')}
              live
            >
              {describeError(save.error ?? remove.error)}
            </InlineAlert>
          ) : null}
          {view.configured && !busy ? (
            <InlineAlert tone="success" live={saved}>
              {(view.protocol === 'saml'
                ? tr(`${K}.onSaml`, 'Company sign-in (SAML 2.0) is on for {domains}.')
                : tr(`${K}.on`, 'Company sign-in is on for {domains}.')
              ).replace('{domains}', view.allowedDomains.join(', '))}
            </InlineAlert>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
