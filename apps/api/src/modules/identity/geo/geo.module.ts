import { Module, type OnModuleDestroy, Inject } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { API_CONFIG, TENANT_DATABASE } from '../../../common/http/tokens.js';
import type { ApiConfig } from '../../../common/http/api-config.js';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { NoneGeoLookup, type GeoLookup } from './geo-lookup.js';
import { MmdbGeoLookup } from './mmdb-geo-lookup.js';
import { IpIntelligenceService } from './ip-intelligence.service.js';
import { TorExitList } from './tor-exit-list.js';

/** R12. The GeoIP provider (`mmdb` when `GEOIP_DB_PATH` opens, otherwise `none`). */
export const GEO_LOOKUP = Symbol.for('tmanage.GeoLookup');
/** R12. The IP cache service the sign-in and session paths record through. */
export const IP_INTELLIGENCE = Symbol.for('tmanage.IpIntelligence');
const TOR_EXIT_LIST = Symbol.for('tmanage.TorExitList');

const geoLookup: Provider = {
  provide: GEO_LOOKUP,
  inject: [API_CONFIG],
  useFactory: (config: ApiConfig): GeoLookup => {
    const mmdb = new MmdbGeoLookup(config.geoip?.dbPath, config.geoip?.asnDbPath);
    return mmdb.available ? mmdb : new NoneGeoLookup();
  },
};

const torExitList: Provider = {
  provide: TOR_EXIT_LIST,
  inject: [API_CONFIG],
  useFactory: (config: ApiConfig) => {
    const list = new TorExitList(config.geoip?.torExitListUrl);
    list.start();
    return list;
  },
};

const ipIntelligence: Provider = {
  provide: IP_INTELLIGENCE,
  inject: [TENANT_DATABASE, GEO_LOOKUP, TOR_EXIT_LIST],
  useFactory: (database: TenantDatabase, geo: GeoLookup, tor: TorExitList) =>
    new IpIntelligenceService(database, geo, tor),
};

/**
 * R12 (R1). One instance per application: the `.mmdb` files are read once into memory and the
 * Tor list is refreshed by one timer. Imported by `IdentityModule` and `PublicSiteModule`.
 */
@Module({
  providers: [geoLookup, torExitList, ipIntelligence],
  exports: [GEO_LOOKUP, IP_INTELLIGENCE],
})
export class GeoModule implements OnModuleDestroy {
  constructor(@Inject(TOR_EXIT_LIST) private readonly tor: TorExitList) {}

  onModuleDestroy(): void {
    this.tor.stop();
  }
}
