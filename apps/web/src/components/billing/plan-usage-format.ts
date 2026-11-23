import { PLAN_USAGE_COPY, type PlanUsageCopyKey } from './plan-usage-copy';
import { appDateLocale } from '../../lib/i18n/app-locale';

/** The copy lookup a Plan and usage component uses: `tOr` bound to the F4 English defaults. */
export type PlanUsageText = (key: PlanUsageCopyKey) => string;

export function planUsageText(tOr: (key: string, english: string) => string): PlanUsageText {
  return (key) => tOr(key, PLAN_USAGE_COPY[key]);
}

/** Replace each `{slot}` in a catalog string. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, slot: string) =>
    values[slot] === undefined ? whole : String(values[slot]),
  );
}

/** Plan names are product names: the same in English and Arabic. */
const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  starter: 'Starter',
  studio: 'Studio',
  pro: 'Studio',
  business: 'Business',
  enterprise: 'Enterprise',
};

export function planName(planId: string): string {
  return PLAN_NAMES[planId] ?? planId;
}

/** Storage providers are product names, the same in every language. */
const PROVIDER_NAMES = { google_drive: 'Google Drive', onedrive: 'OneDrive' } as const;
/** Whose account a provider signs in with ("A different Google account …"). */
const PROVIDER_COMPANIES = { google_drive: 'Google', onedrive: 'Microsoft' } as const;

export function providerName(provider: keyof typeof PROVIDER_NAMES): string {
  return PROVIDER_NAMES[provider];
}

export function providerCompany(provider: keyof typeof PROVIDER_COMPANIES): string {
  return PROVIDER_COMPANIES[provider];
}

/** A count with grouping ("1,240"); digits by the app rule (Latin unless chosen). */
export function count(value: number, locale: string): string {
  return new Intl.NumberFormat(appDateLocale(locale, locale)).format(value);
}

const GB = 1024 ** 3;

/** Bytes as whole-or-one-decimal GB, the way F4 writes them ("22.8", "25"). */
export function gb(bytes: number): string {
  const rounded = Math.round((Math.max(0, bytes) / GB) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Integer cents as F4 writes money: `$19`, `$6.77`, `$0`. */
export function money(cents: number, currency: string): string {
  const major = cents / 100;
  const text = Number.isInteger(major) ? String(major) : major.toFixed(2);
  return currency.toLowerCase() === 'usd' ? `$${text}` : `${text} ${currency.toUpperCase()}`;
}

/** A `YYYY-MM-DD` day as "1 November" (English) or "1 نوفمبر" (Arabic), always in UTC. */
export function dayMonth(isoDay: string, locale: string): string {
  const at = new Date(`${isoDay.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) return isoDay;
  const arabic = locale.toLowerCase().startsWith('ar');
  const month = new Intl.DateTimeFormat(arabic ? 'ar' : 'en-GB', {
    month: 'long',
    timeZone: 'UTC',
  }).format(at);
  return `${at.getUTCDate()} ${month}`;
}
