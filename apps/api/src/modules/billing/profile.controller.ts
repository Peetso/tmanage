import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { BILLING_PROFILE_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingAddress, BillingProfileRow } from '../../common/database/schema.js';
import type { BillingProfileInput, BillingProfileRepository } from './profile.repository.js';

/**
 * Billing profile (module 19, x180) — the billing-settings surface (audit #10: billing settings
 * absent). Two routes over one org-scoped row: read the organization's billing profile and update it.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on each route asks the coarse `org.manage` question — does this role's ceiling
 * hold it at all. This controller adds the authoritative application decision (`25-AUTH` §3 step 2,
 * deny-by-default) the guard cannot: an org-scoped `authorize()` (`projectId: null`) that a suspended
 * membership fails, exactly as `UsageService.read` does. Reusing `org.manage` scopes billing to
 * owners; no capability is invented and `capabilities.ts` is untouched.
 *
 * ## The tenant is the principal's, never the caller's — the resolve-before-authorize order
 *
 * Neither route takes an organization-id parameter. The only organization either can name is
 * `context.organizationId`, which `TenantContextGuard` resolved from an active membership by matching
 * the path's `:orgSlug` against it *before* this handler runs — a caller naming another studio's slug
 * is a 404 from the guard, never a value this controller trusts (`04-SECURITY-PRIVACY` §4). So a
 * cross-tenant read or write is not expressible here, the same shape `UsageController` takes.
 *
 * ## No payment instruments, ever
 *
 * `04-SECURITY-PRIVACY` §4: card and bank numbers are held by the payment provider, never in this
 * database. This surface stores only non-secret metadata, and {@link rejectPanShaped} refuses any
 * field whose value looks like a card/PAN (a 13–19 digit run that passes the Luhn check) with a 400
 * and no write, so a payment instrument never lands in a billing field even by mistake.
 */

/**
 * What the billing screen reads — CONTRACT-001 Exact, paired in `e2e/contracts/api-web-shapes.ts`
 * with `BillingProfileView` in `apps/web/src/lib/api/billing.ts`. `organizationId` is deliberately
 * absent: the wire projection never echoes the tenant id. `updatedAt` is null until the profile is
 * first saved (the read returns defaults when no row exists).
 */
export interface BillingProfileView {
  readonly billingEmail: string | null;
  readonly companyName: string | null;
  readonly taxId: string | null;
  readonly address: BillingAddress;
  /** An ISO-8601 instant, or null when no profile has been saved yet. */
  readonly updatedAt: string | null;
}

interface UpdateBillingProfileBody {
  readonly billingEmail?: unknown;
  readonly companyName?: unknown;
  readonly taxId?: unknown;
  readonly address?: unknown;
}

/** The bounds each field is held to (`billing_profiles` column widths and RFC 5321 for the email). */
const MAX_EMAIL_LENGTH = 254;
const MAX_COMPANY_LENGTH = 190;
const MAX_TAX_ID_LENGTH = 64;
const MAX_ADDRESS_LINE_LENGTH = 190;
const MAX_CITY_REGION_LENGTH = 120;
const MAX_POSTAL_LENGTH = 32;
const MAX_COUNTRY_LENGTH = 60;

/** A pragmatic email shape — one `@`, a non-empty local part, and a dotted domain. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMPTY_ADDRESS: BillingAddress = {
  line1: null,
  line2: null,
  city: null,
  region: null,
  postalCode: null,
  country: null,
};

type Detail = { field: string; message: string };

@Controller('v1/organizations/:orgSlug/billing/profile')
export class BillingProfileController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(BILLING_PROFILE_REPOSITORY) private readonly profiles: BillingProfileRepository,
  ) {}

  /** Read the acting tenant's billing profile, or the defaults when none has been saved. */
  @Get()
  @RequireCapability('org.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BillingProfileView> {
    this.authorizeManage(context, principal, 'billing_profile.read');

    const row = await this.database.read(context, (runner) => this.profiles.find(runner, context));
    return row ? toView(row) : defaultView();
  }

  /**
   * Create or replace the acting tenant's billing profile.
   *
   * Every field is validated and bounded before any write: a malformed email, an over-length value,
   * or a card/PAN-shaped value in any field is a 400 with no write (Known-trap). Only when the whole
   * body is valid is the single upsert issued.
   */
  @Put()
  @RequireCapability('org.manage')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: UpdateBillingProfileBody,
  ): Promise<BillingProfileView> {
    this.authorizeManage(context, principal, 'billing_profile.update');

    const input = validateBody(body);

    const row = await this.database.transaction(context, (tx) =>
      this.profiles.upsert(tx, context, input),
    );
    return toView(row);
  }

  /** The org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  private authorizeManage(context: TenantContext, principal: Principal, reason: string): void {
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
        `${reason}:${verdict.code}`,
      );
    }
  }
}

function toView(row: BillingProfileRow): BillingProfileView {
  return {
    billingEmail: row.billingEmail,
    companyName: row.companyName,
    taxId: row.taxId,
    address: normaliseAddress(row.addressJson),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function defaultView(): BillingProfileView {
  return {
    billingEmail: null,
    companyName: null,
    taxId: null,
    address: EMPTY_ADDRESS,
    updatedAt: null,
  };
}

/** A stored address may predate a field; fill any missing key with null so the view is total. */
function normaliseAddress(address: BillingAddress | null): BillingAddress {
  return {
    line1: address?.line1 ?? null,
    line2: address?.line2 ?? null,
    city: address?.city ?? null,
    region: address?.region ?? null,
    postalCode: address?.postalCode ?? null,
    country: address?.country ?? null,
  };
}

/**
 * Validate and bound the whole body, or throw a 400 that names every offending field at once. A field
 * that is absent or explicitly `null` clears that value; an empty string is treated as null so the
 * form can send blanks. Returns the persisted-ready input only when nothing is wrong.
 */
function validateBody(body: UpdateBillingProfileBody): BillingProfileInput {
  const details: Detail[] = [];

  const billingEmail = optionalString(
    body?.billingEmail,
    'billingEmail',
    MAX_EMAIL_LENGTH,
    details,
  );
  if (billingEmail !== null && billingEmail !== undefined && !EMAIL_PATTERN.test(billingEmail)) {
    details.push({ field: 'billingEmail', message: 'must be a valid email address' });
  }

  const companyName = optionalString(body?.companyName, 'companyName', MAX_COMPANY_LENGTH, details);
  const taxId = optionalString(body?.taxId, 'taxId', MAX_TAX_ID_LENGTH, details);

  const address = validateAddress(body?.address, details);

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return {
    billingEmail: billingEmail ?? null,
    companyName: companyName ?? null,
    taxId: taxId ?? null,
    address,
  };
}

function validateAddress(raw: unknown, details: Detail[]): BillingAddress {
  if (raw === undefined || raw === null) return EMPTY_ADDRESS;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    details.push({ field: 'address', message: 'must be an object' });
    return EMPTY_ADDRESS;
  }
  const record = raw as Record<string, unknown>;
  return {
    line1:
      optionalString(record['line1'], 'address.line1', MAX_ADDRESS_LINE_LENGTH, details) ?? null,
    line2:
      optionalString(record['line2'], 'address.line2', MAX_ADDRESS_LINE_LENGTH, details) ?? null,
    city: optionalString(record['city'], 'address.city', MAX_CITY_REGION_LENGTH, details) ?? null,
    region:
      optionalString(record['region'], 'address.region', MAX_CITY_REGION_LENGTH, details) ?? null,
    postalCode:
      optionalString(record['postalCode'], 'address.postalCode', MAX_POSTAL_LENGTH, details) ??
      null,
    country:
      optionalString(record['country'], 'address.country', MAX_COUNTRY_LENGTH, details) ?? null,
  };
}

/**
 * A field that may be a string, null, undefined or an empty string, bounded and screened.
 *
 * Returns the trimmed string, or null when absent/blank. Pushes a detail (and returns undefined) when
 * the value is the wrong type, over the bound, or card/PAN-shaped — the last is the payment-instrument
 * guard: no billing field may carry a value that looks like a card number.
 */
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
 * that passes the Luhn checksum. This is deliberately conservative — it rejects real card numbers, not
 * ordinary tax ids or postal codes, which are shorter or do not satisfy Luhn — so a payment instrument
 * is refused before it can be stored while genuine billing metadata passes.
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
