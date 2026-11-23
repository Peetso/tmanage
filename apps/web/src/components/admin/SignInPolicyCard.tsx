'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Checkbox,
  InlineAlert,
  LoadingRegion,
  Radio,
  RadioGroup,
  Skeleton,
} from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { useDescribeApiError } from '../../lib/api/describe-error';
import {
  readSignInPolicy,
  signInPolicyRefusal,
  SIGN_IN_METHOD_KEYS,
  TWO_STEP_SCOPE_KEYS,
  updateSignInPolicy,
  type SignInMethodKey,
  type SignInPolicyState,
  type TwoStepRoleScopeKey,
} from '../../lib/api/sign-in-policy';
import { useTOr } from '../../lib/i18n/use-t-or';
import { appIntlLocale } from '../../lib/i18n/app-locale';
import { PrivacyStepUpDialog, usePrivacyStepUp } from '../privacy/PrivacyStepUp';
import '../privacy/privacy.css';

type Tr = (key: string, english: string) => string;

const K = 'AdminSecurityScreen.signIn';

export function signInPolicyQueryKey(organizationSlug: string) {
  return ['admin-sign-in-policy', organizationSlug] as const;
}

function methodLabel(tr: Tr, method: SignInMethodKey): string {
  switch (method) {
    case 'password':
      return tr(`${K}.methodPassword`, 'Password');
    case 'google':
      return 'Google';
    case 'microsoft':
      return 'Microsoft';
    default:
      return tr(`${K}.methodSso`, 'Single sign-on');
  }
}

function methodHint(tr: Tr, method: SignInMethodKey): string {
  switch (method) {
    case 'password':
      return tr(`${K}.methodPasswordHint`, 'Email address and password');
    case 'google':
      return tr(`${K}.methodGoogleHint`, 'A Google account');
    case 'microsoft':
      return tr(`${K}.methodMicrosoftHint`, 'A Microsoft account');
    default:
      return tr(`${K}.methodSsoHint`, 'Your company sign-in provider');
  }
}

function scopeLabel(tr: Tr, scope: TwoStepRoleScopeKey): [string, string] {
  if (scope === 'nobody') {
    return [tr(`${K}.scopeNobody`, 'Nobody'), tr(`${K}.scopeNobodyHint`, 'Each person decides')];
  }
  if (scope === 'admins') {
    return [
      tr(`${K}.scopeAdmins`, 'Admins and owners'),
      tr(`${K}.scopeAdminsHint`, 'Owner, company admins and workspace admins'),
    ];
  }
  return [
    tr(`${K}.scopeEveryone`, 'Everyone in the team'),
    tr(`${K}.scopeEveryoneHint`, 'Every team member. Clients are not included'),
  ];
}

function formatDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appIntlLocale(), { dateStyle: 'medium' }).format(at);
}

function isHidden(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 403 || error.status === 404);
}

/**
 * A16 — "Sign-in methods and two-step" (Figma R31 L08 A16). Which sign-in methods members may use
 * and who must hold a second factor. The owner changes it (with a password check); everyone else who
 * can read it sees it read-only. The API refuses switching off the last method the owner uses and a
 * list that leaves members without a way in; both refusals are explained here.
 */
export function SignInPolicyCard({
  api,
  organizationSlug,
  readOnly,
}: {
  api: ApiClient;
  organizationSlug: string;
  readOnly: boolean;
}) {
  const tr = useTOr();
  const describeError = useDescribeApiError();
  const queryClient = useQueryClient();
  const stepUp = usePrivacyStepUp();
  const policy = useQuery({
    queryKey: signInPolicyQueryKey(organizationSlug),
    queryFn: () => readSignInPolicy(api, organizationSlug),
  });

  const [methods, setMethods] = useState<readonly SignInMethodKey[]>([]);
  const [scope, setScope] = useState<TwoStepRoleScopeKey>('nobody');
  const [seeded, setSeeded] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!policy.data || seeded) return;
    setMethods(policy.data.allowedMethods);
    setScope(policy.data.requireTwoStepRoles);
    setSeeded(true);
  }, [policy.data, seeded]);

  const save = useMutation({
    mutationFn: () =>
      updateSignInPolicy(
        api,
        organizationSlug,
        { allowedMethods: methods, requireTwoStepRoles: scope },
        stepUp.token(),
      ),
    onSuccess: (state: SignInPolicyState) => {
      setSaved(true);
      queryClient.setQueryData(signInPolicyQueryKey(organizationSlug), state);
    },
    onError: (error) => stepUp.ask(error, () => save.mutate()),
  });

  if (policy.isError && isHidden(policy.error)) return null;

  const isDefault =
    policy.data !== undefined &&
    policy.data.allowedMethods.length === SIGN_IN_METHOD_KEYS.length &&
    policy.data.requireTwoStepRoles === 'nobody';
  const refusal = save.isError ? signInPolicyRefusal(save.error) : null;
  const own = policy.data?.ownMethods ?? [];
  const without = policy.data?.membersWithoutAlternative ?? 0;
  const disabled = readOnly || save.isPending;

  return (
    <section className="tm-cc-card" aria-labelledby="tm-admin-sign-in-heading">
      <div className="tm-stack">
        <h2 id="tm-admin-sign-in-heading" className="tm-cc-rows__title">
          {tr(`${K}.heading`, 'Sign-in methods and two-step')}
        </h2>
        <p className="tm-cc-rows__sub">
          {tr(
            `${K}.lede`,
            'Choose how members can sign in and who must use two-step sign-in. Owners always keep a way in.',
          )}
        </p>
      </div>

      {policy.isError ? (
        <InlineAlert tone="danger" title={tr(`${K}.loadError`, 'Could not load the sign-in rules')}>
          {describeError(policy.error)}
        </InlineAlert>
      ) : null}

      {policy.isPending ? (
        <LoadingRegion label={tr(`${K}.loading`, 'Loading the sign-in rules')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {policy.data ? (
        <form
          className="tm-stack"
          noValidate
          aria-label={tr(`${K}.heading`, 'Sign-in methods and two-step')}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setSaved(false);
            if (!disabled) save.mutate();
          }}
        >
          {isDefault ? (
            <InlineAlert tone="neutral" title={tr(`${K}.emptyTitle`, 'No sign-in rules set yet')}>
              {tr(
                `${K}.emptyBody`,
                'Everyone can use any sign-in method, and two-step sign-in is up to each person.',
              )}
            </InlineAlert>
          ) : null}

          <fieldset className="tm-stack" disabled={disabled}>
            <legend className="tm-cc-rows__title">
              {tr(`${K}.methodsLegend`, 'Allowed sign-in methods')}
            </legend>
            {SIGN_IN_METHOD_KEYS.map((method) => (
              <Checkbox
                key={method}
                label={methodLabel(tr, method)}
                hint={methodHint(tr, method)}
                checked={methods.includes(method)}
                onChange={(event) => {
                  setSaved(false);
                  const on = event.target.checked;
                  setMethods((current) =>
                    SIGN_IN_METHOD_KEYS.filter((key) =>
                      key === method ? on : current.includes(key),
                    ),
                  );
                }}
              />
            ))}
          </fieldset>

          <RadioGroup
            legend={tr(`${K}.scopeLegend`, 'Two-step sign-in required for')}
            hint={tr(
              `${K}.graceNote`,
              'People newly covered get 14 days to turn on two-step sign-in.',
            )}
            disabled={disabled}
          >
            {TWO_STEP_SCOPE_KEYS.map((key) => {
              const [label, hint] = scopeLabel(tr, key);
              return (
                <Radio
                  key={key}
                  label={label}
                  hint={hint}
                  value={key}
                  checked={scope === key}
                  onChange={() => {
                    setSaved(false);
                    setScope(key);
                  }}
                />
              );
            })}
          </RadioGroup>

          {without > 0 ? (
            <div className="tm-row">
              <Badge>
                {tr(
                  `${K}.withoutCount`,
                  '{count} members can only sign in with a password',
                ).replace('{count}', String(without))}
              </Badge>
            </div>
          ) : null}

          {refusal === 'owner' ? (
            <InlineAlert
              tone="danger"
              title={tr(`${K}.ownerTitle`, 'Keep a way in for yourself')}
              live
            >
              {tr(
                `${K}.ownerBody`,
                'You sign in with {methods}. Keep one of them allowed, or link another way first.',
              ).replace('{methods}', own.map((method) => methodLabel(tr, method)).join(', '))}
            </InlineAlert>
          ) : null}
          {refusal === 'members' ? (
            <InlineAlert
              tone="danger"
              title={tr(`${K}.membersTitle`, 'Some members would be locked out')}
              live
            >
              {tr(
                `${K}.membersBody`,
                'Some members have no other way to sign in yet. Keep Password allowed until they link one.',
              )}
            </InlineAlert>
          ) : null}
          {save.isError && refusal === null && !stepUp.open ? (
            <InlineAlert
              tone="danger"
              title={tr(`${K}.saveError`, 'Could not save the sign-in rules')}
              live
            >
              {describeError(save.error)}
            </InlineAlert>
          ) : null}
          {saved && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title={tr(`${K}.savedTitle`, 'Sign-in rules saved')} live>
              {tr(`${K}.savedBody`, 'Members sign in under the new rules from their next sign-in.')}
            </InlineAlert>
          ) : null}

          {readOnly ? (
            <p className="tm-cc-note">
              {tr(
                'AdminSecurityScreen.s8.ownerOnly',
                'Only the company owner can change this setting.',
              )}
            </p>
          ) : (
            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                disabled={methods.length === 0}
                loading={save.isPending}
                loadingLabel={tr(`${K}.saving`, 'Saving')}
              >
                {tr(`${K}.save`, 'Save sign-in rules')}
              </Button>
            </div>
          )}
        </form>
      ) : null}

      {stepUp.open ? (
        <PrivacyStepUpDialog
          api={api}
          tr={tr}
          onConfirmed={stepUp.confirmed}
          onClose={stepUp.cancel}
        />
      ) : null}
    </section>
  );
}

/** The grace-period notice for the right column: drawn only while a grace period is running. */
export function SignInPolicyGrace({
  api,
  organizationSlug,
}: {
  api: ApiClient;
  organizationSlug: string;
}) {
  const tr = useTOr();
  const policy = useQuery({
    queryKey: signInPolicyQueryKey(organizationSlug),
    queryFn: () => readSignInPolicy(api, organizationSlug),
  });
  const graceUntil = policy.data?.graceUntil ?? null;
  if (graceUntil === null || Date.parse(graceUntil) <= Date.now()) return null;
  return (
    <InlineAlert
      tone="warning"
      title={tr(`${K}.graceTitle`, 'Grace period until {date}').replace(
        '{date}',
        formatDay(graceUntil),
      )}
    >
      {tr(
        `${K}.graceBody`,
        'People newly asked for two-step sign-in can still sign in until then. After that they are asked to set it up first.',
      )}
    </InlineAlert>
  );
}
