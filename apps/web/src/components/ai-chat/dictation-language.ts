/**
 * The dictation languages of the TManage AI composer (Figma §Dictation 869:906 / 873:906, chip set
 * 878:976; Fable 5.2 re-review 2026-11-23, READY TO BUILD, notes N1–N2). Pure (IP-3): the list, the
 * default, the search and the saved choice, proved without a browser or a microphone.
 *
 * Seventeen BCP-47 tags in three groups: two English, nine Arabic (Modern Standard Arabic is the
 * plain `ar` tag, which the browsers' speech services read as MSA), six others. The names on screen
 * come from the catalogs (`AiChat.dictation.lang.<tag>`), in the member's app language.
 */

import { isDictationLanguageTag } from '@tmanage/domain';
import type { DictationLanguageTag } from '@tmanage/domain';

/**
 * The groups, in the order shown in both app languages (Figma 878:976, AR 873:1476). The chosen
 * language is scrolled into view on open, so an Arabic member still sees their choice first.
 */
export const DICTATION_GROUPS = ['english', 'arabic', 'other'] as const;
export type DictationGroup = (typeof DICTATION_GROUPS)[number];

export interface DictationLanguage {
  readonly tag: string;
  readonly group: DictationGroup;
}

export const DICTATION_LANGUAGES: readonly DictationLanguage[] = [
  { tag: 'en-US', group: 'english' },
  { tag: 'en-GB', group: 'english' },
  { tag: 'ar-EG', group: 'arabic' },
  { tag: 'ar-SA', group: 'arabic' },
  { tag: 'ar-AE', group: 'arabic' },
  { tag: 'ar-KW', group: 'arabic' },
  { tag: 'ar-QA', group: 'arabic' },
  { tag: 'ar-JO', group: 'arabic' },
  { tag: 'ar-LB', group: 'arabic' },
  { tag: 'ar-MA', group: 'arabic' },
  { tag: 'ar', group: 'arabic' },
  { tag: 'ur-PK', group: 'other' },
  { tag: 'fr-FR', group: 'other' },
  { tag: 'es-ES', group: 'other' },
  { tag: 'de-DE', group: 'other' },
  { tag: 'pt-BR', group: 'other' },
  { tag: 'zh-CN', group: 'other' },
];

const TAGS = new Set(DICTATION_LANGUAGES.map((language) => language.tag));

/** One of the domain's `DICTATION_LANGUAGE_TAGS`, the list the API validates the preference by. */
export function isDictationTag(value: unknown): value is DictationLanguageTag {
  return isDictationLanguageTag(value);
}

/**
 * The default: the app language. An exact tag wins (`ar-EG`, `en-GB`); otherwise the language's
 * first entry (`fr` → `fr-FR`, `ar-SA` app locale → `ar-SA`); otherwise English (US).
 */
export function appLanguageTag(appLocale: string): string {
  // Arabic in the app means Egyptian Arabic (the catalog's voice); MSA stays one choice away.
  if (appLocale.toLowerCase() === 'ar') return 'ar-EG';
  if (TAGS.has(appLocale)) return appLocale;
  const language = appLocale.split('-')[0]?.toLowerCase() ?? '';
  if (language === 'ar') return 'ar-EG';
  const first = DICTATION_LANGUAGES.find((entry) => entry.tag.split('-')[0] === language);
  return first?.tag ?? 'en-US';
}

/** The catalog key of a language's name. */
export function languageNameKey(tag: string): `AiChat.dictation.lang.${string}` {
  return `AiChat.dictation.lang.${tag}`;
}

/** The catalog key of a language's short name (the word alone), for when space forces it (N1). */
export function languageShortKey(group: DictationGroup, tag: string): `AiChat.dictation.${string}` {
  if (group === 'english') return 'AiChat.dictation.short.english';
  if (group === 'arabic') return 'AiChat.dictation.short.arabic';
  return languageNameKey(tag);
}

/** Lowercased, without Arabic diacritics or tatweel, so "عربي" and "العربية" search alike. */
export function searchFold(text: string): string {
  return text
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}|\u0640/gu, '')
    .replace(/[أإآ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/ة/gu, 'ه')
    .trim();
}

/**
 * Search matches the name on screen and the English and Arabic names in either app language (the
 * no-match hint promises "Try the English or Arabic name"). `names` holds, per tag, every name the
 * caller knows for it (the catalog name plus the English and Arabic display names).
 */
export function filterLanguages(
  query: string,
  names: ReadonlyMap<string, readonly string[]>,
): DictationLanguage[] {
  const needle = searchFold(query);
  if (needle === '') return [...DICTATION_LANGUAGES];
  return DICTATION_LANGUAGES.filter((language) =>
    [language.tag, ...(names.get(language.tag) ?? [])].some((name) =>
      searchFold(name).includes(needle),
    ),
  );
}

/** Why the chip is disabled, or `null` when dictation can run here. */
export type DictationBlock = 'browser' | 'desktop-app' | null;

export function dictationBlock(supported: boolean, desktopApp: boolean): DictationBlock {
  if (desktopApp) return 'desktop-app';
  return supported ? null : 'browser';
}

/** The desktop shell exposes `window.tmanageDesktop` (apps/desktop/src/preload.ts). */
export function isDesktopApp(
  win: unknown = typeof window === 'undefined' ? undefined : window,
): boolean {
  return (win as { tmanageDesktop?: unknown } | undefined)?.tmanageDesktop !== undefined;
}

// ── The saved choice ────────────────────────────────────────────────────────────────────────────
//
// The member's own `dictationLanguage` display preference (API AI-PANEL-API, 2026-11-23), so the
// choice follows the member to every browser and device; `null` = the app language.
