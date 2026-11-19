import { resolveSignalSettings, signalRecipients } from '@tmanage/domain';
import { isFlagOn } from '../common/database/feature-flag-store.js';
import { insertNotification } from '../common/database/notifications-store.js';
import {
  findSignal,
  findSignalSetting,
  findSubjectPeople,
  listSignalRecipientCandidates,
} from '../common/database/signal-notice-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { OutboxHandler } from '../outbox/dispatcher.js';
import { BUSINESS_BRIEFING_FLAG } from '../jobs/signals-sweeper.js';

/**
 * 62-27 (B05) — the consumer of `work_signal.raised.v1`: one in-app notice per person the owner
 * chose for the rule (`signalRecipients`, domain), resolved now from the current memberships
 * (`24-EVENT-CATALOG` §6). The notice is a reference envelope — type, `work_signal`, the signal
 * id — and the inbox renders its words from the signal row at display time.
 *
 * Re-checked at delivery, so nothing is told that should no longer be: the `business_briefing`
 * flag must still be on and the rule still on (switching a rule off stops its notices, FIGMA-D
 * fix 27). A money rule reaches `finance.view` holders only. A redelivery is a no-op: the dedupe
 * key is the signal id, and a signal is filed at most once per subject per 24 hours.
 */

export const WORK_SIGNAL_NOTICE_OBJECT = 'work_signal';

function signalIdOf(event: ClaimedOutboxEvent): string {
  const raw =
    event.payload !== null && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)['signalId']
      : undefined;
  if (typeof raw !== 'string') throw new Error(`event ${event.id} has no readable signalId`);
  return raw;
}

export const workSignalRaisedConsumer: OutboxHandler = async (
  event: ClaimedOutboxEvent,
  tx: WorkerTransaction,
): Promise<void> => {
  const organizationId = event.organizationId;
  const signalId = signalIdOf(event);
  if (!(await isFlagOn(tx, BUSINESS_BRIEFING_FLAG, organizationId))) return;
  const signal = await findSignal(tx, organizationId, signalId);
  if (signal === null) return;
  const setting = resolveSignalSettings(await findSignalSetting(tx, organizationId, signal.rule))[
    signal.rule
  ];
  if (!setting.enabled) return;
  const recipients = signalRecipients(
    signal.rule,
    setting.recipient,
    await findSubjectPeople(tx, organizationId, signal),
    await listSignalRecipientCandidates(tx, organizationId, signal.projectId, new Date()),
  );
  for (const recipientUserId of recipients) {
    await insertNotification(tx, {
      organizationId,
      recipientUserId,
      type: event.type,
      objectType: WORK_SIGNAL_NOTICE_OBJECT,
      objectId: signal.id,
      dedupeKey: `work_signal:${signal.id}`,
    });
  }
};
