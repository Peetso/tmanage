'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { Dialog, errorMessage } from './SecurityScreen';
import { useTOr } from '../../lib/i18n/use-t-or';
import { appLocale } from '../../lib/i18n/app-locale';
import { browserApiClient } from '../../lib/api/browser-client';
import { ApiRequestError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import {
  addPasskey,
  getSecurityScore,
  listPasskeys,
  listSecurityDevices,
  passkeysSupported,
  reauthenticate,
  removePasskey,
  signOutDevice,
  type SecurityCheckId,
  type SecurityDeviceView,
} from '../../lib/api/passkeys';
import '../../styles/screens/access-security.css';
import '../../styles/screens/sign-in-security.css';

const K = 'SignInSecurity';

export interface SignInSecurityScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

type Action =
  | { readonly kind: 'add' }
  | { readonly kind: 'remove'; readonly id: string }
  | { readonly kind: 'signOut'; readonly id: string }
  | { readonly kind: 'signOutOthers' };

const CHECK_LINES: Readonly<Record<SecurityCheckId, readonly [string, string, string, string]>> = {
  two_step: [
    `${K}.check.twoStep`,
    'Two-step sign-in is on',
    `${K}.fix.twoStep`,
    'Turn on two-step',
  ],
  passkey: [`${K}.check.passkey`, 'You have a passkey', `${K}.fix.passkey`, 'Add a passkey'],
  recovery_codes: [
    `${K}.check.recoveryCodes`,
    'Recovery codes are ready',
    `${K}.fix.recoveryCodes`,
    'Get recovery codes',
  ],
  recent_password: [
    `${K}.check.recentPassword`,
    'Password changed in the last year',
    `${K}.fix.recentPassword`,
    'Change password',
  ],
};

/**
 * **Sign-in security (56-22)** at `/{orgSlug}/settings/sign-in-security` — Figma R42 L1 572:32481.
 * The security score with a fix link per open check, the person's passkeys (add on this device,
 * remove), and the signed-in devices (device, browser, country, last seen; sign out one or every
 * other). Adding, removing and signing out ask for the password first when the API says so (403
 * `reauthentication_required`), then retry with the proof.
 */
export function SignInSecurityScreen({
  organizationSlug,
  organizationName,
  client,
}: SignInSecurityScreenProps) {
  const tr = useTOr();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const [proof, setProof] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<Action | null>(null);

  const score = useQuery({ queryKey: ['security-score'], queryFn: () => getSecurityScore(api) });
  const passkeys = useQuery({ queryKey: ['passkeys'], queryFn: () => listPasskeys(api) });
  const devices = useQuery({
    queryKey: ['security-devices'],
    queryFn: () => listSecurityDevices(api),
  });

  const run = useMutation({
    mutationFn: async (input: { action: Action; token: string | null }) => {
      const { action, token } = input;
      if (action.kind === 'add') {
        await addPasskey(api, { name: defaultPasskeyName(), reauthToken: token });
      } else if (action.kind === 'remove') {
        await removePasskey(api, { id: action.id, reauthToken: token });
      } else {
        await signOutDevice(api, {
          id: action.kind === 'signOut' ? action.id : 'others',
          reauthToken: token,
        });
      }
    },
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['passkeys'] });
      void queries.invalidateQueries({ queryKey: ['security-score'] });
      void queries.invalidateQueries({ queryKey: ['security-devices'] });
    },
    onError: (error, input) => {
      if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
        setProof(null);
        setStepUp(input.action);
      }
    },
  });
  const act = (action: Action) => run.mutate({ action, token: proof });
  const twoStepOn = score.data?.checks.some((c) => c.id === 'two_step' && c.passed) ?? false;
  const passed = score.data?.checks.filter((c) => c.passed).length ?? 0;
  const showError =
    run.isError &&
    !(run.error instanceof ApiRequestError && run.error.code === 'reauthentication_required');

  return (
    <SettingsShell
      section="sign-in-security"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={tr(`${K}.eyebrow`, 'Security')}
      title={tr(`${K}.title`, 'Sign-in security')}
    >
      <div className="tm-sec">
        {showError ? (
          <InlineAlert tone="danger" title={tr(`${K}.actionError`, 'That did not work')} live>
            {errorMessage(run.error)}
          </InlineAlert>
        ) : null}

        <section className="tm-sec-card" aria-labelledby="tm-sis-score">
          <div className="tm-sis-score">
            <div className="tm-sis-row__text">
              <h2 id="tm-sis-score" className="tm-sec-card__title">
                {tr(`${K}.scoreTitle`, 'Security score')}
              </h2>
              {score.data ? (
                <p className="tm-sec-card__body">
                  {tr(`${K}.stepsDone`, '{passed} of {total} steps done')
                    .replace('{passed}', String(passed))
                    .replace('{total}', String(score.data.checks.length))}
                </p>
              ) : null}
            </div>
            {score.data ? (
              <p className="tm-sis-score__value" dir="ltr">
                {score.data.score}
                <span className="tm-sis-score__of">/100</span>
              </p>
            ) : null}
          </div>
          {score.isPending ? (
            <LoadingRegion label={tr(`${K}.loading`, 'Loading')}>
              <Skeleton />
            </LoadingRegion>
          ) : null}
          {score.isError ? (
            <InlineAlert tone="danger">{errorMessage(score.error)}</InlineAlert>
          ) : null}
          {score.data ? (
            <ul className="tm-sis-checks">
              {score.data.checks.map((check) => {
                const [labelKey, label, fixKey, fix] = CHECK_LINES[check.id];
                return (
                  <li key={check.id} className="tm-sis-check">
                    <span className="tm-sis-check__label">
                      <span
                        aria-hidden="true"
                        className={`tm-sis-check__mark${check.passed ? '' : ' tm-sis-check__mark--open'}`}
                      >
                        {check.passed ? '✓' : '!'}
                      </span>
                      {tr(labelKey, label)}
                    </span>
                    {check.passed ? null : check.fix === 'sign-in-security' ? (
                      <a className="tm-sis-check__fix" href="#tm-sis-passkeys">
                        {tr(fixKey, fix)}
                      </a>
                    ) : (
                      <Link
                        className="tm-sis-check__fix"
                        href={
                          check.fix === 'password'
                            ? '/recover'
                            : `/${encodeURIComponent(organizationSlug)}/settings/two-step`
                        }
                      >
                        {tr(fixKey, fix)}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        <section
          className="tm-sec-card"
          aria-labelledby="tm-sis-passkeys-title"
          id="tm-sis-passkeys"
        >
          <h2 id="tm-sis-passkeys-title" className="tm-sec-card__title">
            {tr(`${K}.passkeysTitle`, 'Passkeys')}
          </h2>
          <p className="tm-sec-card__body">
            {tr(
              `${K}.passkeysBody`,
              'Sign in with your fingerprint, face or screen lock instead of a password.',
            )}
          </p>
          {passkeys.isError ? (
            <InlineAlert tone="danger">{errorMessage(passkeys.error)}</InlineAlert>
          ) : null}
          {passkeys.data && passkeys.data.length > 0 ? (
            <ul className="tm-sis-rows">
              {passkeys.data.map((key) => (
                <li key={key.id} className="tm-sis-row">
                  <div className="tm-sis-row__text">
                    <span className="tm-sis-row__name">{key.name}</span>
                    <span className="tm-sis-row__meta">
                      {tr(`${K}.added`, 'Added {date}').replace('{date}', formatDay(key.createdAt))}
                      {' · '}
                      {key.lastUsedAt
                        ? tr(`${K}.lastUsed`, 'Last used {date}').replace(
                            '{date}',
                            formatDay(key.lastUsedAt),
                          )
                        : tr(`${K}.notUsed`, 'Not used yet')}
                    </span>
                  </div>
                  <Button
                    tone="outline"
                    size="compact"
                    onClick={() => act({ kind: 'remove', id: key.id })}
                  >
                    {tr(`${K}.remove`, 'Remove')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {passkeys.data?.length === 0 ? (
            <p className="tm-sis-row__meta">{tr(`${K}.noPasskeys`, 'No passkeys yet.')}</p>
          ) : null}
          <div className="tm-sis-actions">
            {passkeysSupported() ? (
              <Button
                tone="ink"
                loading={run.isPending && run.variables?.action.kind === 'add'}
                loadingLabel={tr(`${K}.adding`, 'Waiting for your device')}
                onClick={() => act({ kind: 'add' })}
              >
                {tr(`${K}.add`, 'Add a passkey')}
              </Button>
            ) : (
              <p className="tm-sis-row__meta">
                {tr(`${K}.unsupported`, 'This browser cannot create passkeys.')}
              </p>
            )}
          </div>
        </section>

        <section className="tm-sec-card" aria-labelledby="tm-sis-devices">
          <h2 id="tm-sis-devices" className="tm-sec-card__title">
            {tr(`${K}.devicesTitle`, 'Signed-in devices')}
          </h2>
          {devices.isError ? (
            <InlineAlert tone="danger">{errorMessage(devices.error)}</InlineAlert>
          ) : null}
          {devices.data ? (
            <ul className="tm-sis-rows">
              {devices.data.map((device) => (
                <li key={device.id} className="tm-sis-row">
                  <div className="tm-sis-row__text">
                    <span className="tm-sis-row__name">{deviceName(device, tr)}</span>
                    <span className="tm-sis-row__meta">
                      {device.country ?? tr(`${K}.unknownPlace`, 'Unknown place')}
                      {' · '}
                      {device.current
                        ? tr(`${K}.activeNow`, 'Active now')
                        : tr(`${K}.lastSeen`, 'Last seen {date}').replace(
                            '{date}',
                            formatMoment(device.lastSeenAt),
                          )}
                    </span>
                  </div>
                  {device.current ? (
                    <span className="tm-sis-pill">{tr(`${K}.thisDevice`, 'This device')}</span>
                  ) : (
                    <Button
                      tone="outline"
                      size="compact"
                      onClick={() => act({ kind: 'signOut', id: device.id })}
                    >
                      {tr(`${K}.signOut`, 'Sign out')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {devices.data && devices.data.some((d) => !d.current) ? (
            <div className="tm-sis-actions">
              <Button tone="outline" onClick={() => act({ kind: 'signOutOthers' })}>
                {tr(`${K}.signOutOthers`, 'Sign out all other devices')}
              </Button>
            </div>
          ) : null}
        </section>
      </div>

      {stepUp ? (
        <Dialog title={tr(`${K}.reauthTitle`, 'Confirm it is you')} onClose={() => setStepUp(null)}>
          <StepUpForm
            api={api}
            needsCode={twoStepOn}
            onCancel={() => setStepUp(null)}
            onConfirmed={(token) => {
              const action = stepUp;
              setProof(token);
              setStepUp(null);
              run.mutate({ action, token });
            }}
          />
        </Dialog>
      ) : null}
    </SettingsShell>
  );
}

function StepUpForm({
  api,
  needsCode,
  onCancel,
  onConfirmed,
}: {
  api: ApiClient;
  needsCode: boolean;
  onCancel: () => void;
  onConfirmed: (token: string) => void;
}) {
  const tr = useTOr();
  const passwordId = useId();
  const codeId = useId();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const confirm = useMutation({
    mutationFn: () =>
      reauthenticate(api, {
        password,
        ...(needsCode ? { code: code.replace(/\D/gu, '') } : {}),
      }),
    onSuccess: onConfirmed,
  });
  return (
    <form
      className="tm-stack"
      onSubmit={(event) => {
        event.preventDefault();
        confirm.mutate();
      }}
    >
      <p className="tm-sec-card__body">
        {tr(`${K}.reauthBody`, 'Enter your password to make this change.')}
      </p>
      <div className="tm-sec-field">
        <label className="tm-sec-field__label" htmlFor={passwordId}>
          {tr(`${K}.password`, 'Password')}
        </label>
        <input
          id={passwordId}
          className="tm-sec-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      {needsCode ? (
        <div className="tm-sec-field">
          <label className="tm-sec-field__label" htmlFor={codeId}>
            {tr(`${K}.code`, 'Code from your authenticator app')}
          </label>
          <input
            id={codeId}
            className="tm-sec-input"
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </div>
      ) : null}
      {confirm.isError ? (
        <InlineAlert tone="danger" live>
          {errorMessage(confirm.error)}
        </InlineAlert>
      ) : null}
      <div className="tm-sec-actions">
        <Button tone="outline" type="button" onClick={onCancel}>
          {tr(`${K}.cancel`, 'Cancel')}
        </Button>
        <Button
          tone="ink"
          type="submit"
          disabled={password === ''}
          loading={confirm.isPending}
          loadingLabel={tr(`${K}.confirming`, 'Checking')}
        >
          {tr(`${K}.confirm`, 'Confirm')}
        </Button>
      </div>
    </form>
  );
}

/** "Mac · Chrome", with plain words when the agent said nothing. */
export function deviceName(
  device: Pick<SecurityDeviceView, 'os' | 'browser'>,
  tr: (key: string, english: string) => string,
): string {
  const os = device.os ?? tr(`${K}.unknownDevice`, 'Unknown device');
  return device.browser ? `${os} · ${device.browser}` : os;
}

/** A name for a new passkey: the platform this browser reports. */
function defaultPasskeyName(): string {
  if (typeof navigator === 'undefined') return 'Passkey';
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/u.test(ua)
    ? 'iPhone'
    : /Android/u.test(ua)
      ? 'Android'
      : /Mac OS X/u.test(ua)
        ? 'Mac'
        : /Windows/u.test(ua)
          ? 'Windows'
          : 'Passkey';
  return os;
}

function formatDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: 'medium' }).format(at);
}

function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    at,
  );
}
