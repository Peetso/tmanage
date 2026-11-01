import { Controller, Get, Header, Inject, Optional, Req } from '@nestjs/common';
import {
  DEFAULT_SUGGESTED_LOCALE,
  localeForAcceptLanguage,
  localeForCountry,
  type SuggestedLocale,
} from '@tmanage/domain';
import { NoTenant, Public } from '../../common/http/decorators.js';
import { GEO_LOOKUP } from '../identity/geo/geo.module.js';
import type { GeoLookup } from '../identity/geo/geo-lookup.js';
import { isPrivateIp } from '../identity/geo/private-ip.js';

export interface LocaleHintView {
  /** ISO 3166-1 alpha-2 of the caller's address, when the GeoIP file placed it. */
  readonly country: string | null;
  readonly locale: SuggestedLocale;
  readonly source: 'geo' | 'accept-language' | 'default';
}

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

/**
 * R12 (R2, SPEC D6). `GET /v1/public/locale-hint` — the interface language to start a first-time
 * visitor in. `@Public()` and `@NoTenant()` like the FAQ route: anonymous, no database (the GeoIP
 * file is read in memory), no capability. The country is used only when it speaks one language
 * unambiguously; then `Accept-Language`; then `en-US`. `no-store`: the answer depends on the
 * caller's address, so no shared cache may keep it.
 */
@Controller('v1/public')
export class LocaleHintController {
  constructor(@Optional() @Inject(GEO_LOOKUP) private readonly geo?: GeoLookup) {}

  @Get('locale-hint')
  @Public()
  @NoTenant()
  @Header('Cache-Control', 'no-store')
  getLocaleHint(@Req() request: RequestLike): LocaleHintView {
    return resolveLocaleHint(this.geo ?? null, request.ip, request.headers['accept-language']);
  }
}

/** Exported for the unit test. */
export function resolveLocaleHint(
  geo: GeoLookup | null,
  ip: string | undefined,
  acceptLanguage: string | string[] | undefined,
): LocaleHintView {
  const address = ip?.trim() ?? '';
  const country =
    geo && address !== '' && !isPrivateIp(address)
      ? (geo.lookup(address)?.countryCode ?? null)
      : null;
  const fromCountry = localeForCountry(country);
  if (fromCountry) return { country, locale: fromCountry, source: 'geo' };
  const header = Array.isArray(acceptLanguage) ? acceptLanguage.join(',') : acceptLanguage;
  const fromHeader = localeForAcceptLanguage(header);
  if (fromHeader) return { country, locale: fromHeader, source: 'accept-language' };
  return { country, locale: DEFAULT_SUGGESTED_LOCALE, source: 'default' };
}
