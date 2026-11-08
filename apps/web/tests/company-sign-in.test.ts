import { describe, expect, it } from 'vitest';
import { companySignInError } from '../src/components/screens/CompanySignInButton';
import { splitDomains } from '../src/lib/api/sso';

describe('54-14 company sign-in (web)', () => {
  it('maps the callback refusal codes to a sentence and unknown codes to the generic one', () => {
    expect(companySignInError('?sso_error=domain')?.[0]).toBe('CompanySignIn.error.domain');
    expect(companySignInError('?sso_error=state')?.[0]).toBe('CompanySignIn.error.state');
    expect(companySignInError('?sso_error=<script>')?.[0]).toBe('CompanySignIn.error.failed');
    expect(companySignInError('?google_error=state')).toBeUndefined();
  });

  it('splits the allowed domains field into lower-case domains', () => {
    expect(splitDomains(' Northstar.example, ops.northstar.example;;')).toEqual([
      'northstar.example',
      'ops.northstar.example',
    ]);
  });
});
