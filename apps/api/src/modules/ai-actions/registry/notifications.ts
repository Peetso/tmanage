/**
 * AI action details — notifications (the notification feed and mark-read).
 *
 * Slice S2 (registry wave A). The `standard` profile. Notification *preferences*
 * (`notification_preferences.*`) belong to wave C (S4 `preferences.ts`), not here.
 * `:orgSlug` is never an argument (architecture B3/T-TEN-01).
 */
import { det, listArgs, bodyArgs, f, type AiActionDetail } from './detail.js';

export const notificationsDetails: readonly AiActionDetail[] = [
  det({
    id: 'notifications.list',
    title: 'List notification',
    description: 'List notification.',
    input: listArgs([], { unread: f.bool().optional() }, { cursor: 'before' }),
    redact: 'standard',
    examples: [{ summary: 'List notification', args: {} }],
  }),
  det({
    id: 'notifications.read.create',
    title: 'Mark read notification',
    description: 'Mark read notification.',
    input: bodyArgs(['notificationId'], {}),
    redact: 'standard',
    examples: [{ summary: 'Mark read notification', args: { notificationId: 'n_1' } }],
  }),
];
