import { Controller, Get, Header, Headers, Inject, Query } from '@nestjs/common';
import { Public, NoTenant } from '../../common/http/decorators.js';
import {
  PUBLIC_FAQ_SERVICE,
  type FaqContentService,
  type FaqLocale,
  type PublicFaqView,
} from './faq.service.js';

/**
 * Public & trust site (module 1) — the public FAQ route (x186).
 *
 * `GET /v1/public/site/faq` — the FAQ page's content. `@Public()` and `@NoTenant()`: this is read
 * by a prospect who has no account and no organization, so there is no session to authenticate and
 * no tenant to resolve. Both annotations are visible lines rather than the silent consequence of a
 * missing one — the four global guards (`SessionAuthGuard`, `CsrfGuard`, `TenantContextGuard`,
 * `CapabilityGuard`) each short-circuit on `IS_PUBLIC`, so this route needs no session, no CSRF
 * token, no organization, and no capability, exactly like the sign-in and refresh doors.
 *
 * There is **no capability** and no `authorize()` call, and `capabilities.ts` is untouched: a
 * public page grants nothing and reads nothing tenant-specific. The controller touches no database
 * (ADR-0001 layer 4). The only request input it reads is the language: `?lang=` first, then
 * `Accept-Language`, each matched against a closed allowlist (`en`, `ar`) and otherwise English —
 * so an unexpected value can only ever select the default copy. Any sub-path other than `faq`
 * matches no handler and is a 404 from the router, before any guard runs.
 */
@Controller('v1/public/site')
export class FaqContentController {
  constructor(@Inject(PUBLIC_FAQ_SERVICE) private readonly content: FaqContentService) {}

  /** `GET /v1/public/site/faq` — the grouped FAQ content in the requested language. */
  @Get('faq')
  @Public()
  @NoTenant()
  @Header('Vary', 'Accept-Language')
  getFaq(
    @Query('lang') lang?: string | string[],
    @Headers('accept-language') acceptLanguage?: string,
  ): PublicFaqView {
    return this.content.getFaq(resolveFaqLocale(lang, acceptLanguage));
  }
}

/** The allowlisted FAQ language of one BCP-47 tag (`ar-EG` → `ar`), or `undefined`. */
function localeOfTag(tag: string): FaqLocale | undefined {
  const primary = tag.trim().split(/[-_]/)[0]?.toLowerCase();
  return primary === 'ar' || primary === 'en' ? primary : undefined;
}

/**
 * The FAQ language for a request: an allowlisted `?lang=` wins; otherwise the highest-weighted
 * allowlisted `Accept-Language` entry; otherwise `en`. Exported for the unit test only.
 */
export function resolveFaqLocale(
  lang: string | string[] | undefined,
  acceptLanguage: string | undefined,
): FaqLocale {
  const query = Array.isArray(lang) ? lang[0] : lang;
  if (typeof query === 'string') {
    const fromQuery = localeOfTag(query);
    if (fromQuery) return fromQuery;
  }
  if (typeof acceptLanguage === 'string' && acceptLanguage.length <= 512) {
    const ranked = acceptLanguage
      .split(',')
      .map((entry, index) => {
        const [tag = '', ...params] = entry.split(';');
        const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
        const weight = q === undefined ? 1 : Number(q.slice(2));
        return { tag, weight: Number.isFinite(weight) ? weight : 0, index };
      })
      .filter((entry) => entry.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.index - b.index);
    for (const entry of ranked) {
      const locale = localeOfTag(entry.tag);
      if (locale) return locale;
    }
  }
  return 'en';
}
