import { activeIsEnglish, compactUnit, translateOr } from '../../lib/i18n/compact-time';
import { sinceLabel } from './format';

/**
 * The Control center's compact time words in the active locale (C6, 2026-11-02 Arabic live test).
 *
 * `sinceLabel` prints `Now`, `10 min`, `17h`, and the policy table printed `24h`; the mono cells
 * upper-case them, so an Arabic owner read "17H" and "NOW". English keeps those strings; every
 * other locale gets a catalog word for "now" and the platform's narrow unit (`١٧ س`).
 */
export function localizedSinceLabel(iso: string, locale: string, now: number = Date.now()): string {
  if (activeIsEnglish(locale)) return sinceLabel(iso);
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 2) return translateOr('AdminSince.now', 'Now', locale);
  if (minutes < 60) return compactUnit(minutes, 'minute', locale);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return compactUnit(hours, 'hour', locale);
  return compactUnit(Math.round(hours / 24), 'day', locale);
}

/** A whole number of hours: `24h` in English, the narrow unit elsewhere. */
export function localizedHours(hours: number, locale: string): string {
  return activeIsEnglish(locale) ? `${hours}h` : compactUnit(hours, 'hour', locale);
}
