/**
 * 52-12 (R21-c) — the structured seller/buyer address an e-invoice needs (ZATCA: building number,
 * street, district, city, postal code, country). Stored as `org_finance_profiles.address_json`
 * (TEXT, 0310) beside the free-text `address_en/ar` lines. Pure, no I/O.
 */

export interface StructuredAddress {
  /** ZATCA: exactly four digits in Saudi Arabia. */
  readonly building: string;
  readonly street: string;
  readonly district: string;
  readonly city: string;
  /** ZATCA: exactly five digits in Saudi Arabia. */
  readonly postalCode: string;
  /** ISO 3166-1 alpha-2, upper case. */
  readonly countryCode: string;
}

export const ADDRESS_FIELDS = [
  'building',
  'street',
  'district',
  'city',
  'postalCode',
  'countryCode',
] as const;
export type AddressField = (typeof ADDRESS_FIELDS)[number];

const MAX_LENGTH = 120;

/** The fields each country's e-invoice regime requires; other countries need none. */
const REQUIRED_BY_COUNTRY: Readonly<Record<string, readonly AddressField[]>> = {
  SA: ADDRESS_FIELDS,
  AE: ['street', 'city', 'countryCode'],
  EG: ['street', 'city', 'countryCode'],
};

/**
 * An address from a request body or the stored TEXT (a JSON string): unknown keys are dropped,
 * strings trimmed to ≤ 120 characters, absent fields become `''`. `null` when the input is not an
 * object, a known field is not text, or every field is empty.
 */
export function parseAddressJson(raw: unknown): StructuredAddress | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const out: Record<AddressField, string> = {
    building: '',
    street: '',
    district: '',
    city: '',
    postalCode: '',
    countryCode: '',
  };
  for (const field of ADDRESS_FIELDS) {
    const item = input[field];
    if (item === undefined || item === null) continue;
    if (typeof item !== 'string') return null;
    out[field] = item.trim().slice(0, MAX_LENGTH);
  }
  out.countryCode = out.countryCode.toUpperCase();
  if (ADDRESS_FIELDS.every((field) => out[field] === '')) return null;
  return out;
}

/** Fields whose present value has the wrong shape (an empty field is "missing", not "invalid"). */
export function addressFormatErrors(
  address: StructuredAddress,
  countryCode: string,
): readonly AddressField[] {
  const errors: AddressField[] = [];
  const country = address.countryCode === '' ? countryCode : address.countryCode;
  if (address.countryCode !== '' && !/^[A-Z]{2}$/u.test(address.countryCode)) {
    errors.push('countryCode');
  }
  if (country === 'SA') {
    if (address.building !== '' && !/^\d{4}$/u.test(address.building)) errors.push('building');
    if (address.postalCode !== '' && !/^\d{5}$/u.test(address.postalCode)) {
      errors.push('postalCode');
    }
  }
  return errors;
}

/** The fields an e-invoice in `countryCode` still needs: empty or wrongly shaped. */
export function addressMissing(
  address: StructuredAddress | null,
  countryCode: string,
): readonly AddressField[] {
  const required = REQUIRED_BY_COUNTRY[countryCode] ?? [];
  if (address === null) return [...required];
  const invalid = new Set(addressFormatErrors(address, countryCode));
  return required.filter((field) => address[field] === '' || invalid.has(field));
}
