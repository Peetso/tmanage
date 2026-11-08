import {
  authorize,
  CLIENT_ROLES,
  hasCapability,
  isClientRole,
  isInternalRole,
  mayGrantCapability,
  parseCustomRoleCapabilities,
  PROJECT_ROLES,
  uuidv7,
} from '@tmanage/domain';
import type { Capability, ClientRole, Principal } from '@tmanage/domain';
import { createTenantContext } from '../../common/database/tenant-context.js';
import { serializeForLog } from '../../common/observability/logger.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import { ClientMembershipsRepository } from '../clients/client-memberships.repository.js';
import { MembershipsRepository } from './memberships.repository.js';
import { StaffClientRowsRepository } from './membership-resolver.repository.js';
import { MemberBulkRoleRepository } from './member-bulk-role.repository.js';
import { customRoleCapabilities } from './member-role.controller.js';
import { assertClientRoleWithinCeiling } from './client-role-ceiling.js';
import type { ClientCeilingOf } from './client-role-ceiling.js';
import {
  InvitationAlreadyPendingError,
  InvitationNotFoundError,
  InvitationNotPendingError,
  InvitationsRepository,
} from './invitations.repository.js';
import type { InvitationMailFactsRow } from './invitations.repository.js';
import type { InvitationDelivery, InvitationMailer } from '../../common/email/invitation-mailer.js';
import {
  hashInvitationToken,
  issueInvitationToken,
  looksLikeInvitationToken,
} from '../identity/invitation-token.js';
import type { InvitationRow } from '../../common/database/schema.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';
import { CredentialsRepository } from '../identity/credentials.repository.js';
import { describePasswordRejection, hashPassword, screenPassword } from '../identity/password.js';
import type { SeedCipher } from '../identity/seed-cipher.js';
import {
  InviteeAccountExistsError,
  InviteeAccountsRepository,
  isDuplicateKey,
} from './invitee-accounts.repository.js';
import { PoliciesRepository } from '../admin/policies.repository.js';
import { normalizePolicy } from '../admin/policies.allowlist.js';
import { parsePlatformAdminEmails } from '../platform-admin/platform-admin.access.js';
import {
  capabilitiesOfStoredRole,
  exceedsCaller,
  isRoleAssigner,
  requireMayGrantRole,
  ROLE_ASSIGNERS,
} from './role-grant-ceiling.js';

/**
 * TEN-003 — issuing, accepting, revoking and expiring an invitation.
 *
 * `23-ERD-AND-STATE-MACHINES` §9 gives the machine; this service is the part that decides who
 * may drive it and records that they did.
 *
 * ## Accepting has no tenant context, and that is the whole difficulty
 *
 * Every other write in this system runs under a `TenantContext` the guard built from a
 * membership row. The person following an invitation link has no membership — creating one is
 * the point of the request — so there is nothing for the guard to resolve, and
 * `TenantContextGuard` never runs on this route.
 *
 * The shape of the answer is `ProvisioningService`'s: **the row itself says which organization
 * this is about**, so the service reads it, builds a context around that organization, and
 * runs the whole transaction inside it. What differs from provisioning is where the
 * organization id comes from — there, it was generated; here it is read from a row nobody
 * signed in for. That read is the one place this ticket touches the escape hatch:
 *
 *   * `bootstrapRead`, so the statement is **read-only**, carries an audited reason, and is
 *     allowlisted to `invitations` and nothing else.
 *   * The lookup key is a 256-bit token hash on a unique index, so the read either finds the
 *     one row the caller already proved they hold, or finds nothing.
 *   * `status = 'pending'` and `expires_at > now()` are in the same `WHERE`, so a revoked or
 *     overdue invitation is never returned to be mishandled.
 *
 * The context that is then built claims a membership id that this transaction is about to
 * create, exactly as provisioning does, and `policyVersion` is the literal string
 * `invitation-acceptance` — a value no resolved context can produce, so a cache keyed on it
 * cannot collide with a real one.
 *
 * ## The refusal is the same for every failure
 *
 * A token that does not exist, one that was revoked, one that expired and one that was already
 * used all produce **404 with one message**. The alternative leaks: "this invitation was
 * revoked" tells whoever holds a stolen link that the address is real and that somebody
 * noticed. `ID-002`'s sign-in path made the same choice for the same reason, and the audit
 * trail keeps the precision the response drops.
 */

/** B11: the detail token a duplicate invitation is refused with. */
export const INVITATION_ALREADY_PENDING = 'invitation_already_pending';

/**
 * B11: the one 409 every "this address already has an open invitation" refusal answers with —
 * the controller's early read, the service's in-transaction read, and the unique key on
 * `invitation_pending_keys` that a concurrent issue trips (`InvitationAlreadyPendingError`).
 */
export function invitationAlreadyPending(): ApiError {
  return new ApiError(
    409,
    'conflict',
    'That address already has a pending invitation. Revoke it or change its role instead.',
    [{ field: 'email', message: INVITATION_ALREADY_PENDING }],
    INVITATION_ALREADY_PENDING,
  );
}

/** `22-SCREEN-BY-SCREEN` §3 ON-06 sends a link; the link is useless after this long. */
const DEFAULT_TTL_DAYS = 14;

/** `users.display_name` is `VARCHAR(190)`. */
const DISPLAY_NAME_MAX_LENGTH = 190;

/**
 * Accepting while signed in to an account that already belongs where the invitation leads
 * (ACC-04). Before this, the membership insert hit `uq_memberships_org_user` and the caller
 * got a bare 500; the invitation stays pending either way, so the person it was really meant
 * for can still use it.
 */
export const ALREADY_MEMBER_MESSAGE =
  'The account you are signed in with is already a member here. If this invitation is for ' +
  'someone else, sign out and open the link again.';

/** Registering from an invitation whose address already has an account. */
export const ACCOUNT_EXISTS_MESSAGE =
  'An account already uses this email address. Sign in with it, then open the link again.';

/**
 * Registration writes only a password row; `setPassword` never touches MFA seeds. The cipher
 * refuses every call, so a later change that reached for a seed here fails loudly — the same
 * guard `FirstOwnerService` uses.
 */
const refuseSeed = (): never => {
  throw new Error('invitation registration has no MFA seed cipher');
};
const NO_SEED_CIPHER: SeedCipher = {
  encrypt: refuseSeed,
  decrypt: refuseSeed,
  keyVersionOf: refuseSeed,
  needsRotation: refuseSeed,
};

export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly clientOrganizationId: string | null;
  readonly status: 'pending' | 'accepted' | 'expired' | 'revoked';
  readonly expiresAt: string;
  readonly invitedByUserId: string;
  readonly acceptedByUserId: string | null;
  readonly acceptedAt: string | null;
  readonly createdAt: string;
}

/**
 * An explicit projection — `25-AUTH-AND-TENANT-ISOLATION` §7. `token_hash` is absent and there
 * is no code path that could put it here: the field is not on this type.
 */
function toView(row: InvitationRow): InvitationView {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    clientOrganizationId: row.clientOrganizationId,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    invitedByUserId: row.invitedByUserId,
    acceptedByUserId: row.acceptedByUserId,
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface IssuedInvitationView {
  readonly invitation: InvitationView;
  /**
   * Shown once, to the issuer. `22-SCREEN-BY-SCREEN` §3 ON-06 builds the link from it.
   *
   * Returned from this call and never again: the row holds only a hash, so there is nothing
   * for a later "resend the same link" endpoint to read even if somebody wrote one.
   *
   * Returned **whatever `delivery` says**: the printed link is the bootstrap fallback, and
   * an email that was sent does not make the issuer's own copy of the link less theirs.
   *
   * `InvitationsController` drops it for a bound-token caller (NV13) — see `withoutToken`
   * there — so a personal access token or AI grant never sees the raw link.
   */
  readonly token: string;
  /**
   * What happened to the invitation email. `'none'` — no transport is configured, send the
   * link yourself — is this deployment's normal answer under `EMAIL_DRIVER=console`.
   * `'failed'` means a transport exists and refused; the invitation itself stands either
   * way, which is why this is a field and not an error.
   */
  readonly delivery: InvitationDelivery;
}

/**
 * What `ID-03` shows somebody before they accept.
 *
 * `22-SCREEN-BY-SCREEN` §3 lists inviter, organization, project, role, access summary, expiry
 * and an account-switch option. Everything here except the project is available; an invitation
 * names no project, `0005_invitations.sql` has no column for one and `23-ERD` §9 does not give
 * it one, so the screen says which organization and which role and does not invent one.
 */
export interface InvitationPreviewView {
  readonly organizationName: string;
  readonly inviterName: string;
  readonly inviterEmail: string;
  readonly role: string;
  readonly audience: 'internal' | 'client';
  /** The client organization's name, when this is portal access rather than team membership. */
  readonly clientOrganizationName: string | null;
  readonly invitedAt: string;
  readonly expiresAt: string;
  /**
   * The address the invitation was sent to. Disclosed only to whoever holds the token that was
   * mailed to it — the person reading their own address back.
   */
  readonly inviteeEmail: string;
  /**
   * Whether an account already uses that address (ACC-01). `false` is what lets `ID-03` offer
   * "set a password and join" instead of sending a brand-new invitee to a sign-in screen they
   * can never pass. Same audience as `inviteeEmail`, so it tells nobody anything new.
   */
  readonly hasAccount: boolean;
  /** A1 (0218). The inviter's personal note, or null. Same audience as `inviteeEmail`. */
  readonly note: string | null;
}

/** A1: at most this many projects on one invitation (the invite dialog's multi-select). */
export const MAX_INVITATION_PROJECTS = 20;
/** A1: `invitations.note` is `VARCHAR(500)`. */
export const MAX_INVITATION_NOTE_LENGTH = 500;

/**
 * The project role an accepted invitee gets on each "Add to projects" project: their organization
 * role when it is also a project role (manager, member, guest), otherwise `member` — an owner or
 * admin already reaches every project through their org-wide scope.
 */
export function projectRoleForInvitation(role: string): string {
  return (PROJECT_ROLES as readonly string[]).includes(role) ? role : 'member';
}

export interface AcceptedInvitationView {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly clientOrganizationId: string | null;
  readonly role: string;
}

/** A registration: the new account's id (the controller starts its session) and the grant. */
export interface RegisteredInvitation extends AcceptedInvitationView {
  readonly userId: string;
}

export interface RegisterInvitationInput {
  readonly displayName?: unknown;
  readonly password?: unknown;
}

export interface InvitationsServiceOptions {
  readonly ttlDays?: number;
  /**
   * NV04: `PLATFORM_ADMIN_EMAILS`, parsed. Defaults to the environment variable the API config
   * reads, so every construction site refuses the same addresses without extra wiring.
   */
  readonly platformAdminEmails?: readonly string[];
  /** F36b: internal invitations one organization may issue (or re-issue) per rolling hour. */
  readonly issueLimitPerHour?: number;
  /** N05: portal invitations one client organization may issue (or re-issue) per rolling hour. */
  readonly clientIssueLimitPerHour?: number;
  /** R23-b (56-28): a client role's ceiling; injectable only so a test can widen one. */
  readonly clientCeilingOf?: ClientCeilingOf;
}

/** F36b: the default per-organization issuance ceiling — far above any real onboarding day. */
export const INVITATION_ISSUE_LIMIT_PER_HOUR = 50;

/**
 * N05: the default per-client-organization ceiling. A client admin's invitations are counted in
 * their own bucket against this, and never against the organization's internal quota above.
 */
export const INVITATION_CLIENT_ISSUE_LIMIT_PER_HOUR = 20;

/**
 * NV13: the roles a bound token (a personal access token or an AI grant) may invite with. A token
 * must not mint a credential that outlives its own revocation with more authority than a plain
 * team seat (`0202`'s invariant), so anything stronger needs a signed-in browser session.
 */
const BOUND_TOKEN_INVITE_ROLES: ReadonlySet<string> = new Set<string>([
  'member',
  'guest',
  ...CLIENT_ROLES,
]);

export const PRIVILEGED_INVITE_MESSAGE =
  'Sign in to TManage in your browser to invite someone with this role.';
export const INVITE_DOMAIN_MESSAGE =
  'Your organization only allows invitations to its own domains.';
export const GUEST_ACCESS_OFF_MESSAGE = 'Your organization has turned off guest access.';
export const INVITE_RATE_MESSAGE = 'Too many invitations in the last hour. Try again later.';
export const INVITE_ADDRESS_REFUSED_MESSAGE = 'That address cannot be invited.';
/** F27a: neutral — it does not say which account, or that it is a staff account. */
export const INVITE_INTERNAL_MEMBER_MESSAGE =
  'This invitation cannot be accepted with the account you are signed in with.';

export class InvitationsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly invitations: InvitationsRepository = new InvitationsRepository(),
    private readonly memberships: MembershipsRepository = new MembershipsRepository(),
    private readonly clientMemberships: ClientMembershipsRepository = new ClientMembershipsRepository(),
    /** Optional for the reason `ProjectsService`'s is: a test can assert what was written. */
    private readonly audit?: AuditService,
    /** Optional the same way: absent means every delivery answers `'none'`. */
    private readonly invitationMail?: InvitationMailer,
    private readonly options: InvitationsServiceOptions = {},
    private readonly inviteeAccounts: InviteeAccountsRepository = new InviteeAccountsRepository(),
    private readonly credentials: CredentialsRepository = new CredentialsRepository(NO_SEED_CIPHER),
    /** F1: resolves a custom role from Control > Roles when an invitation carries one. */
    private readonly customRoles: MemberBulkRoleRepository = new MemberBulkRoleRepository(),
    /** F52b: the organization's access policy (invite domain allowlist, guest access). */
    private readonly policies: PoliciesRepository = new PoliciesRepository(),
    /** Wave 11 Q4 (M05): the client rows internal acceptance ends. */
    private readonly staffClientRows: StaffClientRowsRepository = new StaffClientRowsRepository(),
  ) {}

  async list(
    context: TenantContext,
    principal: Principal,
    options: {
      readonly statuses?: readonly ('pending' | 'accepted' | 'expired' | 'revoked')[];
    } = {},
  ): Promise<readonly InvitationView[]> {
    this.requireInviteCapability(principal, context, 'invitation.list');

    const rows = await this.database.read(context, (runner) =>
      this.invitations.list(runner, context, options),
    );
    return rows.map(toView);
  }

  /**
   * Issue an invitation, returning the token exactly once.
   *
   * A pending invitation for the same address and the same destination is **refused**, not
   * replaced. §9's rule — "role/scope change after issuance revokes old invitation and issues
   * a new one" — makes replacing a two-step act with two audit rows, and doing it implicitly
   * here would record one event for two decisions. `reissue` is that act, named.
   */
  async issue(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly email: string;
      readonly role: string;
      readonly clientOrganizationId?: string | null;
      /** A1: projects the invitee joins on acceptance. Internal invitations only. */
      readonly projectIds?: readonly string[];
      /** A1: the inviter's personal note. */
      readonly note?: string | null;
    },
    now: Date = new Date(),
  ): Promise<IssuedInvitationView> {
    const clientOrganizationId = input.clientOrganizationId ?? null;
    this.requireInviteCapability(principal, context, 'invitation.issue', clientOrganizationId);

    const email = input.email.trim().toLowerCase();
    const customRole = isCustomRoleCandidate(input.role, clientOrganizationId);
    if (!customRole) {
      this.requireRoleMatchesDestination(input.role, clientOrganizationId, 'invitation.issue');
    }
    requireSessionForPrivilegedInvite(context, input.role, 'invitation.issue');
    requireOwnerToGrantOwner(principal, input.role, 'invitation.issue');
    // F05: a built-in role only within the inviter's own authority.
    if (!customRole) {
      requireMayGrantRole(principal, input.role, context.organizationId, 'invitation.issue');
    }
    await this.requireNotUnclaimedPlatformAdmin(context, email);

    const projectIds = [...new Set(input.projectIds ?? [])];
    if (projectIds.length > 0 && clientOrganizationId !== null) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'projectIds', message: 'a client invitation cannot add projects' },
      ]);
    }
    if (projectIds.length > MAX_INVITATION_PROJECTS) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'projectIds', message: `at most ${MAX_INVITATION_PROJECTS} projects` },
      ]);
    }
    requireProjectAuthority(principal, context, projectIds, 'invitation.issue');
    const trimmedNote = typeof input.note === 'string' ? input.note.trim() : '';
    if (trimmedNote.length > MAX_INVITATION_NOTE_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'note', message: `at most ${MAX_INVITATION_NOTE_LENGTH} characters` },
      ]);
    }
    const note = trimmedNote === '' ? null : trimmedNote;

    const { token, tokenHash } = issueInvitationToken();
    const expiresAt = this.expiryFrom(now);

    // `writing` turns a lost race on the address claim into the same 409 as the read below.
    const { row, mailFacts } = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        if (customRole) await this.requireGrantableCustomRole(tx, context, principal, input.role);
        await this.requireInvitePolicy(tx, context, email, input.role, clientOrganizationId);
        await this.requireUnderIssueLimit(tx, context, clientOrganizationId);
        const existing = await this.invitations.findPendingForEmail(
          tx,
          context,
          email,
          clientOrganizationId,
        );
        if (existing.length > 0) throw invitationAlreadyPending();

        if (projectIds.length > 0) {
          // A foreign, unknown or archived project is one 400 naming the field, never which id.
          const live = await this.invitations.liveProjectIds(tx, context, projectIds);
          if (live.length !== projectIds.length) {
            throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
              { field: 'projectIds', message: 'every project must be a live project here' },
            ]);
          }
        }

        const issued = await this.invitations.issue(tx, context, {
          email,
          role: input.role,
          clientOrganizationId,
          tokenHash,
          expiresAt,
          invitedByUserId: context.userId,
          note,
        });
        await this.invitations.attachProjects(tx, context, issued.id, projectIds);

        await this.audit?.record(tx, context, {
          action: 'invitation.issued',
          objectId: issued.id,
          result: 'allowed',
          metadata: {
            role: issued.role,
            // How many projects, never the note: prose is not audit metadata.
            ...(projectIds.length > 0 ? { project_count: String(projectIds.length) } : {}),
            // Which kind of invitation, never the address. An email is personal data and §12's
            // metadata rule is identifiers and classifications — see `isSafeAuditMetadata`.
            destination: clientOrganizationId === null ? 'organization' : 'client_organization',
            ...(clientOrganizationId === null
              ? {}
              : { client_organization_id: clientOrganizationId }),
          },
        });

        return { row: issued, mailFacts: await this.mailFactsFor(tx, context, issued.id) };
      }),
    );

    const delivery = await this.deliverInvitationEmail(context, row, mailFacts, token);
    return { invitation: toView(row), token, delivery };
  }

  /**
   * Revoke and re-issue in one transaction — §9's "role/scope change after issuance".
   *
   * Two audit rows, because two things happened. A caller who only wanted to change the role
   * still withdrew a live token, and the trail says so.
   */
  async reissue(
    context: TenantContext,
    principal: Principal,
    invitationId: string,
    input: { readonly role?: string },
    now: Date = new Date(),
  ): Promise<IssuedInvitationView> {
    this.requireInviteCapability(principal, context, 'invitation.reissue');

    const { token, tokenHash } = issueInvitationToken();
    const expiresAt = this.expiryFrom(now);

    const { row, mailFacts } = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const previous = await this.invitations.requireById(tx, context, invitationId);
        const role = input.role ?? previous.role;
        requireSessionForPrivilegedInvite(context, role, 'invitation.reissue');
        if (isCustomRoleCandidate(role, previous.clientOrganizationId)) {
          await this.requireGrantableCustomRole(tx, context, principal, role);
        } else {
          this.requireRoleMatchesDestination(
            role,
            previous.clientOrganizationId,
            'invitation.reissue',
          );
          // F05: the same ceiling as issue — a re-issue cannot raise the role past the caller.
          requireMayGrantRole(principal, role, context.organizationId, 'invitation.reissue');
        }
        requireOwnerToGrantOwner(principal, role, 'invitation.reissue');
        // F52b and F36b: the policy and the hourly ceiling hold for a re-issue as for an issue.
        await this.requireInvitePolicy(
          tx,
          context,
          previous.email,
          role,
          previous.clientOrganizationId,
        );
        await this.requireUnderIssueLimit(tx, context, previous.clientOrganizationId);
        // F05: the projects carried over must be ones the re-issuer may add people to.
        const carriedProjects = await this.invitations.projectIdsFor(tx, context, previous.id);
        requireProjectAuthority(principal, context, carriedProjects, 'invitation.reissue');

        const revoked = await this.invitations.revoke(tx, context, invitationId);
        await this.audit?.record(tx, context, {
          action: 'invitation.revoked',
          objectId: revoked.id,
          result: 'allowed',
          // `revocation`, not `reason`: `reason` is in `FORBIDDEN_KEY_SEGMENTS` because it is
          // where prose ends up, and `isSafeAuditMetadata` refuses the whole record for it.
          // What travels here is a classification with exactly two values.
          metadata: { revocation: 'reissued' },
        });

        const issued = await this.invitations.issue(tx, context, {
          email: previous.email,
          role,
          clientOrganizationId: previous.clientOrganizationId,
          tokenHash,
          expiresAt,
          invitedByUserId: context.userId,
          // A1: the re-issued invitation keeps the note and the projects of the one it replaces.
          note: previous.note ?? null,
        });
        await this.invitations.attachProjects(tx, context, issued.id, carriedProjects);
        await this.audit?.record(tx, context, {
          action: 'invitation.issued',
          objectId: issued.id,
          result: 'allowed',
          metadata: {
            role: issued.role,
            destination:
              issued.clientOrganizationId === null ? 'organization' : 'client_organization',
            replaces: revoked.id,
          },
        });

        return { row: issued, mailFacts: await this.mailFactsFor(tx, context, issued.id) };
      }),
    );

    const delivery = await this.deliverInvitationEmail(context, row, mailFacts, token);
    return { invitation: toView(row), token, delivery };
  }

  async revoke(
    context: TenantContext,
    principal: Principal,
    invitationId: string,
  ): Promise<InvitationView> {
    this.requireInviteCapability(principal, context, 'invitation.revoke');

    const row = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const revoked = await this.invitations.revoke(tx, context, invitationId);
        await this.audit?.record(tx, context, {
          action: 'invitation.revoked',
          objectId: revoked.id,
          result: 'allowed',
          metadata: { revocation: 'withdrawn' },
        });
        return revoked;
      }),
    );

    return toView(row);
  }

  /**
   * Accept an invitation.
   *
   * `userId` comes from the verified session and never from the body: the route requires a
   * signed-in person, because a membership has to belong to an account. The invitation's
   * `email` is *not* required to match that account's address — see `0005_invitations.sql` —
   * and both facts end up on the row.
   */
  async accept(
    token: string,
    userId: string,
    correlationId: string,
  ): Promise<AcceptedInvitationView> {
    if (!looksLikeInvitationToken(token)) {
      // Same refusal as a token that does not exist. A malformed one learns nothing extra.
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'invitation_malformed');
    }

    const tokenHash = hashInvitationToken(token);

    const invitation = await this.database.bootstrapRead(
      {
        correlationId,
        reason:
          'resolving which organization an invitation token belongs to; the person accepting ' +
          'has no membership yet, so no tenant context can exist to scope this read',
        tables: ['invitations'],
      },
      (runner) => this.invitations.findPendingByTokenHash(runner, tokenHash),
    );

    if (!invitation) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'invitation_not_pending');
    }

    const context = acceptanceContext(invitation, userId, correlationId);

    try {
      return await this.database.transaction(context, async (tx) => {
        await this.requireInviterStillMayGrant(tx, context, invitation);
        return this.grantWithin(tx, context, invitation.id, userId, { existingAccount: true });
      });
    } catch (error) {
      throw alreadyMemberOr(error);
    }
  }

  /**
   * Accept an invitation as somebody who has no account yet (ACC-01): create the account with
   * the invitation's own address, set its password, and grant what the invitation grants — in
   * one transaction, so there is never an account without its membership or the reverse.
   *
   * **Public**, like `preview`: the token is the credential; the address comes from the row,
   * never from the body. Holding the token does **not** prove the mailbox (F03 / NV04: the
   * inviter also receives it), so the account is created unverified — see
   * `InviteeAccountsRepository`. If an account already uses the address the answer is 409 and the
   * person signs in instead — a registration never touches an existing account.
   *
   * Returns the new user's id; the controller starts the session once this has committed, as
   * `FirstOwnerController` does.
   */
  async register(
    token: string,
    input: RegisterInvitationInput,
    correlationId: string,
  ): Promise<RegisteredInvitation> {
    if (!looksLikeInvitationToken(token)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'invitation_malformed');
    }

    const invitation = await this.database.bootstrapRead(
      {
        correlationId,
        reason:
          'resolving which organization an invitation token belongs to so its invitee can ' +
          'create an account and join; they have no account and no membership, so no tenant ' +
          'context can exist to scope this read',
        tables: ['invitations'],
      },
      (runner) => this.invitations.findPendingByTokenHash(runner, hashInvitationToken(token)),
    );
    if (!invitation) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'invitation_not_pending');
    }
    // NV04: registration creates the account for the invitation's address, so an operator
    // address (which by definition has no account yet here) is never minted from an invitation.
    if (this.platformAdminEmails().includes(invitation.email.trim().toLowerCase())) {
      throw new ApiError(
        422,
        'validation_failed',
        'That account cannot be created.',
        [{ field: 'email', message: 'address_not_invitable' }],
        'invitation_registration_platform_admin',
      );
    }

    const details: { field: string; message: string }[] = [];
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (displayName === '') {
      details.push({ field: 'displayName', message: 'Your name is required.' });
    } else if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
      details.push({
        field: 'displayName',
        message: `Keep your name to ${DISPLAY_NAME_MAX_LENGTH} characters.`,
      });
    }
    const password = typeof input.password === 'string' ? input.password : '';
    const screened = await screenPassword({
      password,
      identifiers: [invitation.email.split('@')[0] ?? '', displayName],
    });
    for (const rejection of screened.rejections) {
      details.push({ field: 'password', message: describePasswordRejection(rejection) });
    }
    if (details.length > 0) {
      throw new ApiError(422, 'validation_failed', 'That account cannot be created.', details);
    }

    // Before the transaction: argon2 is slow on purpose and must not hold a connection open.
    const passwordHash = await hashPassword(password);
    const userId = uuidv7();
    const context = acceptanceContext(invitation, userId, correlationId);

    try {
      const granted = await this.database.invitationRegistrationTransaction(
        { correlationId },
        async (scope) => {
          await this.inviteeAccounts.insertUser(scope.identity, {
            id: userId,
            email: invitation.email,
            displayName,
            locale: 'en',
            timezone: 'UTC',
          });
          await this.credentials.setPassword(scope.identity, userId, passwordHash);
          const tenant = scope.tenant(context);
          await this.requireInviterStillMayGrant(tenant, context, invitation);
          // The account was created a moment ago in this transaction: it holds no client row.
          return this.grantWithin(tenant, context, invitation.id, userId, {
            existingAccount: false,
          });
        },
      );
      return { ...granted, userId };
    } catch (error) {
      if (error instanceof InviteeAccountExistsError) {
        throw new ApiError(
          409,
          'conflict',
          ACCOUNT_EXISTS_MESSAGE,
          [{ field: 'email', message: 'account_exists' }],
          'invitation_registration_account_exists',
        );
      }
      throw alreadyMemberOr(error);
    }
  }

  /**
   * The grant itself, inside the caller's transaction: mark the invitation accepted, create the
   * membership it names, and record both. Shared by `accept` (an existing account) and
   * `register` (an account created in the same transaction).
   */
  private async grantWithin(
    tx: TenantQueryRunner,
    context: TenantContext,
    invitationId: string,
    userId: string,
    account: { readonly existingAccount: boolean },
  ): Promise<AcceptedInvitationView> {
    // Marked accepted *first*. The `status = 'pending'` predicate is what makes the token
    // single-use, so two requests racing with one token both reach here and exactly one
    // proceeds — rather than both creating a membership and one failing on a unique key
    // afterwards, which would leave the invitation accepted twice in the log.
    const accepted = await this.invitations.markAccepted(tx, context, invitationId, userId);

    // F27a: a staff account never also becomes a client user of the same tenant. The refusal
    // throws inside the caller's transaction, so the acceptance above is rolled back with it.
    if (accepted.clientOrganizationId !== null) {
      await this.requireNoInternalMembership(tx, context, userId);
    }

    if (accepted.clientOrganizationId === null) {
      const created = await this.memberships.invite(tx, context, {
        userId,
        role: accepted.role as Parameters<MembershipsRepository['invite']>[2]['role'],
      });
      // `invited → active`: the row records both states, because the invitation *was* the
      // invited state and the acceptance is what makes it active. Writing `active` directly
      // would lose the transition the membership machine exists to describe.
      const active = await this.memberships.transitionStatus(
        tx,
        context,
        created.id,
        created.version,
        'active',
      );
      if (account.existingAccount) {
        await this.endClientRowsOfNewStaff(tx, context, userId, accepted.id);
      }

      // A1: the "Add to projects" choice lands now, not at issue — only an accepted invitation
      // makes anyone a project member. A project archived since issue is skipped.
      const projectIds = await this.invitations.projectIdsFor(tx, context, accepted.id);
      const joined = await this.invitations.addProjectMemberships(
        tx,
        context,
        userId,
        projectIds,
        projectRoleForInvitation(accepted.role),
      );

      await this.audit?.record(tx, context, {
        action: 'invitation.accepted',
        objectId: accepted.id,
        result: 'allowed',
        metadata: {
          role: accepted.role,
          destination: 'organization',
          ...(joined > 0 ? { project_count: String(joined) } : {}),
        },
      });

      return {
        organizationId: accepted.organizationId,
        membershipId: active.id,
        clientOrganizationId: null,
        role: active.role,
      };
    }

    const created = await this.clientMemberships.invite(tx, context, {
      clientOrganizationId: accepted.clientOrganizationId,
      userId,
      role: accepted.role as Parameters<ClientMembershipsRepository['invite']>[2]['role'],
      expiresAt: null,
    });
    const active = await this.clientMemberships.transitionStatus(
      tx,
      context,
      created.id,
      created.updatedAt,
      'active',
    );

    await this.audit?.record(tx, context, {
      action: 'invitation.accepted',
      objectId: accepted.id,
      result: 'allowed',
      metadata: {
        role: accepted.role,
        destination: 'client_organization',
        client_organization_id: accepted.clientOrganizationId,
      },
    });

    return {
      organizationId: accepted.organizationId,
      membershipId: active.id,
      clientOrganizationId: active.clientOrganizationId,
      role: active.role,
    };
  }

  /**
   * Preview an invitation from its token.
   *
   * **Public**, because the link arrives by email and the recipient may not have signed in yet —
   * §3's "account-switch option" assumes exactly that. What gates this is the 256-bit token,
   * which is not enumerable; what it discloses is what the invitation was always going to tell
   * the person it was sent to.
   *
   * The refusal is the same 404 the acceptance path gives, for the same reason and with the same
   * message. A preview that distinguished "revoked" from "never existed" would become the oracle
   * `accept` deliberately is not.
   */
  async preview(token: string, correlationId: string): Promise<InvitationPreviewView> {
    if (!looksLikeInvitationToken(token)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'invitation_malformed');
    }

    const row = await this.database.bootstrapRead(
      {
        correlationId,
        reason:
          'reading the invitation a token names so the person holding it can see who invited ' +
          'them and to what, before accepting; they have no membership, so no tenant context ' +
          'can exist to scope this read',
        tables: ['invitations', 'organizations', 'client_organizations'],
      },
      (runner) => this.invitations.previewByTokenHash(runner, hashInvitationToken(token)),
    );

    if (!row) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'invitation_not_pending');
    }

    const account = await this.database.identityRead(
      { correlationId, tables: ['users'] },
      (runner) => this.credentials.findUserIdByEmail(runner, row.inviteeEmail),
    );

    return {
      organizationName: row.organizationName,
      inviterName: row.inviterName,
      inviterEmail: row.inviterEmail,
      role: row.role,
      audience: row.clientOrganizationName === null ? 'internal' : 'client',
      clientOrganizationName: row.clientOrganizationName,
      invitedAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      inviteeEmail: row.inviteeEmail,
      hasAccount: account !== null,
      note: row.note ?? null,
    };
  }

  /**
   * Move this tenant's overdue pending invitations to `expired`.
   *
   * Bookkeeping, not enforcement: an overdue invitation is already unusable because
   * `findPendingByTokenHash` compares `expires_at` in the database. This makes the listing say
   * so, and records the sweep — a tenant nobody has swept is not a tenant whose stale
   * invitations still work.
   */
  async expireOverdue(context: TenantContext, principal: Principal): Promise<number> {
    this.requireInviteCapability(principal, context, 'invitation.expire');

    return this.database.transaction(context, async (tx) => {
      const moved = await this.invitations.expireOverdue(tx, context);
      if (moved > 0) {
        await this.audit?.record(tx, context, {
          action: 'invitation.expired',
          objectId: context.organizationId,
          result: 'allowed',
          metadata: { count: String(moved) },
        });
      }
      return moved;
    });
  }

  // ── The parts every method above leans on ─────────────────────────────────

  /**
   * The names the invitation email interpolates, read inside the issuing transaction —
   * and only when a transport exists to use them. `null` when nothing is wired at all
   * (the database suites' default), so that deployment pays no join for a mail nobody
   * composes. The console driver *is* a transport for this purpose: printing the composed
   * mail is its whole job, so it pays the join to have names to print.
   */
  private async mailFactsFor(
    tx: Parameters<InvitationsRepository['mailFactsById']>[0],
    context: TenantContext,
    invitationId: string,
  ): Promise<InvitationMailFactsRow | null> {
    if (!this.invitationMail?.enabled) return null;
    return (await this.invitations.mailFactsById(tx, context, invitationId)) ?? null;
  }

  /**
   * Send the invitation email and record what happened, after the row is committed.
   *
   * After, deliberately: a mail host being down must not roll back an invitation, and a
   * mail sent from inside the transaction would announce a row a later rollback could
   * erase. The audit row goes in its own transaction for the same reason — it records the
   * delivery attempt, which is a fact even when the invitation's transaction is long over.
   */
  private async deliverInvitationEmail(
    context: TenantContext,
    row: InvitationRow,
    facts: InvitationMailFactsRow | null,
    token: string,
  ): Promise<InvitationDelivery> {
    const mail = this.invitationMail;
    if (!mail?.enabled) return 'none';

    let delivery: InvitationDelivery;
    if (facts === null) {
      // Unreachable while `mailFactsFor` reads the row this transaction created; kept so a
      // broken join ever after is a failed mail in the trail rather than a 500.
      console.error('[mailer] invitation email skipped: no names to compose with');
      delivery = 'failed';
    } else {
      delivery = await mail.deliver({
        to: row.email,
        clientOrganizationName: facts.clientOrganizationName,
        organizationName: facts.organizationName,
        inviterName: facts.inviterName,
        inviterEmail: facts.inviterEmail,
        locale: facts.organizationLocale,
        role: row.role,
        expiresAt: row.expiresAt,
        token,
      });
    }

    // `'none'` writes no audit row: nothing was attempted, so there is nothing to record —
    // and under the console driver, where `'none'` is every invitation's answer, a row per
    // healthy invitation reading `result: 'error'` would be the trail crying wolf.
    const audit = this.audit;
    if (audit && delivery !== 'none') {
      try {
        await this.database.transaction(context, (tx) =>
          audit.record(tx, context, {
            action: 'invitation.emailed',
            objectId: row.id,
            result: delivery === 'sent' ? 'allowed' : 'error',
            metadata: {
              delivery,
              // The kind, never the address — `invitation.issued`'s rule.
              destination:
                row.clientOrganizationId === null ? 'organization' : 'client_organization',
            },
          }),
        );
      } catch (error) {
        // Swallowed loudly, the `recordDenial` precedent: the invitation is committed and
        // the mail may already be in somebody's inbox. A 500 here would lose the response's
        // one-time token — the issuer's only copy of a link that is now live — to punish
        // them for a bookkeeping failure that was not theirs.
        // The write is a database error that can carry the DSN, so it is redacted through the
        // OBS-001 seam rather than printed raw.
        console.error('[mailer] failed to record invitation.emailed', serializeForLog(error));
      }
    }

    return delivery;
  }

  /** NV04: the operator addresses, from the options or the same environment variable. */
  private platformAdminEmails(): readonly string[] {
    return (
      this.options.platformAdminEmails ??
      parsePlatformAdminEmails(process.env['PLATFORM_ADMIN_EMAILS'])
    );
  }

  /**
   * NV04: an invitation must never become the way an unclaimed platform-operator address gets
   * its first account. An operator address that already has an account is an ordinary invitee
   * (they sign in to accept); one with no account is refused with a neutral 422, before any write.
   */
  private async requireNotUnclaimedPlatformAdmin(
    context: TenantContext,
    email: string,
  ): Promise<void> {
    if (!this.platformAdminEmails().includes(email)) return;
    const account = await this.database.identityRead(
      { correlationId: context.correlationId, tables: ['users'] },
      (runner) => this.credentials.findUserIdByEmail(runner, email),
    );
    if (account !== null) return;
    throw new ApiError(
      422,
      'validation_failed',
      INVITE_ADDRESS_REFUSED_MESSAGE,
      [{ field: 'email', message: 'address_not_invitable' }],
      'invitation.platform_admin_unclaimed',
    );
  }

  /**
   * F52b: the organization's access policy, enforced where an invitation is made. A non-empty
   * `invite_domain_allowlist` limits internal invitations to those domains, and
   * `guest_access_enabled: false` (the default) refuses the `guest` role. Client invitations
   * reach a client company's people, whose domains the agency does not choose, so the domain
   * list does not apply to them. 422 with a machine key the screen translates; no write.
   */
  private async requireInvitePolicy(
    tx: TenantQueryRunner,
    context: TenantContext,
    email: string,
    role: string,
    clientOrganizationId: string | null,
  ): Promise<void> {
    if (clientOrganizationId !== null) return;
    const stored = await this.policies.find(tx, context);
    const policy = normalizePolicy(stored?.policyJson);
    const allowlist = policy.invite_domain_allowlist.map((domain) => domain.toLowerCase());
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
    if (allowlist.length > 0 && !allowlist.includes(domain)) {
      throw new ApiError(
        422,
        'validation_failed',
        INVITE_DOMAIN_MESSAGE,
        [{ field: 'email', message: 'invite_domain_not_allowed' }],
        'invitation.policy:invite_domain_not_allowed',
      );
    }
    if (role === 'guest' && !policy.guest_access_enabled) {
      throw new ApiError(
        422,
        'validation_failed',
        GUEST_ACCESS_OFF_MESSAGE,
        [{ field: 'role', message: 'guest_access_disabled' }],
        'invitation.policy:guest_access_disabled',
      );
    }
  }

  /**
   * F36b: an organization issues at most `issueLimitPerHour` invitations (re-issues included)
   * per rolling hour. Counted from the table, so the ceiling holds across processes and
   * restarts; 429 with no write.
   */
  private async requireUnderIssueLimit(
    tx: TenantQueryRunner,
    context: TenantContext,
    clientOrganizationId: string | null,
  ): Promise<void> {
    // N05: internal invitations and each client organization's are separate buckets.
    const limit =
      clientOrganizationId === null
        ? (this.options.issueLimitPerHour ?? INVITATION_ISSUE_LIMIT_PER_HOUR)
        : (this.options.clientIssueLimitPerHour ?? INVITATION_CLIENT_ISSUE_LIMIT_PER_HOUR);
    const recent = await this.invitations.countIssuedInLastHour(tx, context, {
      clientOrganizationId,
    });
    if (recent >= limit) {
      throw new ApiError(
        429,
        'rate_limited',
        INVITE_RATE_MESSAGE,
        undefined,
        'invitation.issue_rate_limited',
      );
    }
  }

  /**
   * F06 defence in depth: at acceptance the inviter must **still** be allowed to grant what the
   * invitation grants — an active member holding `org.manage` whose authority covers the role
   * (owner for owner; owner/org_admin for anything; otherwise the capability subset), or, for
   * a client invitation, an active client admin of that client organization. Anything else is
   * the one 404 every unusable invitation gets.
   */
  private async requireInviterStillMayGrant(
    tx: TenantQueryRunner,
    context: TenantContext,
    invitation: InvitationRow,
  ): Promise<void> {
    const refusal = new ApiError(
      404,
      'not_found',
      MESSAGES.notFound,
      undefined,
      'invitation_inviter_revoked',
    );
    const inviter = await this.memberships.findByUserId(tx, context, invitation.invitedByUserId);
    if (inviter?.status === 'active') {
      const held = await capabilitiesOfStoredRole(tx, context, inviter.role, this.customRoles);
      if (held.has('org.manage')) {
        if (invitation.role === 'owner') {
          if (inviter.role === 'owner') return;
          throw refusal;
        }
        if (ROLE_ASSIGNERS.includes(inviter.role)) return;
        const granted = await this.capabilitiesOfInvitedRole(tx, context, invitation);
        if (!exceedsCaller(granted, held)) return;
        throw refusal;
      }
    }
    if (invitation.clientOrganizationId !== null) {
      const client = await this.clientMemberships.findByUser(
        tx,
        context,
        invitation.clientOrganizationId,
        invitation.invitedByUserId,
      );
      const live =
        client?.status === 'active' &&
        (client.expiresAt === null || client.expiresAt.getTime() > Date.now());
      if (client && live && hasCapability(client.role as ClientRole, 'client_member.manage'))
        return;
    }
    throw refusal;
  }

  /**
   * F27a: refuse a client invitation accepted by an account that holds an internal membership
   * here that has not ended (active, suspended or still invited; offboarded staff may become a
   * client user). Otherwise one account would be staff and client at once, and a suspended staff
   * member could regain a way in through the portal. 409 with a neutral message.
   */
  private async requireNoInternalMembership(
    tx: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<void> {
    const internal = await this.memberships.findByUserId(tx, context, userId);
    if (internal === null || internal.status === 'offboarded') return;
    throw new ApiError(
      409,
      'conflict',
      INVITE_INTERNAL_MEMBER_MESSAGE,
      [{ field: 'token', message: 'internal_member' }],
      'invitation_internal_member',
    );
  }

  /**
   * Wave 11 Q4 (M05): an existing account that becomes staff here gives up any client row it still
   * holds in this company, in the acceptance transaction, each with its own audit row. Otherwise
   * the older client row would outlive a later suspension of the staff membership and keep the
   * person in through the portal. `offboarded` is the state machine's terminal end, reachable from
   * every other state; re-admitting them as a client later is a new, separately audited row.
   */
  private async endClientRowsOfNewStaff(
    tx: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    invitationId: string,
  ): Promise<void> {
    const rows = await this.staffClientRows.openClientRowsOf(tx, context, userId);
    for (const row of rows) {
      const ended = await this.clientMemberships.transitionStatus(
        tx,
        context,
        row.id,
        row.updatedAt,
        'offboarded',
      );
      await this.audit?.record(tx, context, {
        action: 'client_membership.status_changed',
        objectId: ended.id,
        result: 'allowed',
        metadata: {
          client_organization_id: row.clientOrganizationId,
          status_before: row.status,
          status_after: ended.status,
          invitation_id: invitationId,
          cause: 'internal_invitation_accepted',
        },
      });
    }
  }

  /** What an invitation's role grants: a built-in ceiling or the custom role's row. */
  private async capabilitiesOfInvitedRole(
    tx: TenantQueryRunner,
    context: TenantContext,
    invitation: InvitationRow,
  ): Promise<ReadonlySet<Capability>> {
    if (isCustomRoleCandidate(invitation.role, invitation.clientOrganizationId)) {
      const row = await this.customRoles.findRoleById(tx, context, invitation.role);
      return new Set(row ? parseCustomRoleCapabilities(row.capabilitiesJson) : []);
    }
    return capabilitiesOfStoredRole(tx, context, invitation.role, this.customRoles);
  }

  private expiryFrom(now: Date): Date {
    const expiry = new Date(now.getTime());
    expiry.setUTCDate(expiry.getUTCDate() + (this.options.ttlDays ?? DEFAULT_TTL_DAYS));
    return expiry;
  }

  /**
   * F1: an internal invitation may carry a **custom role** id from Control > Roles. It must be a
   * role of this organization (a foreign or unknown id is the same 400 as an unknown role name),
   * and every right it grants must be one the inviter could grant (`mayGrantCapability`, the
   * escalation guard Control > Roles and the bulk assign run): 403, no write.
   */
  private async requireGrantableCustomRole(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    roleId: string,
  ): Promise<void> {
    const custom = await this.customRoles.findRoleById(tx, context, roleId);
    if (!custom) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'role', message: 'must be an internal role' },
      ]);
    }
    for (const capability of customRoleCapabilities(custom.capabilitiesJson)) {
      if (!mayGrantCapability(principal, capability, context.organizationId).allowed) {
        throw new ApiError(
          403,
          'forbidden',
          'You can only give a role whose rights you hold yourself.',
          undefined,
          'invitation.custom_role_escalation',
        );
      }
    }
  }

  /**
   * An internal invitation carries an internal role; a client invitation carries a client one.
   *
   * Checked here rather than left to the foreign keys, because there is no key that could
   * express it: `role` is `VARCHAR(64)` in both membership tables and the vocabulary lives in
   * `packages/domain`. An internal role on a client invitation would create a client
   * membership whose role no client ceiling contains — a principal the authorizer would refuse
   * everything, which is safe and is also a support ticket nobody can explain.
   */
  private requireRoleMatchesDestination(
    role: string,
    clientOrganizationId: string | null,
    action: string,
  ): void {
    // R23-b (56-28): a client destination also holds the client ceiling — 422 `client_ceiling`
    // when the role's capabilities reach past `CLIENT_CAPABILITY_ALLOWLIST`, before any write.
    if (clientOrganizationId !== null && isClientRole(role)) {
      assertClientRoleWithinCeiling(role, action, this.options.clientCeilingOf);
      return;
    }
    const ok = clientOrganizationId === null ? isInternalRole(role) : false;
    if (!ok) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        {
          field: 'role',
          message:
            clientOrganizationId === null
              ? 'must be an internal role'
              : 'must be a client role for a client invitation',
        },
      ]);
    }
  }

  private async writing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof InvitationNotFoundError) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      if (error instanceof InvitationAlreadyPendingError) throw invitationAlreadyPending();
      if (error instanceof InvitationNotPendingError) {
        // 409 rather than 404: this caller already knows the invitation exists — they listed
        // it — so nothing is leaked by saying it is no longer pending, and "it changed under
        // you" is the fact they need.
        throw new ApiError(409, 'conflict', 'That invitation is no longer pending', [
          { field: 'status', message: `is ${error.status}` },
        ]);
      }
      throw error;
    }
  }

  /**
   * Who may invite, and into what.
   *
   * Two paths, because `12-PERMISSION-MATRIX` §2's "Invite client users" row has two entries:
   * internal administrators get "Policy" and a Client Admin gets **"within own client
   * org/policy"**. CLIENT-002 is the ticket that made the second one reachable.
   *
   * | Caller | May invite into |
   * | --- | --- |
   * | Internal, `org.manage` | the organization, or any of its client organizations |
   * | Client admin, `client_member.manage` | **their own** client organization, and nothing else |
   *
   * The narrow path is the one worth reading carefully, because getting it wrong hands one
   * client the ability to put people inside another. Three things have to hold at once, and
   * the third is the one a capability check alone would miss:
   *
   * 1. The caller holds `client_member.manage` — every client role does not; only
   *    `client_admin` does.
   * 2. The invitation names a **client** organization. A client admin cannot issue an
   *    invitation into the agency itself, whatever role it carries.
   * 3. The client organization named is the caller's own. A different one is refused with
   *    **404**, not 403, so a client admin probing ids learns nothing about which exist.
   */
  private requireInviteCapability(
    principal: Principal,
    context: TenantContext,
    action: string,
    clientOrganizationId: string | null = null,
  ): void {
    if (principal.kind === 'client') {
      this.requireOwnClientOrganizationInvite(principal, context, action, clientOrganizationId);
      return;
    }

    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        // Null: an invitation is organization-level, not project-scoped.
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }
  }

  /** The client-admin half of the rule above. */
  private requireOwnClientOrganizationInvite(
    principal: Principal,
    context: TenantContext,
    action: string,
    clientOrganizationId: string | null,
  ): void {
    const verdict = authorize({
      principal,
      capability: 'client_member.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        // A client-facing resource. A synthetic `internal` one would refuse every client
        // principal before the scope rule ran — the trap `CapabilityGuard` documents, and the
        // one `ClientsService` was caught by on the first run of its own suite.
        audience: 'client_visible',
        clientOrganizationId: principal.clientOrganizationId,
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }

    // A client admin may not invite into the agency. `clientOrganizationId === null` is an
    // internal membership invitation, and no client role has any business issuing one.
    if (clientOrganizationId === null || clientOrganizationId !== principal.clientOrganizationId) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        `${action}:foreign_client`,
      );
    }
  }
}

/**
 * The context an acceptance runs under. Its membership id is created inside the transaction,
 * exactly as `ProvisioningService` does — see that file for why this is narrower than an
 * escape hatch rather than wider. `policyVersion` is a literal no resolved context produces.
 */
function acceptanceContext(
  invitation: InvitationRow,
  userId: string,
  correlationId: string,
): TenantContext {
  return createTenantContext({
    organizationId: invitation.organizationId,
    userId,
    membershipId: uuidv7(),
    principalKind: invitation.clientOrganizationId === null ? 'internal' : 'client',
    capabilities: [],
    policyVersion: 'invitation-acceptance',
    correlationId,
  });
}

/**
 * NV13: a bound token (personal access token or AI grant) invites only plain team, guest and
 * client seats. Owner, admin, manager, moderator and every custom role need a browser session.
 */
function requireSessionForPrivilegedInvite(
  context: TenantContext,
  role: string,
  action: string,
): void {
  if (context.actorChannel !== 'ai_assistant') return;
  if (BOUND_TOKEN_INVITE_ROLES.has(role)) return;
  throw new ApiError(
    403,
    'forbidden',
    PRIVILEGED_INVITE_MESSAGE,
    [{ field: 'role', message: 'session_required_for_privileged_invite' }],
    `${action}:session_required_for_privileged_invite`,
  );
}

/**
 * F05: "Add to projects" only within the inviter's own project authority. An owner or
 * organization admin reaches every project; anyone else (a delegated custom `org.manage` role)
 * must be allowed `project.member.manage` on **each** project, the same evaluator decision the
 * project's own member screen makes. 403 before any write, naming no project.
 */
function requireProjectAuthority(
  principal: Principal,
  context: TenantContext,
  projectIds: readonly string[],
  action: string,
): void {
  if (projectIds.length === 0 || isRoleAssigner(principal)) return;
  for (const projectId of projectIds) {
    const verdict = authorize({
      principal,
      capability: 'project.member.manage',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        [{ field: 'projectIds', message: 'project_not_manageable' }],
        `${action}:project_authority:${verdict.code}`,
      );
    }
  }
}

/**
 * ACC-04: the account accepting already holds the membership this invitation would create.
 * A 409 that says so, instead of the bare 500 the unique key produced. Anything else passes
 * through untouched.
 */
function alreadyMemberOr(error: unknown): unknown {
  if (
    isDuplicateKey(error, 'uq_memberships_org_user') ||
    isDuplicateKey(error, 'uq_client_memberships_identity')
  ) {
    return new ApiError(
      409,
      'conflict',
      ALREADY_MEMBER_MESSAGE,
      [{ field: 'token', message: 'already_member' }],
      'invitation_already_member',
    );
  }
  return error;
}

/** A custom role id is a UUID; a built-in role is a name. Only internal invitations carry one. */
const CUSTOM_ROLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isCustomRoleCandidate(role: string, clientOrganizationId: string | null): boolean {
  return clientOrganizationId === null && !isInternalRole(role) && CUSTOM_ROLE_ID.test(role);
}

/**
 * Only an owner may make someone an owner (CQ-06). The organization admin holds `org.manage` too
 * (ADM-03), which is what lets them invite; without this an admin could invite a second owner and
 * so hand out the one tier above their own. `12-PERMISSION-MATRIX` §5 lists role elevation and
 * ownership transfer among the highest-risk changes. Refused before any write.
 */
export function requireOwnerToGrantOwner(principal: Principal, role: string, action: string): void {
  if (role !== 'owner') return;
  if (principal.kind === 'internal' && principal.role === 'owner') return;
  throw new ApiError(
    403,
    'forbidden',
    'Only an owner can make someone an owner.',
    [{ field: 'role', message: 'Choose a role other than Owner.' }],
    `${action}:owner_only`,
  );
}
