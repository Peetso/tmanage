import { randomBytes } from 'node:crypto';
import { uuidv7 } from '@tmanage/domain';
import { ApiError, type ApiErrorDetail } from '../../common/http/errors.js';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WelcomeMailer } from '../../common/email/welcome-email.js';
import type { SeedCipher } from '../identity/seed-cipher.js';
import { CredentialsRepository } from '../identity/credentials.repository.js';
import { describePasswordRejection, hashPassword, screenPassword } from '../identity/password.js';
import {
  MAX_NAME_LENGTH,
  MAX_SLUG_LENGTH,
  slugProblem,
  validateOrganizationInput,
} from '../tenancy/organization-input.js';
import {
  OrganizationSlugTakenError,
  type ProvisioningService,
} from '../tenancy/provisioning.service.js';
import { SignupAccountsRepository } from './signup-accounts.repository.js';

/**
 * Public self-service sign-up (Peter, 2026-10-18: "open the sign up for public for now").
 *
 * One request creates a person and a NEW organization they own, and nothing else:
 *
 * - The account is created in the same transaction as the organization, through the same
 *   `ProvisioningService.provisionFounderWithin` code path first-owner setup uses, so the
 *   organization, its first workspace, the owner membership and the audit row commit together
 *   or not at all. The provisioning context names an organization id generated a moment
 *   earlier that nothing else in the database references — the new owner can reach their own
 *   organization and no other (strict tenant isolation is the tenant guard's ordinary rule).
 * - The role is `owner` of that organization. There is no platform/superuser flag anywhere in
 *   `users`; nothing here grants authority beyond the one organization.
 * - Password rules and hashing are the shared ones (`screenPassword` + argon2 `hashPassword`),
 *   and the hash runs before the transaction so a slow hash never pins a connection.
 * - An address that already has an account is refused with "you already have an account — sign
 *   in" (409 on `email`). That says no more than a sign-up form must; the route is rate-limited
 *   per source and per address in the controller, and the welcome email tells the mailbox owner
 *   if somebody else used their address.
 *
 * The switch (`PUBLIC_SIGNUP`) is enforced by registration: with it off, `app.module` never adds
 * this module, so the routes 404 like any unknown path.
 */

export interface PublicSignupBody {
  readonly displayName?: unknown;
  readonly email?: unknown;
  readonly password?: unknown;
  readonly organizationName?: unknown;
  readonly timezone?: unknown;
  readonly defaultLocale?: unknown;
  /** The honeypot. Hidden from people; a bot that fills every field fills this one too. */
  readonly website?: unknown;
  /** 52-21 form proof: the signed `startedAt`, its `nonce` and the browser-computed `proof`. */
  readonly startedAt?: unknown;
  readonly nonce?: unknown;
  readonly proof?: unknown;
}

export interface PublicSignupResult {
  readonly userId: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly organizationName: string;
}

/** Wire bodies (contracts-check pairs these with apps/web/src/lib/api/sign-up.ts). */
export interface PublicSignupAvailabilityView {
  readonly available: true;
}

export interface PublicSignupView {
  readonly status: 'authenticated';
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly organizationSlug: string;
}

export const ACCOUNT_EXISTS_SIGNUP_MESSAGE = 'You already have an account. Sign in instead.';

export interface NewOwnerAccount {
  readonly email: string;
  readonly displayName: string;
  /** Null for an account created through an identity provider (no password yet). */
  readonly passwordHash: string | null;
  readonly organizationName: string;
  readonly timezone: string;
  readonly defaultLocale: string;
  readonly emailVerified: boolean;
  readonly correlationId: string;
  /** Extra identity-table writes in the same transaction (e.g. linking a Google identity). */
  readonly alsoWithin?: (identity: IdentityQueryRunner, userId: string) => Promise<void>;
}

const EMAIL_MAX_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISPLAY_NAME_MAX_LENGTH = 190;
/** Room for `-xxxx` under `MAX_SLUG_LENGTH`. */
const SLUG_BASE_MAX = 40;
const SLUG_ATTEMPTS = 5;

/** Sign-up writes only a password row; it never touches MFA seeds (see `first-owner.service`). */
const refuseSeed = (): never => {
  throw new Error('public sign-up has no MFA seed cipher');
};
const NO_SEED_CIPHER: SeedCipher = {
  encrypt: refuseSeed,
  decrypt: refuseSeed,
  keyVersionOf: refuseSeed,
  needsRotation: refuseSeed,
};

/** Normalised as the users table stores it, or undefined when it is not an address. */
export function normaliseSignupEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value.length < 3 || value.length > EMAIL_MAX_LENGTH || !EMAIL_SHAPE.test(value)) {
    return undefined;
  }
  return value;
}

/**
 * A web link from a workspace name: ASCII letters and digits, hyphen-separated. A name with no
 * Latin characters (an Arabic name, say) becomes `workspace`; a reserved word gets a suffix.
 */
export function slugBaseFrom(name: string): string {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, SLUG_BASE_MAX)
    .replaceAll(/-+$/gu, '');
  return base === '' ? 'workspace' : base;
}

function withSuffix(base: string): string {
  const suffix = randomBytes(3).toString('hex').slice(0, 4);
  return `${base}-${suffix}`.slice(0, MAX_SLUG_LENGTH);
}

export class PublicSignupService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly provisioning: ProvisioningService,
    private readonly welcome: WelcomeMailer | null,
    private readonly accounts = new SignupAccountsRepository(),
    private readonly credentials = new CredentialsRepository(NO_SEED_CIPHER),
  ) {}

  async signUp(body: PublicSignupBody, correlationId: string): Promise<PublicSignupResult> {
    const input = await this.validate(body);
    const passwordHash = await hashPassword(input.password);
    return this.createOwnerAccount({
      email: input.email,
      displayName: input.displayName,
      passwordHash,
      organizationName: input.organizationName,
      timezone: input.timezone,
      defaultLocale: input.defaultLocale,
      emailVerified: false,
      correlationId,
    });
  }

  /**
   * The account + organization transaction both sign-up doors share (password and Google).
   * A taken web link retries with a short random suffix; a taken email propagates as
   * `SignupEmailTakenError`.
   */
  async createOwnerAccount(account: NewOwnerAccount): Promise<PublicSignupResult> {
    const base = slugBaseFrom(account.organizationName);
    // `slugProblem` also refuses reserved words (`sign-up`, `setup`, ...).
    let slug = slugProblem(base) === undefined ? base : withSuffix(base);

    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await this.provisionOnce(account, slug);
        await this.sendWelcome(account, result);
        return result;
      } catch (error) {
        if (error instanceof OrganizationSlugTakenError && attempt < SLUG_ATTEMPTS) {
          slug = withSuffix(base);
          continue;
        }
        throw error;
      }
    }
  }

  private async provisionOnce(account: NewOwnerAccount, slug: string): Promise<PublicSignupResult> {
    const userId = uuidv7();
    return this.database.invitationRegistrationTransaction(
      { correlationId: account.correlationId },
      async (scope) => {
        await this.accounts.insertUser(scope.identity, {
          id: userId,
          email: account.email,
          displayName: account.displayName,
          locale: account.defaultLocale,
          timezone: account.timezone,
          emailVerified: account.emailVerified,
        });
        if (account.passwordHash !== null) {
          await this.credentials.setPassword(scope.identity, userId, account.passwordHash);
        }
        if (account.alsoWithin) await account.alsoWithin(scope.identity, userId);

        const provisioned = await this.provisioning.provisionFounderWithin(
          (context) => scope.tenant(context),
          {
            userId,
            slug,
            name: account.organizationName,
            defaultLocale: account.defaultLocale,
            timezone: account.timezone,
            correlationId: account.correlationId,
            origin: 'public_signup',
          },
        );
        return {
          userId,
          organizationId: provisioned.organizationId,
          slug: provisioned.slug,
          organizationName: provisioned.name,
        };
      },
    );
  }

  private async sendWelcome(account: NewOwnerAccount, result: PublicSignupResult): Promise<void> {
    if (this.welcome === null) return;
    // After commit, and never fatal: the account exists whether or not the mail goes out.
    await this.welcome.deliver({
      to: account.email,
      organizationSlug: result.slug,
      locale: account.defaultLocale,
    });
  }

  /** Every problem at once, so the screen can mark all fields. */
  private async validate(body: PublicSignupBody): Promise<{
    email: string;
    displayName: string;
    password: string;
    organizationName: string;
    timezone: string;
    defaultLocale: string;
  }> {
    const details: ApiErrorDetail[] = [];

    const email = normaliseSignupEmail(body.email);
    if (email === undefined)
      details.push({ field: 'email', message: 'Enter a valid email address.' });

    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (displayName === '') {
      details.push({ field: 'displayName', message: 'Your name is required.' });
    } else if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
      details.push({
        field: 'displayName',
        message: `Keep your name to ${DISPLAY_NAME_MAX_LENGTH} characters.`,
      });
    }

    const organizationName =
      typeof body.organizationName === 'string' ? body.organizationName.trim() : '';
    if (organizationName === '') {
      details.push({ field: 'organizationName', message: 'A workspace name is required.' });
    } else if (organizationName.length > MAX_NAME_LENGTH) {
      details.push({
        field: 'organizationName',
        message: `Keep the name to ${MAX_NAME_LENGTH} characters.`,
      });
    }

    // Timezone and language are optional (the browser's guess); validated by the shared rules.
    let timezone = 'UTC';
    let defaultLocale = 'en';
    try {
      const checked = validateOrganizationInput({
        name: 'x',
        slug: 'x',
        timezone:
          typeof body.timezone === 'string' && body.timezone.trim() !== '' ? body.timezone : 'UTC',
        defaultLocale: body.defaultLocale,
      });
      timezone = checked.timezone;
      defaultLocale = checked.defaultLocale;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      details.push(...(error.details ?? []));
    }

    const password = typeof body.password === 'string' ? body.password : '';
    const screened = await screenPassword({
      password,
      identifiers: [email?.split('@')[0] ?? '', displayName, organizationName],
    });
    for (const rejection of screened.rejections) {
      details.push({ field: 'password', message: describePasswordRejection(rejection) });
    }

    if (details.length > 0 || email === undefined) {
      throw new ApiError(422, 'validation_failed', 'That account cannot be created.', details);
    }
    return { email, displayName, password, organizationName, timezone, defaultLocale };
  }
}
