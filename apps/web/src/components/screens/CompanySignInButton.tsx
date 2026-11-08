'use client';

import { useState } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { startSso } from '../../lib/api/sso';
import { useTOr } from '../../lib/i18n/use-t-or';

const K = 'CompanySignIn';

/** The English line for each `?sso_error=<code>` the callback can send back. */
const ERROR_LINES: Readonly<Record<string, readonly [string, string]>> = {
  state: [
    `${K}.error.state`,
    'That sign-in took too long or was opened in another browser. Try again.',
  ],
  cancelled: [`${K}.error.cancelled`, 'Company sign-in was cancelled.'],
  token: [`${K}.error.token`, 'Your company sign-in could not be confirmed. Try again.'],
  unverified: [`${K}.error.unverified`, 'Your company account has no confirmed email address.'],
  domain: [`${K}.error.domain`, 'This email address is not allowed for this company.'],
  no_account: [
    `${K}.error.noAccount`,
    'There is no TManage account for this address yet. Ask your company owner for an invitation.',
  ],
  unverified_account: [
    `${K}.error.unverifiedAccount`,
    'Confirm this address first: sign in with your password or reset it by email.',
  ],
  not_member: [
    `${K}.error.notMember`,
    'You are not a member of this company yet. Ask your company owner for an invitation.',
  ],
  method_not_allowed: [
    `${K}.error.methodNotAllowed`,
    'Your company does not allow this sign-in method.',
  ],
  not_set_up: [`${K}.notSetUp`, 'No company sign-in is set up for this address.'],
};

/** The `[key, English]` line for `?sso_error=`; undefined when there is none. */
export function companySignInError(search: string): readonly [string, string] | undefined {
  const code = new URLSearchParams(search).get('sso_error');
  if (code === null) return undefined;
  return ERROR_LINES[code] ?? [`${K}.error.failed`, 'Company sign-in did not work. Try again.'];
}

export interface CompanySignInButtonProps {
  readonly api: ApiClient;
  /** The work email typed in the sign-in form, read at click time. */
  readonly email: () => string;
}

/**
 * "Continue with company sign-in" (54-14, Figma R41 L1 568:33048): the design system's outline
 * `Button`. The typed work email picks the company; the API answers the provider's URL (and sets
 * the state/nonce/PKCE cookie) or says no company sign-in is set up for that address.
 */
export function CompanySignInButton({ api, email }: CompanySignInButtonProps) {
  const tr = useTOr();
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<'email' | 'none' | 'failed' | null>(null);

  async function go() {
    const address = email().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)) {
      setProblem('email');
      return;
    }
    setWorking(true);
    setProblem(null);
    try {
      const url = await startSso(api, address);
      if (url === null) {
        setProblem('none');
        setWorking(false);
        return;
      }
      window.location.assign(url);
    } catch {
      setProblem('failed');
      setWorking(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        tone="outline"
        size="accessible"
        loading={working}
        loadingLabel={tr(`${K}.redirecting`, 'Opening your company sign-in')}
        onClick={() => void go()}
      >
        {tr(`${K}.continue`, 'Continue with company sign-in')}
      </Button>
      {problem === 'email' ? (
        <InlineAlert tone="neutral" live>
          {tr(`${K}.needEmail`, 'Type your work email first.')}
        </InlineAlert>
      ) : null}
      {problem === 'none' ? (
        <InlineAlert tone="danger" live>
          {tr(`${K}.notSetUp`, 'No company sign-in is set up for this address.')}
        </InlineAlert>
      ) : null}
      {problem === 'failed' ? (
        <InlineAlert tone="danger" live>
          {tr(`${K}.error.failed`, 'Company sign-in did not work. Try again.')}
        </InlineAlert>
      ) : null}
      <p className="tm-divider">{tr(`${K}.orPassword`, 'or sign in with your password')}</p>
    </>
  );
}
