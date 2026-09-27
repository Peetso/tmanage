import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { ISO_COUNTRY_CODE_SET } from '../../common/database/schema.js';
import type { BillingTaxDetailsRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  BillingTaxDetailsInput,
  BillingTaxDetailsRepository,
} from './tax-details.repository.js';

/**
 * Billing tax / legal-entity details (module 19, x283) — the service behind
 * `GET`/`PUT …/billing/tax-details`. It carries the two authorization layers and the whole-body
 * validation the controller's route guard cannot, then delegates the single read/upsert to the
 * repository.
 *
 * ## The two authorization layers
 *
 * The controller's `CapabilityGuard` asks the coarse `org.manage` question — does this role's ceiling
 * hold it at all. This service adds the authoritative application decision (`25-AUTH` §3 step 2,
 * deny-by-default) the guard cannot: an org-scoped `authorize()` (`projectId: null`) that a suspended
 * membership fails, exactly as the billing-profile controller does. Reusing `org.manage` scopes this
 * surface to owners; no capability is invented and `capabilities.ts` is untouched.
 *
 * ## The tenant is the principal's, never the caller's
 *
 * Neither route takes an organization-id parameter. The only organization either can name is
 * `context.organizationId`, resolved by `TenantContextGuard` from an active membership *before* the
 * handler runs, so a cross-tenant read or write is not expressible.
 *
 * ## No payment instruments, ever
 *
 * `04-SECURITY-PRIVACY` §4: card and bank numbers are held by the payment provider, never here. This
 * surface stores only non-secret legal/tax metadata, and {@link rejectPanShaped} refuses any field
 * whose value looks like a card/PAN (a 13–19 digit run that passes the Luhn check) with a 400 and no
 * write, so a payment instrument never lands in a tax field even by mistake.
 */

/**
 * What the tax-details screen reads — CONTRACT-001 Exact, paired in `e2e/contracts/api-web-shapes.ts`
 * with `TaxDetailsView` in `apps/web/src/lib/api/billing-tax-details.ts`. `organizationId` is
 * deliberately absent: the wire projection never echoes the tenant id. Every field is null until the
 * row is first saved (the read returns defaults when no row exists).
 */
export interface TaxDetailsView {
  readonly legalName: string | null;
  readonly taxId: string | null;
  readonly registrationNo: string | null;
  readonly taxCountry: string | null;
  /** An ISO-8601 instant, or null when no tax details have been saved yet. */
  readonly updatedAt: string | null;
}

export interface UpdateTaxDetailsBody {
  readonly legalName?: unknown;
  readonly taxId?: unknown;
  readonly registrationNo?: unknown;
  readonly taxCountry?: unknown;
}

/** The bounds each field is held to (`billing_tax_details` column widths). */
const MAX_LEGAL_NAME_LENGTH = 190;
const MAX_TAX_ID_LENGTH = 64;
const MAX_REGISTRATION_LENGTH = 120;

type Detail = { field: string; message: string };

export class BillingTaxDetailsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: BillingTaxDetailsRepository,
  ) {}

  /** Read the acting tenant's tax details, or the defaults when none has been saved. */
  async read(context: TenantContext, principal: Principal): Promise<TaxDetailsView> {
    this.authorizeManage(context, principal, 'billing_tax_details.read');
    const row = await this.database.read(context, (runner) =>
      this.repository.find(runner, context),
    );
    return row ? toView(row) : defaultView();
  }

  /**
   * Create or replace the acting tenant's tax details.
   *
   * Every field is validated and bounded before any write: a missing/empty legal name, an over-length
   * value, a tax country outside the ISO allowlist, or a card/PAN-shaped value in any field is a 400
   * with no write. Only when the whole body is valid is the single upsert issued.
   */
  async update(
    context: TenantContext,
    principal: Principal,
    body: UpdateTaxDetailsBody,
  ): Promise<TaxDetailsView> {
    this.authorizeManage(context, principal, 'billing_tax_details.update');
    const input = validateBody(body);
    const row = await this.database.transaction(context, (tx) =>
      this.repository.upsert(tx, context, input),
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

function toView(row: BillingTaxDetailsRow): TaxDetailsView {
  return {
    legalName: row.legalName,
    taxId: row.taxId,
    registrationNo: row.registrationNo,
    taxCountry: row.taxCountry,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function defaultView(): TaxDetailsView {
  return {
    legalName: null,
    taxId: null,
    registrationNo: null,
    taxCountry: null,
    updatedAt: null,
  };
}

/**
 * Validate and bound the whole body, or throw a 400 that names every offending field at once. Returns
 * the persisted-ready input only when nothing is wrong: `legalName` is required and non-empty,
 * `taxCountry` is a 2-letter ISO code from the allowlist (upper-cased), and the optional ids clear on
 * blank.
 */
function validateBody(body: UpdateTaxDetailsBody): BillingTaxDetailsInput {
  const details: Detail[] = [];

  const legalName = requiredString(body?.legalName, 'legalName', MAX_LEGAL_NAME_LENGTH, details);
  const taxId = optionalString(body?.taxId, 'taxId', MAX_TAX_ID_LENGTH, details);
  const registrationNo = optionalString(
    body?.registrationNo,
    'registrationNo',
    MAX_REGISTRATION_LENGTH,
    details,
  );
  const taxCountry = validateCountry(body?.taxCountry, details);

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return {
    legalName: legalName as string,
    taxId: taxId ?? null,
    registrationNo: registrationNo ?? null,
    taxCountry: taxCountry as string,
  };
}

/** A required, bounded, PAN-screened string. Pushes a detail and returns undefined when unusable. */
function requiredString(
  raw: unknown,
  field: string,
  maxLength: number,
  details: Detail[],
): string | undefined {
  if (typeof raw !== 'string') {
    details.push({ field, message: 'is required' });
    return undefined;
  }
  const value = raw.trim();
  if (value === '') {
    details.push({ field, message: 'must not be empty' });
    return undefined;
  }
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
 * A field that may be a string, null, undefined or an empty string, bounded and screened. Returns the
 * trimmed string, or null when absent/blank; pushes a detail (and returns undefined) when the value is
 * the wrong type, over the bound, or card/PAN-shaped.
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
 * A required 2-letter ISO 3166-1 alpha-2 tax country from the closed allowlist. Upper-cases before the
 * check so a lower-case code is accepted, but an unknown or malformed code is a 400 with no upsert.
 */
function validateCountry(raw: unknown, details: Detail[]): string | undefined {
  if (typeof raw !== 'string') {
    details.push({ field: 'taxCountry', message: 'is required' });
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!ISO_COUNTRY_CODE_SET.has(value)) {
    details.push({ field: 'taxCountry', message: 'must be a 2-letter ISO country code' });
    return undefined;
  }
  return value;
}

/**
 * Whether a value looks like a payment card / PAN: a run of 13–19 digits (spaces and dashes stripped)
 * that passes the Luhn checksum. Deliberately conservative — it rejects real card numbers, not ordinary
 * tax or registration ids — so a payment instrument is refused before it can be stored.
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
