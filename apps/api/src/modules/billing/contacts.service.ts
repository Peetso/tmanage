import { and, asc, eq, sql } from 'drizzle-orm';
import { authorize, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { billingContacts } from '../../common/database/schema.js';
import type { BillingContactRow } from '../../common/database/schema.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * Billing contacts — Billing module 19 (x199). The service half: list the organization's billing
 * contacts, add one, and remove one. The controller (`contacts.controller.ts`) is thin; this file
 * owns the authorization, validation and the tenant-scoped data access.
 *
 * ## Resolve the target, tenant-scoped, BEFORE authorizing or writing
 *
 * `DELETE` names a `contactId` in its path. It is read first, scoped to the acting tenant: a contact
 * from another studio simply does not resolve, and the answer is the same **404** an absent id gives —
 * with **no write**. Only once the row is in hand does the service authorize `org.manage`. That order
 * is the trap this slice was briefed on: a cross-tenant target is a 404 with no delete, never a
 * neighbour's contact removed.
 *
 * `POST` names no cross-tenant target — the only organization it can write into is
 * `context.organizationId`, which `TenantContextGuard` resolved from an active membership before this
 * code runs — so it authorizes `org.manage` and validates the body before the single insert. Enforcing
 * the capability and the tenant scope before any write is the whole security shape of this slice.
 *
 * ## `org.manage` is the one gate
 *
 * Contact management is an organization-settings action, so every route is behind `org.manage` — the
 * route guard asks the coarse question (UX/defence), and this service authorizes it again as the
 * authoritative decision (`25-AUTH-AND-TENANT-ISOLATION` §3: route guards are UX only, the API
 * authorizes every action). Reusing `org.manage` — no `capabilities.ts` edit — scopes this to owners.
 *
 * ## No payment instruments, no delivery
 *
 * `04-SECURITY-PRIVACY` §4: a billing contact is a name, an email and an optional role — never a card
 * or bank number. {@link rejectPanShaped} refuses any field whose value looks like a card/PAN with a
 * 400 and no write. And no email is sent to a contact: delivery is Needs-Peter, so the row is the
 * whole effect.
 */

/**
 * What a caller is allowed to see of one billing contact — paired Exact with the web's
 * `BillingContactView` in `e2e/contracts/api-web-shapes.ts`. `organizationId` is deliberately absent:
 * the wire projection never echoes the tenant id.
 */
export interface BillingContactView {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string | null;
  readonly createdAt: string;
}

/** The fields an add sends, once validated and normalised. */
export interface BillingContactInput {
  readonly name: string;
  readonly email: string;
  readonly role: string | null;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
export function toView(row: BillingContactRow): BillingContactView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The bounds each field is held to (`billing_contacts` column widths and RFC 5321 for the email). */
const MAX_NAME_LENGTH = 190;
const MAX_EMAIL_LENGTH = 254;
const MAX_ROLE_LENGTH = 80;

/** A pragmatic email shape — one `@`, a non-empty local part, and a dotted domain. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The largest contact list a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_CONTACTS_PAGE = 500;

type Detail = { field: string; message: string };

/**
 * The tenant-scoped data access the service depends on. A seam, not a separate file: the real
 * implementation ({@link DrizzleBillingContactsStore}) is co-located below, and the unit test supplies
 * an in-memory fake so the resolve-then-authorize order, the cross-tenant 404 and the `org.manage`
 * gate are proved without MySQL (Peter's rule: no DB tests in-slice). Every method takes the
 * {@link TenantContext}; no `organizationId` is ever taken from a DTO.
 */
export interface BillingContactsStore {
  listAll(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly BillingContactRow[]>;
  findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    contactId: string,
  ): Promise<BillingContactRow | null>;
  insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: BillingContactInput,
  ): Promise<BillingContactRow>;
  remove(runner: TenantQueryRunner, context: TenantContext, contactId: string): Promise<void>;
}

export class BillingContactsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly store: BillingContactsStore = new DrizzleBillingContactsStore(),
  ) {}

  /** The tenant's billing contacts, oldest first. Behind `org.manage`. */
  async list(context: TenantContext, principal: Principal): Promise<readonly BillingContactView[]> {
    this.requireOrgManage(principal, context, 'billing_contact.list');
    const rows = await this.database.read(context, (runner) => this.store.listAll(runner, context));
    return rows.map(toView);
  }

  /**
   * Add a billing contact. Authorizes `org.manage` (403) and validates the body (400, no write)
   * before the single insert; a card/PAN-shaped value in any field is refused with no write.
   */
  async add(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<BillingContactView> {
    this.requireOrgManage(principal, context, 'billing_contact.add');
    const input = validateBody(body);

    const row = await this.database.transaction(context, (tx) =>
      this.store.insert(tx, context, input),
    );
    return toView(row);
  }

  /**
   * Remove a billing contact, tenant-scoped. Resolves the contact (**404**, no write) before it
   * authorizes (`org.manage`, 403). An absent or cross-tenant id is the same 404, so nothing is
   * deleted that the caller could not see.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    contactId: string,
  ): Promise<BillingContactView> {
    return this.database.transaction(context, async (tx) => {
      const contact = await this.store.findById(tx, context, contactId);
      if (!contact) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'contact_not_visible');
      }
      this.requireOrgManage(principal, context, 'billing_contact.remove');

      await this.store.remove(tx, context, contactId);
      return toView(contact);
    });
  }

  /** Authorize an org-scoped `org.manage` (projectId null), or throw 403. */
  private requireOrgManage(principal: Principal, context: TenantContext, action: string): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        // Null: an org-level resource (organization settings), no project relation to lean on.
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
}

/**
 * The real, tenant-scoped data access. Every read and write is bound to `organization_id` from the
 * context — a caller in the wrong tenant sees nothing rather than a leak — and the insert takes its
 * `organization_id` from the context, never from the input, so a request body cannot choose the tenant
 * it writes into. The composite `(organization_id, id)` key makes a cross-tenant id a non-existent row.
 */
export class DrizzleBillingContactsStore implements BillingContactsStore {
  async listAll(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly BillingContactRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(billingContacts)
      .where(eq(billingContacts.organizationId, context.organizationId))
      .orderBy(asc(billingContacts.createdAt), asc(billingContacts.id))
      .limit(MAX_CONTACTS_PAGE);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    contactId: string,
  ): Promise<BillingContactRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(billingContacts)
      .where(
        and(
          eq(billingContacts.organizationId, context.organizationId),
          eq(billingContacts.id, contactId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: BillingContactInput,
  ): Promise<BillingContactRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(billingContacts)
      .values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        name: input.name,
        email: input.email,
        role: input.role,
        createdAt: sql`current_timestamp(3)`,
      });
    const created = await this.findById(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('billing contact vanished immediately after insert');
    }
    return created;
  }

  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    contactId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(billingContacts)
      .where(
        and(
          eq(billingContacts.organizationId, context.organizationId),
          eq(billingContacts.id, contactId),
        ),
      );
  }
}

interface AddContactBody {
  readonly name?: unknown;
  readonly email?: unknown;
  readonly role?: unknown;
}

/**
 * Validate and bound the whole body, or throw a 400 that names every offending field at once. `name`
 * and `email` are required; `role` is optional (absent, null or empty clears it). The email must match
 * {@link EMAIL_PATTERN}. Returns the persisted-ready input only when nothing is wrong.
 */
function validateBody(raw: unknown): BillingContactInput {
  const body = (raw ?? {}) as AddContactBody;
  const details: Detail[] = [];

  const name = requiredString(body.name, 'name', MAX_NAME_LENGTH, details);
  const email = requiredString(body.email, 'email', MAX_EMAIL_LENGTH, details);
  if (email !== null && !EMAIL_PATTERN.test(email)) {
    details.push({ field: 'email', message: 'must be a valid email address' });
  }
  const role = optionalString(body.role, 'role', MAX_ROLE_LENGTH, details);

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return {
    name: name as string,
    email: email as string,
    role: role ?? null,
  };
}

/** A required field: a non-empty string, bounded and screened for a card/PAN shape. */
function requiredString(
  raw: unknown,
  field: string,
  maxLength: number,
  details: Detail[],
): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    details.push({ field, message: 'must be a non-empty string' });
    return null;
  }
  const value = raw.trim();
  if (value.length > maxLength) {
    details.push({ field, message: `must be ${maxLength} characters or fewer` });
    return null;
  }
  if (looksLikePan(value)) {
    details.push({ field, message: 'must not be a card or account number' });
    return null;
  }
  return value;
}

/** An optional field: absent/null/empty is null; otherwise bounded and screened. */
function optionalString(
  raw: unknown,
  field: string,
  maxLength: number,
  details: Detail[],
): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    details.push({ field, message: 'must be a string or null' });
    return undefined;
  }
  const value = raw.trim();
  if (value === '') return null;
  if (value.length > maxLength) {
    details.push({ field, message: `must be ${maxLength} characters or fewer` });
    return undefined;
  }
  if (looksLikePan(value)) {
    details.push({ field, message: 'must not be a card or account number' });
    return undefined;
  }
  return value;
}

/**
 * Whether a value looks like a payment card / PAN: a run of 13–19 digits (spaces and dashes stripped)
 * that passes the Luhn checksum. Conservative — it rejects real card numbers, not ordinary names or
 * roles — so a payment instrument is refused before it can be stored while genuine contact data passes.
 */
function looksLikePan(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  return luhnValid(digits);
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
