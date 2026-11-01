/**
 * R12 (R1). Where an IP address is, approximately, and whose network it belongs to.
 *
 * `lookup` never throws and never reaches the network: the `mmdb` provider reads a local file,
 * `none` answers `null` for everything, and `static` is the test double. A private or loopback
 * address is answered by the caller (`private-ip.ts`) before any provider is asked.
 */
export interface GeoResult {
  readonly countryCode: string | null;
  readonly country: string | null;
  readonly region: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly asn?: number | null;
  readonly networkOwner?: string | null;
  /** Which provider answered: `mmdb` (DB-IP Lite), `static` (tests). */
  readonly source: string;
}

export interface GeoLookup {
  lookup(ip: string): GeoResult | null;
}

/** No database configured: every address is "unknown", and every location cell shows "—". */
export class NoneGeoLookup implements GeoLookup {
  lookup(): GeoResult | null {
    return null;
  }
}

/** A fixed table of answers, for tests and local fixtures. */
export class StaticGeoLookup implements GeoLookup {
  private readonly table: ReadonlyMap<string, GeoResult>;

  constructor(entries: Readonly<Record<string, Omit<GeoResult, 'source'>>>) {
    this.table = new Map(
      Object.entries(entries).map(([ip, result]) => [ip, { ...result, source: 'static' }]),
    );
  }

  lookup(ip: string): GeoResult | null {
    return this.table.get(ip) ?? null;
  }
}
