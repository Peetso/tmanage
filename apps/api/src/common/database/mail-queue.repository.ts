import { randomUUID } from 'node:crypto';
import type { MailQueueEntry, MailQueueWriter } from '@tmanage/mail';
import type { TenantDatabase } from './tenant-context.js';

/**
 * 56-31 — the API half of `mail_queue` (0256): enqueue one message. GLOBAL (NON_TENANT_TABLES),
 * so it runs through `identityTransaction(['mail_queue'])` like `email_suppressions`. INSERT is
 * the API credential's only privilege on the table (users.sql); the worker drainer does the rest.
 */
const INSERT_SQL = `insert into mail_queue
  (id, organization_id, lane, mailbox, to_hash, template_key, payload_json, status, attempts,
   available_at, deadline_at, created_at)
  values (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`;

export class MailQueueRepository implements MailQueueWriter {
  constructor(private readonly database: TenantDatabase) {}

  async enqueue(entry: MailQueueEntry): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: randomUUID(), tables: ['mail_queue'] },
      async (tx) => {
        await tx.query(INSERT_SQL, [
          entry.id,
          entry.organizationId,
          entry.lane,
          entry.mailbox,
          entry.toHash,
          entry.templateKey,
          entry.payloadJson,
          entry.availableAt,
          entry.deadlineAt,
          entry.createdAt,
        ]);
      },
    );
  }
}
