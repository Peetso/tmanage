import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import type { CredentialsRepository } from '../identity/credentials.repository.js';
import { CHALLENGE_TTL_SECONDS, signChallengeToken } from '../identity/challenge-token.js';
import type { SignInContext } from '../identity/authentication.service.js';
import { uuidv7, type SignupAttribution } from '@tmanage/domain';
import type { PublicSignupService } from '../signup/public-signup.service.js';
import type { PublicSignupSwitch } from '../platform-admin/platform-settings.js';
import {
  SignupAccountsRepository,
  SignupEmailTakenError,
} from '../signup/signup-accounts.repository.js';
import type { GoogleClaims, GoogleFlow, PendingMfa } from './google-oidc.js';
import type { SignInPolicyGate } from '../identity/sign-in-policy.repository.js';
import {
  GOOGLE_IDENTITY_TABLES,
  IdentityAlreadyLinkedError,
  UserIdentitiesRepository,
} from './user-identities.repository.js';

/**
 * What a verified Google identity is allowed to do, per intent (Peter, 2026-10-18):
 *
 * - **Existing account with that email** (or already linked by `sub`): sign in, linking the
 *   Google identity on first use. If the account has a second factor, it is still required —
 *   the outcome is a pending MFA challenge, exactly the one a correct password produces.
 * - **sign-in, no account**: refused (`no_account`). Signing in never creates an account; the
 *   person has to choose sign-up.
 * - **sign-up, no account**: creates the user and a NEW organization they own through
 *   `PublicSignupService.createOwnerAccount` — only while `PUBLIC_SIGNUP` is on.
 * - **invitation**: the Google email must equal the invited email (`email_mismatch` otherwise).
 *   No account: one is created for the invited address, linked, and the invitation accepted.
 *   An existing account signs in (MFA first, if enabled) and the invitation is accepted.
 * - **Existing account whose address was never proved** (`email_verified_at` NULL — a public
 *   password sign-up): refused (`unverified_account`) for every intent, nothing linked, no
 *   session, no invitation accepted. Anyone can pre-register an address with a password; merging
 *   the real owner's Google identity into that account would hand the pre-registrant the
 *   victim's sign-ins and invitations (audit run 1, F03). The person signs in with the password
 *   or resets it by email instead.
 */

export const GOOGLE_PROVIDER = 'google';
export const GOOGLE_SIGN_IN_ACTION = 'google_sign_in';
/** 51-05 "Continue with Microsoft"; spelled here so the sign-in census finds every action. */
export const MICROSOFT_SIGN_IN_ACTION = 'microsoft_sign_in';

/**
 * The OpenID provider a verified identity came from. Google and Microsoft (51-05) share every
 * rule in this file; only the `user_identities.provider` value, the `authentication_events`
 * action, the sign-in-policy method and the logged reason prefix differ.
 */
export interface SignInProvider {
  readonly id: 'google' | 'microsoft';
  readonly action: string;
}

export const GOOGLE_SIGN_IN_PROVIDER: SignInProvider = {
  id: GOOGLE_PROVIDER,
  action: GOOGLE_SIGN_IN_ACTION,
};

export const MICROSOFT_SIGN_IN_PROVIDER: SignInProvider = {
  id: 'microsoft',
  action: MICROSOFT_SIGN_IN_ACTION,
};

export type GoogleRefusal =
  | 'no_account'
  | 'signup_closed'
  | 'email_mismatch'
  | 'invitation_unusable'
  | 'already_linked'
  | 'unverified_account'
  // R18-e (56-25): every organization of this person forbids Google sign-in.
  | 'method_not_allowed';

type LinkResult = string | null | 'already_linked' | 'unverified_account';

/** A refusal for a link that did not happen; `undefined` when the result is a user id or null. */
function linkRefusal(result: LinkResult): GoogleOutcome | undefined {
  if (result === 'already_linked' || result === 'unverified_account') {
    return { kind: 'refused', reason: result };
  }
  return undefined;
}

export type GoogleOutcome =
  | { readonly kind: 'signed-in'; readonly userId: string; readonly returnTo: string }
  | { readonly kind: 'mfa'; readonly userId: string; readonly pending: PendingMfa }
  | { readonly kind: 'refused'; readonly reason: GoogleRefusal };

export interface InvitationsPort {
  preview(token: string, correlationId: string): Promise<{ readonly inviteeEmail: string }>;
  accept(token: string, userId: string, correlationId: string): Promise<unknown>;
}

export interface GoogleAuthServiceDeps {
  readonly database: TenantDatabase;
  readonly credentials: CredentialsRepository;
  readonly invitations: InvitationsPort;
  /** Null while `PUBLIC_SIGNUP` is off. */
  readonly signup: PublicSignupService | null;
  /** Platform admin's sign-up switch (0206). Absent = open whenever `signup` is present. */
  readonly signupSwitch?: PublicSignupSwitch;
  readonly sessionSecret: string;
  readonly identities?: UserIdentitiesRepository;
  readonly accounts?: SignupAccountsRepository;
  readonly now?: () => number;
  /** R18-e (56-25). The organization sign-in policy; absent = no policy check (unit suites). */
  readonly signInPolicy?: Pick<SignInPolicyGate, 'check'>;
  /** Which provider this instance serves; absent = Google. */
  readonly provider?: SignInProvider;
}

const AFTER_SIGN_IN = '/organizations';

export class GoogleAuthService {
  private readonly identities: UserIdentitiesRepository;
  private readonly accounts: SignupAccountsRepository;
  private readonly now: () => number;
  private readonly provider: SignInProvider;

  constructor(private readonly deps: GoogleAuthServiceDeps) {
    this.provider = deps.provider ?? GOOGLE_SIGN_IN_PROVIDER;
    this.identities = deps.identities ?? new UserIdentitiesRepository();
    this.accounts = deps.accounts ?? new SignupAccountsRepository();
    this.now = deps.now ?? Date.now;
  }

  get signupOpen(): boolean {
    return this.deps.signup !== null;
  }

  /** Open right now: a sign-up service exists and Platform admin's switch (if any) says open. */
  async isSignupOpen(correlationId: string): Promise<boolean> {
    if (this.deps.signup === null) return false;
    return this.deps.signupSwitch ? this.deps.signupSwitch.isOpen(correlationId) : true;
  }

  async complete(
    flow: GoogleFlow,
    claims: GoogleClaims,
    context: SignInContext,
    /** ADTRACK. The landing page's validated `utm_*` values, kept if this creates an account. */
    signupAttribution?: SignupAttribution,
  ): Promise<GoogleOutcome> {
    if (flow.intent === 'invitation') return this.completeInvitation(flow, claims, context);

    const existing = await this.findOrLink(claims, context);
    const refusedLink = linkRefusal(existing);
    if (refusedLink) return refusedLink;
    if (existing !== null) return this.signIn(existing, AFTER_SIGN_IN, context);

    if (flow.intent === 'sign-in') {
      await this.record(context, null, 'failed', 'no_such_user');
      return { kind: 'refused', reason: 'no_account' };
    }
    if (this.deps.signup === null || !(await this.isSignupOpen(context.correlationId))) {
      return { kind: 'refused', reason: 'signup_closed' };
    }

    const displayName = claims.name !== '' ? claims.name : (claims.email.split('@')[0] ?? 'Owner');
    const organizationName =
      flow.organizationName && flow.organizationName.trim() !== ''
        ? flow.organizationName.trim()
        : `${displayName.split(/\s+/u)[0] ?? displayName}'s workspace`;
    try {
      const created = await this.deps.signup.createOwnerAccount({
        email: claims.email,
        displayName,
        passwordHash: null,
        organizationName,
        timezone: 'UTC',
        defaultLocale: 'en',
        emailVerified: true,
        correlationId: context.correlationId,
        alsoWithin: (identity, userId) => this.link(identity, userId, claims),
        ...(signupAttribution === undefined ? {} : { signupAttribution }),
        ...(flow.trialToken === undefined ? {} : { trialToken: flow.trialToken }),
      });
      await this.record(context, created.userId, 'succeeded', null);
      return {
        kind: 'signed-in',
        userId: created.userId,
        returnTo: `/${encodeURIComponent(created.slug)}/home`,
      };
    } catch (error) {
      // Raced with another sign-up for the same address: sign in to the account that won.
      if (error instanceof SignupEmailTakenError) {
        const again = await this.findOrLink(claims, context);
        const refusedAgain = linkRefusal(again);
        if (refusedAgain) return refusedAgain;
        if (again !== null) return this.signIn(again, AFTER_SIGN_IN, context);
      }
      throw error;
    }
  }

  private async completeInvitation(
    flow: GoogleFlow,
    claims: GoogleClaims,
    context: SignInContext,
  ): Promise<GoogleOutcome> {
    const token = flow.invitationToken ?? '';
    let invitedEmail: string;
    try {
      invitedEmail = (await this.deps.invitations.preview(token, context.correlationId))
        .inviteeEmail;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return { kind: 'refused', reason: 'invitation_unusable' };
      }
      throw error;
    }
    if (invitedEmail.trim().toLowerCase() !== claims.email) {
      await this.record(context, null, 'failed', `${this.provider.id}_email_mismatch`);
      return { kind: 'refused', reason: 'email_mismatch' };
    }

    const found = await this.findOrLink(claims, context);
    if (found === 'already_linked' || found === 'unverified_account') {
      return { kind: 'refused', reason: found };
    }
    let userId: string | null = found;

    if (userId === null) {
      const newId = uuidv7();
      const displayName =
        claims.name !== '' ? claims.name : (claims.email.split('@')[0] ?? 'Member');
      try {
        await this.deps.database.identityTransaction(
          { correlationId: context.correlationId, tables: [...GOOGLE_IDENTITY_TABLES] },
          async (tx) => {
            await this.accounts.insertUser(tx, {
              id: newId,
              email: invitedEmail,
              displayName,
              locale: 'en',
              timezone: 'UTC',
              emailVerified: true,
            });
            await this.link(tx, newId, claims);
          },
        );
        userId = newId;
      } catch (error) {
        if (!(error instanceof SignupEmailTakenError)) throw error;
        const again = await this.findOrLink(claims, context);
        const refusedAgain = linkRefusal(again);
        if (refusedAgain) return refusedAgain;
        if (again === null) return { kind: 'refused', reason: 'already_linked' };
        userId = again;
      }
    }

    const factors = await this.factorsOf(userId, context);
    if (factors.length > 0) {
      // Second factor first; the invitation is accepted from its own page once signed in.
      return this.challenge(userId, factors, `/invitations/${encodeURIComponent(token)}`, context);
    }
    try {
      await this.deps.invitations.accept(token, userId, context.correlationId);
    } catch (error) {
      // Already a member (ACC-04) is not a reason to refuse a sign-in.
      if (!(error instanceof ApiError && error.status === 409)) {
        if (error instanceof ApiError && error.status === 404) {
          return { kind: 'refused', reason: 'invitation_unusable' };
        }
        throw error;
      }
    }
    await this.record(context, userId, 'succeeded', null);
    return { kind: 'signed-in', userId, returnTo: AFTER_SIGN_IN };
  }

  /** The person this Google identity belongs to, linking by verified email on first use. */
  private async findOrLink(claims: GoogleClaims, context: SignInContext): Promise<LinkResult> {
    const result = await this.deps.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...GOOGLE_IDENTITY_TABLES] },
      async (tx) => {
        const bySubject = await this.identities.findUserBySubject(
          tx,
          this.provider.id,
          claims.subject,
        );
        if (bySubject) {
          await this.identities.touch(tx, this.provider.id, claims.subject);
          return bySubject.userId;
        }
        const byEmail = await this.identities.findUserByEmail(tx, claims.email);
        if (!byEmail) return null;
        // Never merge into an account whose mailbox nobody has proved: it may be pre-registered.
        if (!byEmail.emailVerifiedAt) return 'unverified_account' as const;
        try {
          await this.link(tx, byEmail.userId, claims);
        } catch (error) {
          // The account is linked to a DIFFERENT Google account already: never silently swap.
          if (error instanceof IdentityAlreadyLinkedError) return 'already_linked' as const;
          throw error;
        }
        return byEmail.userId;
      },
    );
    if (result === 'unverified_account') {
      await this.record(context, null, 'failed', `${this.provider.id}_unverified_account`);
    }
    return result;
  }

  private link(tx: IdentityQueryRunner, userId: string, claims: GoogleClaims): Promise<void> {
    return this.identities.link(tx, {
      userId,
      provider: this.provider.id,
      subject: claims.subject,
      email: claims.email,
    });
  }

  private async signIn(
    userId: string,
    returnTo: string,
    context: SignInContext,
  ): Promise<GoogleOutcome> {
    // R18-e (56-25). After Google proved the identity: refused when every organization of this
    // person forbids Google sign-in. A failed read throws (fail closed: no session).
    const refusal = await this.deps.signInPolicy?.check(
      userId,
      this.provider.id,
      context.correlationId,
    );
    if (refusal) {
      await this.record(context, userId, 'failed', 'policy_method_not_allowed');
      return { kind: 'refused', reason: 'method_not_allowed' };
    }
    const factors = await this.factorsOf(userId, context);
    if (factors.length > 0) return this.challenge(userId, factors, returnTo, context);
    await this.record(context, userId, 'succeeded', null);
    return { kind: 'signed-in', userId, returnTo };
  }

  private factorsOf(userId: string, context: SignInContext) {
    return this.deps.database.identityRead(
      { correlationId: context.correlationId, tables: [...GOOGLE_IDENTITY_TABLES] },
      (db) => this.deps.credentials.listActiveFactors(db, userId),
    );
  }

  /** The same challenge a correct password yields; `/v1/auth/mfa` completes it. */
  private async challenge(
    userId: string,
    factors: readonly { id: string; kind: string; label: string }[],
    returnTo: string,
    context: SignInContext,
  ): Promise<GoogleOutcome> {
    await this.record(context, userId, 'succeeded', 'mfa_required');
    const expiresAt = new Date(this.now() + CHALLENGE_TTL_SECONDS * 1000);
    return {
      kind: 'mfa',
      userId,
      pending: {
        challengeToken: signChallengeToken({ userId, expiresAt }, this.deps.sessionSecret),
        expiresAt: expiresAt.toISOString(),
        factors: factors.map((factor) => ({
          id: factor.id,
          kind: factor.kind,
          label: factor.label,
        })),
        returnTo,
      },
    };
  }

  async record(
    context: SignInContext,
    userId: string | null,
    outcome: 'succeeded' | 'failed',
    reason: string | null,
  ): Promise<void> {
    await this.deps.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...GOOGLE_IDENTITY_TABLES] },
      (tx) =>
        this.deps.credentials.recordAuthenticationEvent(tx, {
          userId,
          action: this.provider.action,
          outcome,
          reason,
          ip: context.ip ?? null,
          userAgent: context.userAgent ?? null,
          correlationId: context.correlationId,
        }),
    );
  }
}
