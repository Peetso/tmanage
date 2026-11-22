'use client';

import { DayPulseBar } from './AppShell';
import type { DayPulseItem } from './AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { withNumerals } from '../../lib/i18n/display-format';
import { useT } from '../../lib/i18n/use-t';
import { useTodaySlots } from '../../lib/use-today-slots';

/**
 * FIX3 item 10 (live check a6f66e47): the day capsule as a section's top bar, so a main section
 * (Docs) carries the same schedule bar, from the same real data My Day's Today widget reads.
 * Moved out of `MyDayScreen` when My Day v3 replaced the bar with its Today widget.
 */
export function DayScheduleBar({
  organizationSlug,
  client,
}: {
  readonly organizationSlug: string;
  readonly client?: ApiClient;
}) {
  const t = useT();
  const api = client ?? browserApiClient();
  const { slots } = useTodaySlots(api, organizationSlug);
  const items: DayPulseItem[] = slots.map((slot) => ({
    id: slot.id,
    time: new Date(slot.start).toLocaleTimeString(withNumerals('en-GB'), {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
    label: slot.label,
    state: slot.state,
    href: slot.href,
  }));
  return (
    <DayPulseBar
      organizationSlug={organizationSlug}
      items={items}
      nowLabel={t('MyDay.nothingScheduled')}
    />
  );
}
