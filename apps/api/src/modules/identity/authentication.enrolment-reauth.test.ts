import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import { AuthenticationService, ReauthenticationRequiredError } from './authentication.service.js';
import { CredentialsRepository } from './credentials.repository.js';
import { createSeedCipher } from './seed-cipher.js';
import { createSignInAbuseControl } from './sign-in-abuse-control.js';
import { REAUTH_TTL_SECONDS, signReauthToken } from './reauth-token.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * `D05`, third clause: the enrolment routes are behind the same fresh proof as the rest of
 * the credential surface, and the gate runs **before** anything is read or written.
 *
 * The database suite proves the refusal over real HTTP and — the assertion that matters —
 * that the owner's recovery codes survive it. What that suite cannot show precisely is the
 * *ordering*: a gate placed after `findFactor`, or after `createFactor`, would still answer
 * 403 and still leave the codes alone, and would still be wrong — it would have written a
 * factor row, or told the caller by its timing whether the id names a real one. So this file
 * runs the service against a repository that fails the case if any of the three methods on
 * the destructive path is reached at all, which is a statement about order rather than about
 * outcome.
 *
 * A fake repository rather than a database for the same reason `seed-backfill.repository.test`
 * uses one: what is under test is decidable from which calls are issued.
 */

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_enrolment_gate_test';
const USER = '0198f0aa-0000-7000-8000-000000000001';
const SESSION = '0198f0aa-0000-7000-8000-0000000000a1';
const OTHER_SESSION = '0198f0aa-0000-7000-8000-0000000000a2';
const FACTOR = '0198f0aa-0000-7000-8000-0000000000f1';

const NOW = 1_757_000_000_000;

const CONTEXT = {
  correlationId: '0198f0aa-0000-7000-8000-0000000000c1',
  ip: null,
  userAgent: null,
};

/** Obviously fake: a byte repeated thirty-two times. Nothing here is a real key. */
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x11).toString('base64url')}`));

interface Event {
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
}

/**
 * Everything on the enrolment path except the log write, which the refusal itself performs
 * and which is therefore the one call a refused attempt is allowed to make.
 */
class RecordingCredentials extends CredentialsRepository {
  readonly events: Event[] = [];
  readonly reached: string[] = [];

  constructor() {
    super(CIPHER);
  }

  override async recordAuthenticationEvent(
    _runner: IdentityQueryRunner,
    input: { action: string; outcome: string; reason?: string | null },
  ): Promise<void> {
    this.events.push({
      action: input.action,
      outcome: input.outcome,
      reason: input.reason ?? null,
    });
  }

  override async createFactor(): Promise<string> {
    this.reached.push('createFactor');
    return FACTOR;
  }

  override async findFactor(): Promise<null> {
    this.reached.push('findFactor');
    return null;
  }

  override async replaceRecoveryCodes(): Promise<string> {
    this.reached.push('replaceRecoveryCodes');
    return FACTOR;
  }
}

/** A runner nothing dereferences: every repository method that would use it is overridden. */
const RUNNER = {} as IdentityQueryRunner;

function build(): { service: AuthenticationService; credentials: RecordingCredentials } {
  const credentials = new RecordingCredentials();
  const database = {
    identityRead: <T>(_options: unknown, work: (db: IdentityQueryRunner) => Promise<T>) =>
      work(RUNNER),
    identityTransaction: <T>(_options: unknown, work: (tx: IdentityQueryRunner) => Promise<T>) =>
      work(RUNNER),
  } as unknown as TenantDatabase;

  const service = new AuthenticationService(
    database,
    {
      sessionSecret: SESSION_SECRET,
      maxFailuresInWindow: 5,
      failureWindowSeconds: 900,
      totpIssuer: 'TManage',
      abuseControl: createSignInAbuseControl({
        windowMs: 300_000,
        maxPerSource: 1_000,
        maxPerSourceAccount: 1_000,
        maxGlobal: 10_000,
        now: () => NOW,
      }),
    },
    credentials,
    () => NOW,
  );

  return { service, credentials };
}

const proof = (sessionId = SESSION): string =>
  signReauthToken(
    { userId: USER, sessionId, expiresAt: new Date(NOW + REAUTH_TTL_SECONDS * 1000) },
    SESSION_SECRET,
  );

describe('the TOTP enrolment gate', () => {
  it('refuses to begin an enrolment with no proof, before a factor row is created', async () => {
    const { service, credentials } = build();

    await expect(
      service.beginTotpEnrolment({
        userId: USER,
        sessionId: SESSION,
        accountName: 'owner@northstar.example',
        label: 'Attacker phone',
        reauthToken: undefined,
        context: CONTEXT,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    expect(credentials.reached).toEqual([]);
    expect(credentials.events).toEqual([
      { action: 'mfa_factor_enrolled', outcome: 'failed', reason: 'reauth_required' },
    ]);
  });

  /**
   * The clause the closure of `D05` missed. `confirmTotpFactor` calls `replaceRecoveryCodes`
   * and returns the new set, so a live session on its own reaching this method is the whole
   * finding — and `replaceRecoveryCodes` appearing in `reached` is what that would look like.
   */
  it('refuses to confirm an enrolment with no proof, before the recovery codes are replaced', async () => {
    const { service, credentials } = build();

    await expect(
      service.confirmTotpFactor({
        userId: USER,
        sessionId: SESSION,
        factorId: FACTOR,
        code: '000000',
        reauthToken: undefined,
        context: CONTEXT,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    // Not even the ownership lookup: the refusal is the same whether or not the id is real.
    expect(credentials.reached).toEqual([]);
    expect(credentials.events).toEqual([
      { action: 'mfa_factor_enrolled', outcome: 'failed', reason: 'reauth_required' },
    ]);
  });

  it('refuses proof minted for another session of the same person, with its own reason', async () => {
    const { service, credentials } = build();

    await expect(
      service.confirmTotpFactor({
        userId: USER,
        sessionId: SESSION,
        factorId: FACTOR,
        code: '000000',
        reauthToken: proof(OTHER_SESSION),
        context: CONTEXT,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    expect(credentials.reached).toEqual([]);
    expect(credentials.events).toEqual([
      { action: 'mfa_factor_enrolled', outcome: 'failed', reason: 'reauth_wrong_session' },
    ]);
  });

  it('refuses proof that has expired', async () => {
    const { service, credentials } = build();
    const stale = signReauthToken(
      { userId: USER, sessionId: SESSION, expiresAt: new Date(NOW - 1_000) },
      SESSION_SECRET,
    );

    await expect(
      service.confirmTotpFactor({
        userId: USER,
        sessionId: SESSION,
        factorId: FACTOR,
        code: '000000',
        reauthToken: stale,
        context: CONTEXT,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    expect(credentials.reached).toEqual([]);
    expect(credentials.events[0]!.reason).toBe('reauth_expired');
  });

  it('lets the enrolment through once the proof names this user and this session', async () => {
    const { service, credentials } = build();

    const begun = await service.beginTotpEnrolment({
      userId: USER,
      sessionId: SESSION,
      accountName: 'owner@northstar.example',
      label: 'Owner phone',
      reauthToken: proof(),
      context: CONTEXT,
    });

    expect(begun.factorId).toBe(FACTOR);
    expect(begun.uri.startsWith('otpauth://totp/TManage:')).toBe(true);
    expect(credentials.reached).toEqual(['createFactor']);
    // Nothing failed, so nothing was logged by the gate.
    expect(credentials.events).toEqual([]);
  });

  /**
   * With the proof accepted, `confirmTotpFactor` gets as far as the ownership lookup — which
   * the fake answers `null`, so the outcome is the ordinary wrong-code refusal rather than a
   * re-authentication one. That is the point: past the gate, the method behaves exactly as it
   * did before, and the codes are still not replaced by a confirmation that fails.
   */
  it('reaches the ownership lookup once the proof is accepted, and still refuses a bad factor', async () => {
    const { service, credentials } = build();

    await expect(
      service.confirmTotpFactor({
        userId: USER,
        sessionId: SESSION,
        factorId: FACTOR,
        code: '000000',
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).rejects.toThrow();

    expect(credentials.reached).toEqual(['findFactor']);
    expect(credentials.events).toEqual([
      { action: 'mfa_factor_enrolled', outcome: 'failed', reason: 'mfa_bad_code' },
    ]);
  });
});
