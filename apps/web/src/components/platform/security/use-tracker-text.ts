'use client';

import { useCallback } from 'react';
import { translateOr } from '../../../lib/i18n/compact-time';
import { pluralPhrase } from '../../../lib/i18n/plural';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useTrackerFormat } from './tracker-format';

const ENGLISH = {
  'AttackTracker.accounts': { one: '{count} account', other: '{count} accounts' },
  'AttackTracker.accountsTargetedTitle': {
    one: '{count} account targeted',
    other: '{count} accounts targeted',
  },
} as const;

/**
 * "12 accounts" / «⁦12⁩ حسابًا» in the reader's plural form (CLDR categories; Arabic has six). The
 * number is in the tracker's digits (Latin in Arabic, as {@link useTrackerFormat}).
 */
export function useAccountsPhrase(base: keyof typeof ENGLISH): (count: number) => string {
  const locale = useActiveLocale();
  const format = useTrackerFormat();
  return useCallback(
    (count: number) =>
      pluralPhrase(
        (key, english) => translateOr(key, english, locale),
        locale,
        base,
        count,
        ENGLISH[base],
        format.count(count),
      ),
    [base, format, locale],
  );
}
