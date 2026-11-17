import type { MailPersonTopic } from './mailer.js';

/**
 * EMAILBUILD — which pair of TManage people writes to a user: by region, then topic.
 *
 * Region, first match: the workspace's time zone when one is stored (anything but UTC), then the
 * reader's language (Arabic → Middle East), else `west`. The time zone is the only location signal
 * the schema keeps (`organizations.timezone`); there is no country column.
 */
export type MailPersonRegion = 'me' | 'west' | 'asia';

export const MAIL_PERSON_TOPICS: readonly MailPersonTopic[] = Object.freeze([
  'onboarding',
  'features',
  'news',
  'security',
  'success',
]);

export function isMailPersonTopic(value: unknown): value is MailPersonTopic {
  return typeof value === 'string' && (MAIL_PERSON_TOPICS as readonly string[]).includes(value);
}

/** Middle East and North Africa zones (IANA), including the Gulf and the Levant. */
const MENA = new Set([
  'Africa/Algiers',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Africa/El_Aaiun',
  'Africa/Khartoum',
  'Africa/Tripoli',
  'Africa/Tunis',
  'Africa/Nouakchott',
  'Asia/Aden',
  'Asia/Amman',
  'Asia/Baghdad',
  'Asia/Bahrain',
  'Asia/Beirut',
  'Asia/Damascus',
  'Asia/Dubai',
  'Asia/Gaza',
  'Asia/Hebron',
  'Asia/Jerusalem',
  'Asia/Kuwait',
  'Asia/Muscat',
  'Asia/Qatar',
  'Asia/Riyadh',
  'Asia/Tehran',
  'Europe/Istanbul',
]);

export function regionForTimezone(
  timezone: string | null | undefined,
  language: 'en' | 'ar',
): MailPersonRegion {
  const zone = timezone?.trim() ?? '';
  if (zone !== '' && zone !== 'UTC' && zone !== 'Etc/UTC') {
    if (MENA.has(zone)) return 'me';
    // Americas, Europe, Australia and the Pacific share the `west` pair.
    return zone.startsWith('Asia/') || zone.startsWith('Indian/') ? 'asia' : 'west';
  }
  return language === 'ar' ? 'me' : 'west';
}
