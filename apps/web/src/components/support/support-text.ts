'use client';

import { useMemo } from 'react';
import type { SupportCategory, SupportPriority } from '../../lib/api/support';
import { appDateLocale, appLocale } from '../../lib/i18n/app-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { formatBusinessDuration, targetWording } from '../../lib/support-sla-text';
import type { DurationUnits } from '../../lib/support-sla-text';

/** Plan names are brand names: Latin in every locale. */
const PLAN_NAMES: Readonly<Record<string, string>> = {
  free: 'Free',
  starter: 'Starter',
  studio: 'Studio',
  business: 'Business',
  enterprise: 'Enterprise',
};

export function planName(plan: string | null): string {
  return plan === null ? '—' : (PLAN_NAMES[plan] ?? plan);
}

/** 57-10 · the wording shared by "Get help" and the platform inbox (labels, durations, targets). */
export function useSupportText() {
  const tOr = useTOr();
  return useMemo(() => {
    const units: DurationUnits = {
      day: tOr('SupportSla.unitDay', 'day'),
      days: tOr('SupportSla.unitDays', 'days'),
      hour: tOr('SupportSla.unitHour', 'h'),
      minute: tOr('SupportSla.unitMinute', 'min'),
    };
    const category = (value: SupportCategory): string =>
      ({
        question: tOr('support.category.question', 'Question'),
        problem: tOr('support.category.problem', 'Something is not working'),
        billing: tOr('SupportSla.categoryBilling', 'Billing and plans'),
        account: tOr('support.category.account', 'Account and sign-in'),
        feature_request: tOr('support.category.feature_request', 'Feature request'),
        other: tOr('support.category.other', 'Something else'),
      })[value];
    const priority = (value: SupportPriority): string =>
      ({
        low: tOr('support.priority.low', 'Low'),
        normal: tOr('support.priority.normal', 'Normal'),
        high: tOr('support.priority.high', 'High'),
        urgent: tOr('support.priority.urgent', 'Urgent'),
      })[value];
    const duration = (minutes: number) => formatBusinessDuration(minutes, units);
    const target = (minutes: number): string => {
      const wording = targetWording(minutes);
      if (wording.kind === 'sameDay') return tOr('SupportSla.targetSameDay', 'Same business day');
      if (wording.kind === 'days') {
        return wording.count === 1
          ? tOr('SupportSla.targetOneDay', '1 business day')
          : tOr('SupportSla.targetDays', '{n} business days').replace('{n}', String(wording.count));
      }
      return wording.count === 1
        ? tOr('SupportSla.targetOneHour', '1 business hour')
        : tOr('SupportSla.targetHours', '{n} business hours').replace('{n}', String(wording.count));
    };
    const fill = (template: string, values: Readonly<Record<string, string>>) =>
      Object.entries(values).reduce(
        (text, [key, value]) => text.replace(`{${key}}`, value),
        template,
      );
    return { tOr, category, priority, duration, target, fill };
  }, [tOr]);
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** "09:40" today, otherwise "Thu 12 Nov" (with the time when asked). */
export function shortWhen(iso: string, withTime: boolean, now = new Date()): string {
  const at = new Date(iso);
  const locale = appDateLocale(appLocale(), appLocale());
  const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (sameDay(at, now)) return time;
  const day = at.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  return withTime ? `${day} ${time}` : day;
}

export function isToday(iso: string, now = new Date()): boolean {
  return sameDay(new Date(iso), now);
}
