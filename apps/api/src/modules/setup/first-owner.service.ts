import { uuidv7 } from '@tmanage/domain';
import { ApiError, type ApiErrorDetail } from '../../common/http/errors.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { CredentialsRepository } from '../identity/credentials.repository.js';
import { describePasswordRejection, hashPassword, screenPassword } from '../identity/password.js';
import {
  validateOrganizationInput,
  type ValidatedOrganizationInput,
} from '../tenancy/organization-input.js';
import type { ProvisioningService } from '../tenancy/provisioning.service.js';
import { FirstOwnerRepository } from './first-owner.repository.js';
import { setupTokenMatches } from './setup-token.js';
import type { SeedCipher } from '../identity/seed-cipher.js';

/**
 * First-owner setup: how a fresh production install gets its first organization owner.
 *
 * TManage has no public sign-up. Every later person arrives by invitation, so somebody has to
 * exist before anybody can be invited. This service is that somebody's only door, and it is
 * shut unless both of these hold:
 *
 * - the operator set `SETUP_TOKEN` in the environment (otherwise the route is a 404), and the
 *   caller presents it — compared in constant time, before any validation or database access,
 *   so an unauthenticated caller learns nothing about the install by probing;
 * - no organization and no owner exist yet.
 *
 * ## Why the "nothing exists yet" guard lives inside the creating transaction
 *
 * Checking first and creating afterwards in a second unit of work is a race: two requests can
 * both read "zero organizations", both pass, and both create an owner. So the count and every
 * insert run in ONE transaction on ONE connection, opened by `firstOwnerTransaction` only
 * after it holds the `GET_LOCK(FIRST_OWNER_LOCK_NAME)` advisory lock. A second request waits
 * on that lock; by the time it gets it, the first has committed, its count is no longer zero,
 * and it fails with {@link FirstOwnerSetupUnavailableError}. If it cannot get the lock within
 * the timeout, `FirstOwnerLockUnavailableError` propagates and the controller maps it.
 *
 * ## Why no new table
 *
 * "Setup has happened" is not a fact worth storing separately: it is exactly "an organization
 * or an owner membership exists", which the existing tables already answer. A flag table could
 * disagree with them (a restored backup, a deleted organization); the counts cannot.
 *
 * ## Why the session is issued by the controller, after commit
 *
 * A session row for a user whose transaction later rolled back would be a credential for
 * nobody, and the session service runs its own unit of work. So this service only creates the
 * user, password and organization, and returns ids; the controller starts the session once
 * this promise has resolved — i.e. once the transaction has committed.
 *
 * Password hashing (argon2, deliberately slow) runs BEFORE the lock is taken, so a setup in
 * progress never holds the lock for the length of a hash.
 */

/** Setup is not configured, or an organization or owner already exists. The route answers 404. */
export class FirstOwnerSetupUnavailableError extends Error {
  override name = 'FirstOwnerSetupUnavailableError';
  constructor(message = 'First-owner setup is not available on this install.') {
    super(message);
  }
}

/** The presented setup token does not match the configured one. */
export class FirstOwnerTokenRejectedError extends Error {
  override name = 'FirstOwnerTokenRejectedError';
  constructor(message = 'The setup token was not accepted.') {
    super(message);
  }
}

export interface FirstOwnerSetupBody {
  readonly setupToken?: unknown;
  readonly email?: unknown;
  readonly displayName?: unknown;
  readonly password?: unknown;
  readonly organizationName?: unknown;
  readonly slug?: unknown;
  readonly timezone?: unknown;
  readonly defaultLocale?: unknown;
}

export interface FirstOwnerSetupResult {
  readonly userId: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly workspaceId: string;
}

/** Wire bodies (contracts-check pairs these with apps/web/src/lib/api/setup.ts — keep the shapes exactly): */
export interface FirstOwnerAvailabilityView {
  readonly available: true;
}

export interface FirstOwnerSetupView {
  readonly status: 'authenticated';
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly organizationSlug: string;
}

export const FIRST_OWNER_LOCK_NAME = 'tmanage.first_owner_setup';

const FIRST_OWNER_LOCK_TIMEOUT_SECONDS = 5;
const EMAIL_MIN_LENGTH = 3;
const EMAIL_MAX_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISPLAY_NAME_MAX_LENGTH = 190;

/**
 * Setup writes only a password row; `setPassword` never touches MFA seeds. The default
 * repository therefore gets a cipher that refuses every call, so a future change that reached
 * for a seed here fails loudly instead of encrypting under a key this service was never given.
 */
const refuseSeed = (): never => {
  throw new Error('first-owner setup has no MFA seed cipher');
};
const NO_SEED_CIPHER: SeedCipher = {
  encrypt: refuseSeed,
  decrypt: refuseSeed,
  keyVersionOf: refuseSeed,
  needsRotation: refuseSeed,
};

interface ValidatedSetup {
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly organization: ValidatedOrganizationInput;
}

export class FirstOwnerService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly provisioning: ProvisioningService,
    private readonly setupToken: string | null,
    private readonly repository = new FirstOwnerRepository(),
    private readonly credentials = new CredentialsRepository(NO_SEED_CIPHER),
  ) {}

  /** Whether the setup screen should be offered at all. */
  async isAvailable(correlationId: string): Promise<boolean> {
    if (this.setupToken === null) return false;
    const counts = await this.database.bootstrapRead(
      {
        correlationId,
        reason:
          'first-owner setup availability: proving no organization or owner exists yet; ' +
          'nothing exists, so no tenant context can scope this read',
        tables: ['organizations', 'memberships'],
      },
      (runner) => this.repository.countExisting(runner),
    );
    return counts.organizations === 0 && counts.owners === 0;
  }

  async setup(body: FirstOwnerSetupBody, correlationId: string): Promise<FirstOwnerSetupResult> {
    if (this.setupToken === null) throw new FirstOwnerSetupUnavailableError();
    if (!setupTokenMatches(this.setupToken, body.setupToken)) {
      throw new FirstOwnerTokenRejectedError();
    }

    const input = await this.validate(body);

    // Before the lock: argon2 is slow on purpose, and a hash must never hold the lock.
    const passwordHash = await hashPassword(input.password);
    const { organization } = input;

    return this.database.firstOwnerTransaction(
      {
        correlationId,
        lockName: FIRST_OWNER_LOCK_NAME,
        lockTimeoutSeconds: FIRST_OWNER_LOCK_TIMEOUT_SECONDS,
      },
      async (scope) => {
        const counts = await this.repository.countExisting(scope.bootstrap);
        if (counts.organizations > 0 || counts.owners > 0) {
          throw new FirstOwnerSetupUnavailableError();
        }

        const userId = uuidv7();
        await this.repository.insertUser(scope.identity, {
          id: userId,
          email: input.email,
          displayName: input.displayName,
          locale: organization.defaultLocale,
          timezone: organization.timezone,
        });
        await this.credentials.setPassword(scope.identity, userId, passwordHash);

        const provisioned = await this.provisioning.provisionFounderWithin(
          (context) => scope.tenant(context),
          {
            userId,
            slug: organization.slug,
            name: organization.name,
            defaultLocale: organization.defaultLocale,
            timezone: organization.timezone,
            correlationId,
            origin: 'first_owner_setup',
          },
        );

        return {
          userId,
          organizationId: provisioned.organizationId,
          slug: provisioned.slug,
          workspaceId: provisioned.workspaceId,
        };
      },
    );
  }

  /** Every problem at once, in one validation error, so the screen can mark all fields. */
  private async validate(body: FirstOwnerSetupBody): Promise<ValidatedSetup> {
    const details: ApiErrorDetail[] = [];

    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (
      email.length < EMAIL_MIN_LENGTH ||
      email.length > EMAIL_MAX_LENGTH ||
      !EMAIL_SHAPE.test(email)
    ) {
      details.push({ field: 'email', message: 'Enter a valid email address.' });
    }

    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (displayName === '') {
      details.push({ field: 'displayName', message: 'Your name is required.' });
    } else if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
      details.push({
        field: 'displayName',
        message: `Keep your name to ${DISPLAY_NAME_MAX_LENGTH} characters.`,
      });
    }

    let organization: ValidatedOrganizationInput | null = null;
    let status = 422;
    try {
      organization = validateOrganizationInput({
        name: body.organizationName,
        slug: body.slug,
        timezone: body.timezone,
        defaultLocale: body.defaultLocale,
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      status = error.status;
      for (const detail of error.details ?? []) {
        details.push(
          detail.field === 'name' ? { field: 'organizationName', message: detail.message } : detail,
        );
      }
    }

    const password = typeof body.password === 'string' ? body.password : '';
    const identifiers = [
      email.split('@')[0] ?? '',
      organization?.name ??
        (typeof body.organizationName === 'string' ? body.organizationName : ''),
      organization?.slug ?? (typeof body.slug === 'string' ? body.slug : ''),
    ];
    const screened = await screenPassword({ password, identifiers });
    for (const rejection of screened.rejections) {
      details.push({ field: 'password', message: describePasswordRejection(rejection) });
    }

    if (details.length > 0 || organization === null) {
      throw new ApiError(status, 'validation_failed', 'That setup cannot be completed.', details);
    }

    return { email, displayName, password, organization };
  }
}
