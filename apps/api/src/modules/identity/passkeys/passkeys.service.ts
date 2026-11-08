import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import type { SignInMethodRefusal } from '../sign-in-policy.repository.js';
import { ReauthenticationRequiredError, type SignInContext } from '../authentication.service.js';
import type { CredentialsRepository } from '../credentials.repository.js';
import { verifyReauthToken } from '../reauth-token.js';
import { issuePasskeyChallenge, verifyPasskeyChallenge } from './passkey-challenge.js';
import {
  credentialHashTaken,
  findPasskeyOwner,
  findLivePasskey,
  insertPasskey,
  listPasskeys,
  PASSKEY_TABLES,
  queueSecurityNotice,
  readSecurityFacts,
  recordPasskeyUse,
  removePasskey,
  type PasskeyListItem,
} from './passkeys.repository.js';
import { computeSecurityScore, type SecurityScoreView } from './security-score.js';
import {
  ALG_ES256,
  ALG_RS256,
  credentialIdHash,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
  type RelyingParty,
} from './webauthn.js';

export const PASSKEY_ACTIONS = {
  signIn: 'passkey_sign_in',
  added: 'passkey_added',
  removed: 'passkey_removed',
} as const;

/** A refused passkey sign-in or registration. The reason goes to the log, never to the wire. */
export class PasskeyRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`passkey refused: ${reason}`);
    this.name = 'PasskeyRejectedError';
  }
}

/** The organization policy forbids the TManage credential for this person (fail closed). */
export class PasskeyPolicyRefusedError extends Error {
  constructor(readonly refusal: SignInMethodRefusal) {
    super('passkey sign-in not allowed by policy');
    this.name = 'PasskeyPolicyRefusedError';
  }
}

export interface PasskeysOptions {
  readonly sessionSecret: string;
  readonly rp: RelyingParty & { readonly name: string };
  /** The sign-in policy gate; a passkey stands in for the password, so it is checked as one. */
  readonly signInPolicy?: {
    check(
      userId: string,
      method: 'password',
      correlationId: string,
    ): Promise<SignInMethodRefusal | null>;
  };
  readonly now?: () => number;
}

export interface AttestationBody {
  readonly challengeToken?: unknown;
  readonly name?: unknown;
  readonly credential?: {
    readonly id?: unknown;
    readonly response?: { readonly clientDataJSON?: unknown; readonly attestationObject?: unknown };
    readonly transports?: unknown;
  };
}

export interface AssertionBody {
  readonly challengeToken?: unknown;
  readonly credential?: {
    readonly id?: unknown;
    readonly response?: {
      readonly clientDataJSON?: unknown;
      readonly authenticatorData?: unknown;
      readonly signature?: unknown;
      readonly userHandle?: unknown;
    };
  };
}

const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']);

/**
 * 56-22. Passkeys: registration (behind fresh proof, like every credential change), sign-in
 * (discoverable credentials, user verification required), list, removal, and the security score.
 */
export class PasskeysService {
  private readonly now: () => number;

  constructor(
    private readonly database: TenantDatabase,
    private readonly credentials: Pick<CredentialsRepository, 'recordAuthenticationEvent'>,
    private readonly options: PasskeysOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  async registrationOptions(input: { userId: string; sessionId: string; correlationId: string }) {
    const user = await this.database.identityRead(
      { correlationId: input.correlationId, tables: [...PASSKEY_TABLES] },
      (db) => findPasskeyOwner(db, input.userId),
    );
    if (!user) throw new PasskeyRejectedError('user_missing');
    const issued = issuePasskeyChallenge(
      { purpose: 'register', userId: input.userId, sessionId: input.sessionId },
      this.options.sessionSecret,
      this.now(),
    );
    return {
      challengeToken: issued.token,
      publicKey: {
        challenge: issued.challenge,
        rp: { id: this.options.rp.rpId, name: this.options.rp.name },
        user: {
          id: Buffer.from(input.userId, 'utf8').toString('base64url'),
          name: user.email,
          displayName: user.displayName,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: ALG_ES256 },
          { type: 'public-key', alg: ALG_RS256 },
        ],
        timeout: 300_000,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      },
    };
  }

  async register(input: {
    userId: string;
    sessionId: string;
    reauthToken: string | undefined;
    body: AttestationBody;
    context: SignInContext;
  }): Promise<{ id: string }> {
    await this.requireReauth(input.userId, input.sessionId, input.reauthToken, input.context);
    const claims = verifyPasskeyChallenge(
      input.body.challengeToken,
      'register',
      this.options.sessionSecret,
      this.now(),
    );
    if (!claims || claims.userId !== input.userId || claims.sessionId !== input.sessionId) {
      throw new PasskeyRejectedError('challenge_invalid');
    }
    const response = input.body.credential?.response;
    const verified = this.webauthn(() =>
      verifyRegistration({
        rp: this.options.rp,
        challenge: claims.challenge,
        requireUserVerification: true,
        clientDataJSON: text(response?.clientDataJSON),
        attestationObject: text(response?.attestationObject),
      }),
    );
    const hash = credentialIdHash(verified.credentialId);
    const name = cleanName(input.body.name);
    const transports = Array.isArray(input.body.credential?.transports)
      ? input.body.credential.transports.filter((t): t is string => TRANSPORTS.has(t as string))
      : [];

    return this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...PASSKEY_TABLES] },
      async (tx) => {
        if (await credentialHashTaken(tx, hash))
          throw new PasskeyRejectedError('credential_exists');
        const id = await insertPasskey(tx, {
          userId: input.userId,
          credentialId: verified.credentialId,
          credentialIdHash: hash,
          publicKey: verified.publicKey,
          alg: verified.alg,
          signCount: verified.signCount,
          name,
          transports: transports.length > 0 ? transports.join(',') : null,
          backedUp: verified.backedUp,
        });
        await this.recordIn(
          tx,
          input.context,
          input.userId,
          PASSKEY_ACTIONS.added,
          'succeeded',
          null,
        );
        await queueSecurityNotice(tx, {
          userId: input.userId,
          action: PASSKEY_ACTIONS.added,
          correlationId: input.context.correlationId,
        });
        return { id };
      },
    );
  }

  signInOptions() {
    const issued = issuePasskeyChallenge(
      { purpose: 'sign_in' },
      this.options.sessionSecret,
      this.now(),
    );
    return {
      challengeToken: issued.token,
      publicKey: {
        challenge: issued.challenge,
        rpId: this.options.rp.rpId,
        timeout: 300_000,
        userVerification: 'required',
      },
    };
  }

  /** Verify an assertion; on success the caller starts the session for the returned user. */
  async signIn(input: {
    body: AssertionBody;
    context: SignInContext;
  }): Promise<{ userId: string }> {
    try {
      return await this.signInOrThrow(input);
    } catch (error) {
      if (error instanceof PasskeyRejectedError) {
        await this.record(input.context, null, 'failed', error.reason).catch(() => undefined);
      }
      throw error;
    }
  }

  private async signInOrThrow(input: { body: AssertionBody; context: SignInContext }) {
    const claims = verifyPasskeyChallenge(
      input.body.challengeToken,
      'sign_in',
      this.options.sessionSecret,
      this.now(),
    );
    if (!claims) throw new PasskeyRejectedError('challenge_invalid');
    const credentialId = text(input.body.credential?.id);
    let hash: string;
    try {
      hash = credentialIdHash(credentialId);
    } catch {
      throw new PasskeyRejectedError('malformed');
    }
    const { correlationId } = input.context;
    const stored = await this.database.identityRead(
      { correlationId, tables: [...PASSKEY_TABLES] },
      (db) => findLivePasskey(db, hash),
    );
    if (!stored) throw new PasskeyRejectedError('passkey_unknown');
    if (stored.disabled) throw new PasskeyRejectedError('account_disabled');
    if (claims.issuedAt <= stored.lastChallengeAt)
      throw new PasskeyRejectedError('challenge_replayed');

    const response = input.body.credential?.response;
    const userHandle = response?.userHandle;
    if (
      typeof userHandle === 'string' &&
      userHandle !== '' &&
      userHandle !== Buffer.from(stored.userId, 'utf8').toString('base64url')
    ) {
      throw new PasskeyRejectedError('user_handle_mismatch');
    }
    const asserted = this.webauthn(() =>
      verifyAssertion({
        rp: this.options.rp,
        challenge: claims.challenge,
        requireUserVerification: true,
        clientDataJSON: text(response?.clientDataJSON),
        authenticatorData: text(response?.authenticatorData),
        signature: text(response?.signature),
        publicKey: stored.publicKey,
        alg: stored.alg,
        storedSignCount: stored.signCount,
      }),
    );

    const refusal = await this.options.signInPolicy?.check(
      stored.userId,
      'password',
      correlationId,
    );
    if (refusal) {
      await this.record(input.context, stored.userId, 'failed', 'policy_method_not_allowed');
      throw new PasskeyPolicyRefusedError(refusal);
    }

    const spent = await this.database.identityTransaction(
      { correlationId, tables: [...PASSKEY_TABLES] },
      async (tx) => {
        const ok = await recordPasskeyUse(tx, {
          id: stored.id,
          expectedSignCount: stored.signCount,
          expectedChallengeAt: stored.lastChallengeAt,
          signCount: asserted.signCount,
          challengeAt: claims.issuedAt,
        });
        if (ok)
          await this.recordIn(
            tx,
            input.context,
            stored.userId,
            PASSKEY_ACTIONS.signIn,
            'succeeded',
            null,
          );
        return ok;
      },
    );
    if (!spent) throw new PasskeyRejectedError('challenge_replayed');
    return { userId: stored.userId };
  }

  async list(userId: string, correlationId: string): Promise<readonly PasskeyListItem[]> {
    return this.database.identityRead({ correlationId, tables: [...PASSKEY_TABLES] }, (db) =>
      listPasskeys(db, userId),
    );
  }

  async remove(input: {
    userId: string;
    sessionId: string;
    passkeyId: string;
    reauthToken: string | undefined;
    context: SignInContext;
  }): Promise<boolean> {
    await this.requireReauth(input.userId, input.sessionId, input.reauthToken, input.context);
    return this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...PASSKEY_TABLES] },
      async (tx) => {
        if (!(await removePasskey(tx, input.userId, input.passkeyId))) return false;
        await this.recordIn(
          tx,
          input.context,
          input.userId,
          PASSKEY_ACTIONS.removed,
          'succeeded',
          null,
        );
        await queueSecurityNotice(tx, {
          userId: input.userId,
          action: PASSKEY_ACTIONS.removed,
          correlationId: input.context.correlationId,
        });
        return true;
      },
    );
  }

  async securityScore(userId: string, correlationId: string): Promise<SecurityScoreView> {
    const facts = await this.database.identityRead(
      { correlationId, tables: [...PASSKEY_TABLES] },
      (db) => readSecurityFacts(db, userId),
    );
    return computeSecurityScore(facts, new Date(this.now()));
  }

  // ───────────────────────────────────────────────────────────────────────────

  /** `D05`: the same fresh proof every other credential change asks for. */
  private async requireReauth(
    userId: string,
    sessionId: string,
    token: string | undefined,
    context: SignInContext,
  ): Promise<void> {
    const verified = verifyReauthToken(token, this.options.sessionSecret, this.now());
    let reason:
      'reauth_required' | 'reauth_expired' | 'reauth_invalid' | 'reauth_wrong_session' | null =
      null;
    if (!verified.ok) {
      reason =
        verified.rejection === 'missing'
          ? 'reauth_required'
          : verified.rejection === 'expired'
            ? 'reauth_expired'
            : 'reauth_invalid';
    } else if (verified.claims.userId !== userId || verified.claims.sessionId !== sessionId) {
      reason = 'reauth_wrong_session';
    }
    if (reason === null) return;
    await this.record(context, userId, 'failed', reason);
    throw new ReauthenticationRequiredError(reason);
  }

  private webauthn<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof WebAuthnError) throw new PasskeyRejectedError(error.reason);
      throw error;
    }
  }

  private async record(
    context: SignInContext,
    userId: string | null,
    outcome: 'succeeded' | 'failed',
    reason: string | null,
  ): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...PASSKEY_TABLES] },
      (tx) => this.recordIn(tx, context, userId, PASSKEY_ACTIONS.signIn, outcome, reason),
    );
  }

  private recordIn(
    tx: Parameters<CredentialsRepository['recordAuthenticationEvent']>[0],
    context: SignInContext,
    userId: string | null,
    action: string,
    outcome: 'succeeded' | 'failed',
    reason: string | null,
  ): Promise<void> {
    return this.credentials.recordAuthenticationEvent(tx, {
      userId,
      action,
      outcome,
      reason,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      correlationId: context.correlationId,
    });
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.replaceAll(/\s+/gu, ' ').trim().slice(0, 100) : '';
  return name === '' ? 'Passkey' : name;
}
