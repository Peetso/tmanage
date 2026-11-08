import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/lib/api/errors';
import {
  FAILED_OPENS_FOR_CODE,
  clearFailedOpens,
  failedOpens,
  isDeadLink,
  noteFailedOpen,
  refusalLine,
} from '../src/components/screens/portal-sign-in/PortalSignInScreen';

const refusal = (status: number, details: { field: string; message: string }[] = []) =>
  new ApiRequestError(status, 'conflict', 'x', 'c-1', details);

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('55-14 portal sign-in (web)', () => {
  it('opens the code form after three failed link opens and forgets them on sign-in', () => {
    const store = memory();
    for (let i = 0; i < FAILED_OPENS_FOR_CODE; i += 1) noteFailedOpen(store);
    expect(failedOpens(store)).toBe(3);
    clearFailedOpens(store);
    expect(failedOpens(store)).toBe(0);
  });

  it('treats used, unknown, expired and cancelled links as dead, but not a live session', () => {
    expect(isDeadLink(refusal(404))).toBe(true);
    expect(isDeadLink(refusal(409, [{ field: 'state', message: 'expired' }]))).toBe(true);
    expect(isDeadLink(refusal(409, [{ field: 'session', message: 'signed_in' }]))).toBe(false);
  });

  it('words the rate limit, a live session and a wrong code', () => {
    expect(refusalLine(refusal(429))[0]).toBe('PortalSignIn.tooManyTries');
    expect(refusalLine(refusal(409, [{ field: 'session', message: 'signed_in' }]))[0]).toBe(
      'PortalSignIn.alreadySignedIn',
    );
    expect(refusalLine(refusal(400, [{ field: 'code', message: 'wrong' }]))[0]).toBe(
      'PortalSignIn.codeWrong',
    );
  });
});
