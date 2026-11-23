/**
 * The dictation languages a member may choose for voice input (Figma §Dictation 869:906, Fable 5.2
 * re-review 2026-11-23): seventeen BCP-47 tags, the one list the API validates the member's
 * `dictationLanguage` preference against and the web chip offers (AR-8: one list, one place).
 * Modern Standard Arabic is the plain `ar` tag.
 */
export const DICTATION_LANGUAGE_TAGS = [
  'en-US',
  'en-GB',
  'ar-EG',
  'ar-SA',
  'ar-AE',
  'ar-KW',
  'ar-QA',
  'ar-JO',
  'ar-LB',
  'ar-MA',
  'ar',
  'ur-PK',
  'fr-FR',
  'es-ES',
  'de-DE',
  'pt-BR',
  'zh-CN',
] as const;

export type DictationLanguageTag = (typeof DICTATION_LANGUAGE_TAGS)[number];

const TAGS: ReadonlySet<string> = new Set(DICTATION_LANGUAGE_TAGS);

export function isDictationLanguageTag(value: unknown): value is DictationLanguageTag {
  return typeof value === 'string' && TAGS.has(value);
}
