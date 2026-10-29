import { describe, expect, it } from 'vitest';
import {
  FORM_PROOF_MAX_AGE_MS,
  expectedJsProof,
  formProofKey,
  issueFormProof,
  verifyFormProof,
} from './form-proof.js';

/** UNIT-52-25 — the form-proof token: a real one verifies; a tampered or expired one does not. */

const key = formProofKey('a-session-secret-of-some-length');
const shownAt = new Date('2026-10-29T10:00:00.000Z');
const later = (ms: number) => new Date(shownAt.getTime() + ms);

describe('form proof', () => {
  it('verifies the token, the fill time and the browser-computed proof', () => {
    const { startedAt, nonce } = issueFormProof(key, shownAt);
    const proof = expectedJsProof(nonce, startedAt);
    expect(verifyFormProof(key, { startedAt, nonce, proof }, later(8_000))).toEqual({
      tokenValid: true,
      fillMs: 8_000,
      jsProofValid: true,
    });
    // The token alone (a script that read the hidden inputs but ran no JS): timed, no proof.
    expect(verifyFormProof(key, { startedAt, nonce }, later(1_000))).toMatchObject({
      tokenValid: true,
      fillMs: 1_000,
      jsProofValid: false,
    });
  });

  it('refuses a tampered token, another key, a future token and an expired one', () => {
    const { startedAt, nonce } = issueFormProof(key, shownAt);
    const proof = expectedJsProof(nonce, startedAt);
    const [issued, tokenNonce, mac] = startedAt.split('.');
    // Back-dating the issue time to fake a slow fill breaks the MAC.
    const backdated = `${Number(issued) - 60_000}.${tokenNonce}.${mac}`;
    const invalid = { tokenValid: false, jsProofValid: false };
    expect(
      verifyFormProof(
        key,
        { startedAt: backdated, nonce, proof: expectedJsProof(nonce, backdated) },
        later(1),
      ),
    ).toEqual(invalid);
    expect(verifyFormProof(formProofKey('other'), { startedAt, nonce, proof }, later(1))).toEqual(
      invalid,
    );
    expect(verifyFormProof(key, { startedAt, nonce, proof }, later(-60_000))).toEqual(invalid);
    expect(
      verifyFormProof(key, { startedAt, nonce, proof }, later(FORM_PROOF_MAX_AGE_MS + 1)),
    ).toEqual(invalid);
    expect(verifyFormProof(key, { startedAt: 42, nonce, proof }, later(1))).toEqual(invalid);
  });

  it('refuses a proof computed for another nonce', () => {
    const first = issueFormProof(key, shownAt);
    const second = issueFormProof(key, shownAt);
    const proof = expectedJsProof(second.nonce, first.startedAt);
    expect(
      verifyFormProof(key, { startedAt: first.startedAt, nonce: second.nonce, proof }, later(5_000))
        .jsProofValid,
    ).toBe(false);
  });
});
