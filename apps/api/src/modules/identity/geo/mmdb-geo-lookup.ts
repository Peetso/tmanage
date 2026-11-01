import { readFileSync } from 'node:fs';
import { Reader, type AsnResponse, type CityResponse } from 'mmdb-lib';
import type { GeoLookup, GeoResult } from './geo-lookup.js';

type Log = (message: string) => void;

/**
 * R12 (R1). DB-IP Lite (CC BY 4.0) read from local `.mmdb` files — `GEOIP_DB_PATH` (city) and,
 * optionally, `GEOIP_ASN_DB_PATH` (network owner). Nothing leaves the process.
 *
 * A missing, unreadable or malformed file is logged once and the provider answers `null` for
 * every address: a sign-in must never fail because a location database is absent.
 */
export class MmdbGeoLookup implements GeoLookup {
  private readonly city: Reader<CityResponse> | null;
  private readonly asn: Reader<AsnResponse> | null;

  constructor(cityPath: string | undefined, asnPath?: string | undefined, log: Log = console.warn) {
    this.city = openReader<CityResponse>(cityPath, log);
    this.asn = openReader<AsnResponse>(asnPath, log);
  }

  get available(): boolean {
    return this.city !== null || this.asn !== null;
  }

  lookup(ip: string): GeoResult | null {
    const place = safeGet(this.city, ip);
    const network = safeGet(this.asn, ip);
    if (!place && !network) return null;
    return {
      countryCode: place?.country?.iso_code ?? null,
      country: place?.country?.names?.en ?? null,
      region: place?.subdivisions?.[0]?.names?.en ?? null,
      city: place?.city?.names?.en ?? null,
      postalCode: place?.postal?.code ?? null,
      asn: network?.autonomous_system_number ?? null,
      networkOwner: network?.autonomous_system_organization ?? null,
      source: 'mmdb',
    };
  }
}

function openReader<T extends CityResponse | AsnResponse>(
  path: string | undefined,
  log: Log,
): Reader<T> | null {
  if (path === undefined || path.trim() === '') return null;
  try {
    return new Reader<T>(readFileSync(path));
  } catch (error) {
    log(
      `[geo] GeoIP database at ${path} could not be opened; locations stay unknown (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return null;
  }
}

function safeGet<T extends CityResponse | AsnResponse>(
  reader: Reader<T> | null,
  ip: string,
): T | null {
  if (reader === null) return null;
  try {
    return reader.get(ip);
  } catch {
    return null;
  }
}
