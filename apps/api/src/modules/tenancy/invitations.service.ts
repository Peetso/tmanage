import { authorize, isClientRole, isInternalRole, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { createTenantContext } from '../../common/database/tenant-context.js';
import { serializeForLog } from '../../common/observability/logger.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import { ClientMembershipsRepository } from '../clients/client-memberships.repository.js';
import { MembershipsRepository } from './memberships.repository.js';
import {
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

/** `22-SCREEN-BY-SCREEN` §3 ON-06 sends a link; the link is useless after this long. */
const DEFAULT_TTL_DAYS = 14;

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

export interface IssuedInvitation {
  readonly invitation: InvitationView;
  /**
   * Shown once, to the issuer. `22-SCREEN-BY-SCREEN` §3 ON-06 builds the link from it.
   *
   * Returned from this call and never again: the row holds only a hash, so there is nothing
   * for a later "resend the same link" endpoint to read even if somebody wrote one.
   *
   * Returned **whatever `delivery` says**: the printed link is the bootstrap fallback, and
   * an email that was sent does not make the issuer's own copy of the link less theirs.
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
export interface InvitationPreview {
  readonly organizationName: string;
  readonly inviterName: string;
  readonly inviterEmail: string;
  readonly role: string;
  readonly audience: 'internal' | 'client';
  /** The client organization's name, when this is portal access rather than team membership. */
  readonly clientOrganizationName: string | null;
  readonly invitedAt: string;
  readonly expiresAt: string;
}

export interface AcceptedInvitation {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly clientOrganizationId: string | null;
  readonly role: string;
}

export interface InvitationsServiceOptions {
  readonly ttlDays?: number;
}

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
    },
    now: Date = new Date(),
  ): Promise<IssuedInvitation> {
    const clientOrganizationId = input.clientOrganizationId ?? null;
    this.requireInviteCapability(principal, context, 'invitation.issue', clientOrganizationId);

    const email = input.email.trim().toLowerCase();
    this.requireRoleMatchesDestination(input.role, clientOrganizationId);

    const { token, tokenHash } = issueInvitationToken();
    const expiresAt = this.expiryFrom(now);

    const { row, mailFacts } = await this.database.transaction(context, async (tx) => {
      const existing = await this.invitations.findPendingForEmail(
        tx,
        context,
        email,
        clientOrganizationId,
      );
      if (existing.length > 0) {
        throw new ApiError(409, 'conflict', 'That address already has a pending invitation', [
          { field: 'email', message: 'already invited; revoke the existing invitation first' },
        ]);
      }

      const issued = await this.invitations.issue(tx, context, {
        email,
        role: input.role,
        clientOrganizationId,
        tokenHash,
        expiresAt,
        invitedByUserId: context.userId,
      });

      await this.audit?.record(tx, context, {
        action: 'invitation.issued',
        objectId: issued.id,
        result: 'allowed',
        metadata: {
          role: issued.role,
          // Which kind of invitation, never the address. An email is personal data and §12's
          // metadata rule is identifiers and classifications — see `isSafeAuditMetadata`.
          destination: clientOrganizationId === null ? 'organization' : 'client_organization',
          ...(clientOrganizationId === null
            ? {}
            : { client_organization_id: clientOrganizationId }),
        },
      });

      return { row: issued, mailFacts: await this.mailFactsFor(tx, context, issued.id) };
    });

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
  ): Promise<IssuedInvitation> {
    this.requireInviteCapability(principal, context, 'invitation.reissue');

    const { token, tokenHash } = issueInvitationToken();
    const expiresAt = this.expiryFrom(now);

    const { row, mailFacts } = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const previous = await this.invitations.requireById(tx, context, invitationId);
        const role = input.role ?? previous.role;
        this.requireRoleMatchesDestination(role, previous.clientOrganizationId);

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
        });
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
  async accept(token: string, userId: string, correlationId: string): Promise<AcceptedInvitation> {
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

    // The context this transaction runs under. Its membership id is created inside it, exactly
    // as `ProvisioningService` does — see that file for why this is narrower than an escape
    // hatch rather than wider.
    const membershipId = uuidv7();
    const context = createTenantContext({
      organizationId: invitation.organizationId,
      userId,
      membershipId,
      principalKind: invitation.clientOrganizationId === null ? 'internal' : 'client',
      capabilities: [],
      policyVersion: 'invitation-acceptance',
      correlationId,
    });

    return this.database.transaction(context, async (tx) => {
      // Marked accepted *first*. The `status = 'pending'` predicate is what makes the token
      // single-use, so two requests racing with one token both reach here and exactly one
      // proceeds — rather than both creating a membership and one failing on a unique key
      // afterwards, which would leave the invitation accepted twice in the log.
      const accepted = await this.invitations.markAccepted(tx, context, invitation.id, userId);

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

        await this.audit?.record(tx, context, {
          action: 'invitation.accepted',
          objectId: accepted.id,
          result: 'allowed',
          metadata: { role: accepted.role, destination: 'organization' },
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
    });
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
  async preview(token: string, correlationId: string): Promise<InvitationPreview> {
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

    return {
      organizationName: row.organizationName,
      inviterName: row.inviterName,
      inviterEmail: row.inviterEmail,
      role: row.role,
      audience: row.clientOrganizationName === null ? 'internal' : 'client',
      clientOrganizationName: row.clientOrganizationName,
      invitedAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
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

  private expiryFrom(now: Date): Date {
    const expiry = new Date(now.getTime());
    expiry.setUTCDate(expiry.getUTCDate() + (this.options.ttlDays ?? DEFAULT_TTL_DAYS));
    return expiry;
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
  private requireRoleMatchesDestination(role: string, clientOrganizationId: string | null): void {
    const ok = clientOrganizationId === null ? isInternalRole(role) : isClientRole(role);
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
