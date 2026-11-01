import { capabilitiesFor, isInternalRole, uuidv7 } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { MembershipsRepository } from './memberships.repository.js';
import { OrganizationsRepository, OrganizationSlugTakenError } from './organizations.repository.js';
import { OrgSettingsRepository } from './org-settings.repository.js';
import { WorkspacesRepository } from './workspaces.repository.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * Provisioning — the half of TEN-001 that was recorded as "not implemented" from the day the
 * ticket landed, and the one thing standing between a person signing in and arriving anywhere.
 *
 * `22-SCREEN-BY-SCREEN` §3, `ON-01`: "Fields: organization name, timezone, default locale,
 * work type. Primary: Create organization. **Result is transactional owner membership.**"
 *
 * ## The bootstrapping problem, and why it turned out not to need a hole in the guard
 *
 * The gap note in `docs/implementation-status.md` read:
 *
 * > Provisioning happens before any membership exists, so it cannot run under a
 * > `TenantContext`, and the bootstrap path is read-only by construction.
 *
 * The first clause is true. The second does not follow, and this service is the demonstration.
 *
 * A `TenantContext` is not a permission the database grants — it is a **declaration of which
 * organization every statement on this connection is allowed to touch**, which the tenant
 * guard then enforces. Nothing about that requires the organization to already exist. So this
 * service generates the organization's id and the founding membership's id *first*, builds a
 * context from them, and runs the whole transaction inside it.
 *
 * The result is narrower than any other write path in the system rather than wider:
 *
 *   * Every statement is anchored to an organization id that **nothing else in the database
 *     references yet**, so even a statement with a forgotten predicate could not reach another
 *     tenant's rows — there are no other rows with that key.
 *   * `OrganizationsRepository.create` and `MembershipsRepository.createFounder` both refuse
 *     an id that is not the one their context names, so the two ids cannot drift apart.
 *   * `bootstrapRead` — the actual hole in the guard — is not used here at all.
 *
 * ## What the context claims, and why each claim is honest
 *
 * | Field | Value | Why it is true rather than convenient |
 * | --- | --- | --- |
 * | `organizationId` | the id being created | Every statement is scoped to it |
 * | `userId` | from the verified session | The controller has no other source |
 * | `membershipId` | the founder membership being created | It is created in this transaction |
 * | `role` capabilities | `capabilitiesFor('owner')` | The row written says `owner`, so this is what it will resolve to on the next request |
 * | `policyVersion` | `provisioning` | Stated below |
 *
 * `policyVersion` is the one field that cannot be derived, because the derivation reads the
 * `updated_at` of rows this transaction has not written yet. It is the literal string
 * `provisioning`, which is a value no resolved context can ever produce — `PrincipalRepository`
 * builds it from two timestamps. A cache keyed on it therefore cannot collide with a real
 * context's entry, and the next request re-resolves normally.
 *
 * ## What this service does not do
 *
 * It does not check a capability. There is no organization to hold one in, and any
 * authenticated person may create an organization — that is what signup is. What it does
 * require is a **verified session**, and that is the controller's job, not this one's.
 *
 * ## The first-owner caller
 *
 * `provisionFounderWithin` is the one exception to "from the verified session": the first-owner
 * setup route has no session, because no user exists yet. Its `userId` is the user that route
 * has just created in the same transaction, under the setup lock, so the organization, the
 * user and the owner membership commit together or not at all. The audit row carries
 * `origin: 'first_owner_setup'` so a setup-created organization is distinguishable from ON-01.
 */

/** The role the founder gets. `12-PERMISSION-MATRIX` §1's most privileged internal role. */
const FOUNDER_ROLE = 'owner';

/**
 * The workspace every new organization gets.
 *
 * `07-DATA-MODEL` puts projects inside workspaces, so an organization with no workspace is an
 * organization in which no project can be created — a dead end reachable from the very first
 * screen. `ON-01` does not ask for a workspace name, so one is created with the organization's
 * own name, and renaming it is an ordinary update.
 */
function defaultWorkspaceName(organizationName: string): string {
  return organizationName;
}

export interface ProvisionOrganizationInput {
  /** From the verified session. Never from the request body. */
  readonly userId: string;
  readonly slug: string;
  readonly name: string;
  readonly defaultLocale: string;
  readonly timezone: string;
  /** ON-02's working week, stored as `org_settings.working_week` in the same transaction. */
  readonly workingWeek?: string;
  /** ON-01's starting template, stored as `org_settings.operating_template`. */
  readonly operatingTemplate?: string;
  readonly correlationId: string;
}

export interface ProvisionedOrganization {
  readonly organizationId: string;
  readonly slug: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly membershipId: string;
  readonly role: string;
}

/**
 * The wire body `POST /v1/organizations` returns — `ON-01`'s created organization, as the
 * browser reads it (`apps/web/src/lib/api/organizations.ts CreatedOrganization`).
 *
 * Distinct from {@link ProvisionedOrganization}, the service's own result: the wire renames
 * `organizationId` → `id` and drops `membershipId`, which no screen reads. The controller
 * already builds exactly these five fields; naming the shape here lets `contracts:check` pair
 * it with the web declaration and lives beside its sibling {@link OrganizationSummaryView}
 * because `v1/organizations` has no dedicated service — the routes are the tenancy surface.
 */
export interface CreatedOrganizationView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly role: string;
}

/**
 * One row of the wire body `GET /v1/organizations` returns — `ID-04`'s directory entry, as the
 * browser reads it (`apps/web/src/lib/api/organizations.ts OrganizationSummary`).
 *
 * The rows come from {@link OrganizationDirectoryRepository.listForUser} as
 * `OrganizationMembershipSummary` (which names the id `organizationId`); the controller maps
 * that to `id` and returns exactly these six fields. Co-located here for the same reason as
 * {@link CreatedOrganizationView}: the organization routes have no read service of their own,
 * and `contracts:check` enumerates response views under `*.service.ts`.
 */
export interface OrganizationSummaryView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly audience: 'internal' | 'client';
  readonly role: string;
  /** H1: a custom role's own name, present only when `role` is a custom role id. */
  readonly roleName?: string;
  /**
   * H1: the capabilities the custom role holds, present only when `role` is a custom role id, so
   * the browser can show a custom-role member the Control pages their role opens. A display hint;
   * the API still authorizes every request on its own.
   */
  readonly capabilities?: readonly string[];
  readonly clientOrganizationName: string | null;
  /** 0206. True when the platform operator suspended it; its members see the suspended page. */
  readonly suspended?: boolean;
}

export { OrganizationSlugTakenError };

export class ProvisioningService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly audit: AuditService,
    private readonly organizations: OrganizationsRepository = new OrganizationsRepository(),
    private readonly workspaces: WorkspacesRepository = new WorkspacesRepository(),
    private readonly memberships: MembershipsRepository = new MembershipsRepository(),
    private readonly settings: OrgSettingsRepository = new OrgSettingsRepository(),
  ) {}

  /**
   * Create an organization, its first workspace, and the founder's owner membership.
   *
   * One transaction, and that is the requirement rather than a nicety. An organization with no
   * membership is an organization nobody can administer, reach, or delete — it holds a slug
   * forever and is invisible to every screen, because every screen reaches organizations
   * through memberships. A failure halfway through must leave nothing behind.
   *
   * The audit row joins the same transaction, which is what `AuditService` was built for: a
   * record of a creation that did not commit would be a lie, and a creation with no record
   * would be the gap AUD-001 closed for project memberships.
   */
  async provisionOrganization(input: ProvisionOrganizationInput): Promise<ProvisionedOrganization> {
    const organizationId = uuidv7();
    const membershipId = uuidv7();
    const context = this.contextFor({
      organizationId,
      membershipId,
      userId: input.userId,
      correlationId: input.correlationId,
    });

    return this.database.transaction(context, async (tx) =>
      this.provisionSteps(tx, context, input),
    );
  }

  /**
   * The same provisioning, inside a transaction the caller already owns.
   *
   * For first-owner setup: the caller has opened one transaction (holding the "no owner exists
   * yet" lock) and created the user in it, so the organization must join that transaction
   * rather than open a second one that could commit without the user, or after another setup
   * request won the race. `runnerFor` hands out the caller's connection under the context
   * built here; `database.transaction` is never called.
   */
  async provisionFounderWithin(
    runnerFor: (context: TenantContext) => TenantQueryRunner,
    input: ProvisionOrganizationInput & { readonly origin?: 'first_owner_setup' | 'public_signup' },
  ): Promise<ProvisionedOrganization> {
    const context = this.contextFor({
      organizationId: uuidv7(),
      membershipId: uuidv7(),
      userId: input.userId,
      correlationId: input.correlationId,
    });

    return this.provisionSteps(runnerFor(context), context, input);
  }

  /** The one code path both entry points run: organization, workspace, founder, audit row. */
  private async provisionSteps(
    tx: TenantQueryRunner,
    context: TenantContext,
    input: ProvisionOrganizationInput & { readonly origin?: 'first_owner_setup' | 'public_signup' },
  ): Promise<ProvisionedOrganization> {
    const organization = await this.organizations.create(tx, context, {
      id: context.organizationId,
      slug: input.slug,
      name: input.name,
      defaultLocale: input.defaultLocale,
      timezone: input.timezone,
    });

    const workspace = await this.workspaces.create(tx, context, {
      name: defaultWorkspaceName(organization.name),
    });

    const membership = await this.memberships.createFounder(tx, context, {
      id: context.membershipId,
      userId: input.userId,
      role: FOUNDER_ROLE,
    });

    // The onboarding choices join the same transaction: an organization created without the
    // working week the person picked would silently schedule against Monday–Friday.
    // `default_timezone` is the setting Control Center and every schedule read; the
    // organization row's own `timezone` column alone left it at the UTC default, so the zone
    // chosen on ON-01 silently vanished (live test 2026-10-31).
    const initialSettings = [
      ['default_timezone', input.timezone],
      ['working_week', input.workingWeek],
      ['operating_template', input.operatingTemplate],
    ] as const;
    for (const [key, value] of initialSettings) {
      if (value !== undefined) {
        await this.settings.upsert(tx, context, { key, value, updatedBy: input.userId });
      }
    }

    // Same transaction, same reason AUD-001 gives: the record must not outlive a change
    // that rolled back, and the change must not outlive a missing record.
    await this.audit.record(tx, context, {
      action: 'organization.provisioned',
      objectId: organization.id,
      result: 'allowed',
      // snake_case keys. `isSafeAuditMetadata` enforces it, and the reason is that
      // `audit_events.metadata_json` is queried with JSON path expressions written by hand
      // — two spellings of one key make a query that silently misses half the rows.
      metadata: {
        slug: organization.slug,
        workspace_id: workspace.id,
        membership_id: membership.id,
        role: membership.role,
        ...(input.origin === undefined ? {} : { origin: input.origin }),
      },
    });

    return {
      organizationId: organization.id,
      slug: organization.slug,
      name: organization.name,
      workspaceId: workspace.id,
      membershipId: membership.id,
      role: membership.role,
    };
  }

  /**
   * The context an organization that does not exist yet is created under.
   *
   * Private, and it stays private. This is the only legitimate construction of a context for
   * a non-existent organization, and a second caller would almost certainly be a mistake — a
   * context is otherwise always the output of `MembershipResolver`, which reads a real row.
   */
  private contextFor(input: {
    organizationId: string;
    membershipId: string;
    userId: string;
    correlationId: string;
  }): TenantContext {
    if (!isInternalRole(FOUNDER_ROLE)) {
      // Unreachable while `FOUNDER_ROLE` is a literal, and cheap insurance if it ever becomes
      // configurable: a client role here would create an organization whose only member
      // cannot administer it.
      throw new Error(`${FOUNDER_ROLE} is not an internal role`);
    }

    return createTenantContext({
      organizationId: input.organizationId,
      userId: input.userId,
      principalKind: 'internal',
      membershipId: input.membershipId,
      capabilities: capabilitiesFor(FOUNDER_ROLE) as readonly Capability[],
      // See the note at the top of this file. A literal that no resolved context can produce.
      policyVersion: 'provisioning',
      correlationId: input.correlationId,
    });
  }
}
