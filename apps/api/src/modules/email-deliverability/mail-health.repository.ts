import type { RowDataPacket } from 'mysql2/promise';
import {
  MAILBOXES,
  MAIL_LANES,
  lanePausedSettingKey,
  mailboxCeilingSettingKey,
} from '@tmanage/mail';
import type { MailLane, Mailbox } from '@tmanage/mail';
import type { TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * 56-31 — the reads behind `GET /v1/platform/mail/health`. Counts only: no statement here
 * selects `to_hash`, `payload_json` or any address. GLOBAL tables, so `identityRead`.
 */

type Row = RowDataPacket & Record<string, unknown>;

const SQL = {
  byLaneAndStatus: `select lane, status, count(*) as n from mail_queue
    where status in ('queued', 'deferred', 'sending') group by lane, status`,
  sentThisHour: `select lane, mailbox, count(*) as n from mail_queue
    where status = 'sent' and sent_at >= ? group by lane, mailbox`,
  windows: `select mailbox, count as n from mail_hour_windows where window_start = ?`,
  settings: (keys: number) => `select setting_key, setting_value from platform_settings
    where setting_key in (${Array.from({ length: keys }, () => '?').join(', ')})`,
} as const;

export interface MailHealthCounts {
  /** `lane:status` → rows, for queued / deferred / sending. */
  readonly pending: ReadonlyMap<string, number>;
  /** `lane:mailbox` → rows sent since the window started. */
  readonly sent: ReadonlyMap<string, number>;
  /** mailbox → submissions counted this hour by the drainer. */
  readonly windows: ReadonlyMap<Mailbox, number>;
  /** `platform_settings` values for the ceilings and pauses that exist. */
  readonly settings: ReadonlyMap<string, string>;
}

export interface MailHealthSource {
  read(windowStart: Date, correlationId: string): Promise<MailHealthCounts>;
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const MAIL_SETTING_KEYS: readonly string[] = [
  ...MAILBOXES.map((mailbox) => mailboxCeilingSettingKey(mailbox)),
  ...MAIL_LANES.map((lane: MailLane) => lanePausedSettingKey(lane)),
];

export class MailHealthRepository implements MailHealthSource {
  constructor(private readonly database: TenantDatabase) {}

  async read(windowStart: Date, correlationId: string): Promise<MailHealthCounts> {
    return this.database.identityRead(
      { correlationId, tables: ['mail_queue', 'mail_hour_windows', 'platform_settings'] },
      async (db) => {
        const pending = new Map<string, number>();
        for (const row of await db.query<Row[]>(SQL.byLaneAndStatus, [])) {
          pending.set(`${String(row['lane'])}:${String(row['status'])}`, num(row['n']));
        }
        const sent = new Map<string, number>();
        for (const row of await db.query<Row[]>(SQL.sentThisHour, [windowStart])) {
          sent.set(`${String(row['lane'])}:${String(row['mailbox'])}`, num(row['n']));
        }
        const windows = new Map<Mailbox, number>();
        for (const row of await db.query<Row[]>(SQL.windows, [windowStart])) {
          const mailbox = String(row['mailbox']);
          if (mailbox === 'security' || mailbox === 'noreply') windows.set(mailbox, num(row['n']));
        }
        const settings = new Map<string, string>();
        const keys = [...MAIL_SETTING_KEYS];
        for (const row of await db.query<Row[]>(SQL.settings(keys.length), keys)) {
          settings.set(String(row['setting_key']), String(row['setting_value'] ?? ''));
        }
        return { pending, sent, windows, settings };
      },
    );
  }
}
