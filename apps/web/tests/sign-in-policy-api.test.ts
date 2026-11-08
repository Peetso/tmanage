import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/lib/api/errors';
import { signInPolicyRefusal } from '../src/lib/api/sign-in-policy';

describe('A16 sign-in policy refusals', () => {
  it('tells the owner lock-out apart from the members lock-out', () => {
    const owner = new ApiRequestError(409, 'conflict', 'x', 'c', [
      { field: 'ownMethods', message: 'password' },
    ]);
    const members = new ApiRequestError(409, 'conflict', 'x', 'c', [
      { field: 'count', message: '2' },
    ]);
    expect(signInPolicyRefusal(owner)).toBe('owner');
    expect(signInPolicyRefusal(members)).toBe('members');
    expect(signInPolicyRefusal(new Error('x'))).toBeNull();
  });
});
