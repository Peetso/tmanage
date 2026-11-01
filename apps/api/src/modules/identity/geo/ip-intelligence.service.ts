import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { serializeForLog } from '../../../common/observability/logger.js';
import type { GeoLookup } from './geo-lookup.js';
import { hasVpnKeyword, isHostingNetwork } from './hosting-asns.js';
import { IpLookupsRepository, type IpLookupValues } from './ip-lookups.repository.js';
import { isPrivateIp } from './private-ip.js';

/** The part of `TorExitList` this service needs. */
export interface TorExits {
  has(ip: string): boolean;
}

/** What the sign-in and session paths call. */
export interface IpRecorder {
  record(ip: string | null | undefined, correlationId?: string): Promise<void>;
}

const MAX_IP_CHARACTERS = 45;

/**
 * R12 (R1). The place and network of an address, from the local GeoIP file, cached in
 * `ip_lookups`. `classify` is synchronous and touches no database (the sign-in scorer and the
 * locale hint use it); `record` gets-or-refreshes the cache row and never throws — a sign-in or a
 * refresh must never fail because of it.
 */
export class IpIntelligenceService implements IpRecorder {
  constructor(
    private readonly database: TenantDatabase | null,
    private readonly geo: GeoLookup,
    private readonly tor: TorExits | null = null,
    private readonly repository: IpLookupsRepository = new IpLookupsRepository(),
    private readonly log: (message: string, detail?: unknown) => void = console.warn,
  ) {}

  classify(raw: string | null | undefined): IpLookupValues | null {
    const ip = typeof raw === 'string' ? raw.trim() : '';
    if (ip === '' || ip.length > MAX_IP_CHARACTERS) return null;
    if (isPrivateIp(ip)) {
      return { ...EMPTY, ip, networkKind: 'local', source: null };
    }
    const found = this.geo.lookup(ip);
    const isTor = this.tor?.has(ip) ?? false;
    const asn = found?.asn ?? null;
    const owner = found?.networkOwner ?? null;
    const hosting = isHostingNetwork(asn, owner);
    return {
      ip,
      countryCode: found?.countryCode ?? null,
      country: clamp(found?.country, 80),
      region: clamp(found?.region, 120),
      city: clamp(found?.city, 120),
      postalCode: clamp(found?.postalCode, 16),
      asn,
      networkOwner: clamp(owner, 190),
      networkKind: hosting ? 'hosting' : found ? 'residential' : 'unknown',
      isTor,
      vpnOrProxy: hosting || isTor || hasVpnKeyword(owner) ? 'likely' : 'unknown',
      source: found?.source ?? null,
    };
  }

  async record(raw: string | null | undefined, correlationId = 'ip-intelligence'): Promise<void> {
    const values = this.classify(raw);
    if (values === null || this.database === null) return;
    try {
      await this.database.identityTransaction(
        { correlationId, tables: ['ip_lookups'] },
        async (tx) => {
          if (await this.repository.touchIfFresh(tx, values.ip)) return;
          await this.repository.upsert(tx, values);
        },
      );
    } catch (error) {
      this.log(
        `[geo] recording an IP lookup failed (correlation ${correlationId})`,
        serializeForLog(error),
      );
    }
  }
}

const EMPTY: Omit<IpLookupValues, 'ip' | 'networkKind' | 'source'> = {
  countryCode: null,
  country: null,
  region: null,
  city: null,
  postalCode: null,
  asn: null,
  networkOwner: null,
  isTor: false,
  vpnOrProxy: 'unknown',
};

function clamp(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return [...value].slice(0, max).join('');
}
