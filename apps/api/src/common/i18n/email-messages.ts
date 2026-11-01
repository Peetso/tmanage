import en from './email/en.json' with { type: 'json' };
import ar from './email/ar.json' with { type: 'json' };
import es from './email/es.json' with { type: 'json' };
import fr from './email/fr.json' with { type: 'json' };
import ptBR from './email/pt-BR.json' with { type: 'json' };
import de from './email/de.json' with { type: 'json' };
import zhCN from './email/zh-CN.json' with { type: 'json' };

/**
 * R12 R2 — the email copy, one flat catalog per language (`email/<lang>.json`), the API's twin of
 * the web catalogs. `en.json` is the key set and the fallback; `ar.json` is reviewed; the five beta
 * catalogs start as English copies and each language worker replaces its own file.
 *
 * `meta.lang` / `meta.dir` / `meta.dateLocale` travel in the catalog, so a language decides its own
 * direction and date format. `{name}` placeholders are filled by {@link emailT}; the values are
 * already flattened and filtered by the callers (`mailSafeName`), never raw input.
 */

export type EmailKey = keyof typeof en;

type EmailCatalogName = 'en' | 'ar' | 'es' | 'fr' | 'pt-BR' | 'de' | 'zh-CN';

const CATALOGS: Readonly<Record<EmailCatalogName, Readonly<Record<string, string>>>> = {
  en,
  ar,
  es,
  fr,
  'pt-BR': ptBR,
  de,
  'zh-CN': zhCN,
};

/** The catalog a locale reads: ar, es, fr, pt → pt-BR, de, zh → zh-CN, English otherwise. */
export function emailCatalogOf(locale: string | null | undefined): EmailCatalogName {
  const primary = (locale ?? '').split('-')[0]?.toLowerCase() ?? '';
  if (primary === 'pt') return 'pt-BR';
  if (primary === 'zh') return 'zh-CN';
  return primary === 'ar' || primary === 'es' || primary === 'fr' || primary === 'de'
    ? primary
    : 'en';
}

/**
 * The language an email goes out in: the person's own `users.locale`, else the workspace's
 * `organizations.default_locale`, else English.
 */
export function emailLocale(
  userLocale: string | null | undefined,
  organizationLocale?: string | null,
): string {
  if (userLocale) return userLocale;
  if (organizationLocale) return organizationLocale;
  return 'en';
}

/** `key` in `locale`'s catalog (English when missing), with `{placeholder}`s filled from `vars`. */
export function emailT(
  locale: string | null | undefined,
  key: EmailKey,
  vars: Readonly<Record<string, string>> = {},
): string {
  const line = CATALOGS[emailCatalogOf(locale)][key] ?? en[key];
  return line.replace(/\{(\w+)\}/gu, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? (vars[name] ?? match) : match,
  );
}

/** Whether `locale`'s emails are written right to left (`meta.dir`). */
export function emailIsRtl(locale: string | null | undefined): boolean {
  return emailT(locale, 'meta.dir') === 'rtl';
}
