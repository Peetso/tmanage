import { activeLocale } from './i18n/locale-store';
import { translate, type MessageKey } from './i18n/t';

/**
 * How a work item's type is said: the type word in the person's language, and the short badge.
 * One module for every screen; its own file so the public website, which shares the state words
 * of `work-item-presentation.ts`, does not pull the app's `WorkItemType` catalog part.
 */

const TYPE_CODE: Readonly<Record<string, string>> = {
  task: 'TSK',
  bug: 'BUG',
  deliverable: 'DEL',
  document: 'DOC',
  doc: 'DOC',
  request: 'REQ',
  milestone: 'MIL',
};

/** A work item's type in words ("Task" / "مهمة"), never the raw key. */
export function typeName(type: string, locale: string = activeLocale.get()): string {
  const key = type.toLowerCase();
  const english = key.charAt(0).toUpperCase() + key.slice(1);
  const value = translate(locale, `WorkItemType.${key}` as MessageKey);
  return value === `WorkItemType.${key}` ? english : value;
}

/**
 * The type badge: the short Latin code ("TSK") in English, the type word elsewhere. My Day showed
 * "TSK" on the Arabic screen because it kept its own copy of this table (TESTUX P2 24).
 */
export function typeCode(type: string, locale: string = activeLocale.get()): string {
  if (!locale.toLowerCase().startsWith('en')) return typeName(type, locale);
  return TYPE_CODE[type.toLowerCase()] ?? type.slice(0, 3).toUpperCase();
}
