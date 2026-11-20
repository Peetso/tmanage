import type { TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * LANE-Q — `walkthrough_requests` (0388), GLOBAL: reached only through `identityTransaction` over
 * the one table. Dates are bound from the application clock (never the session's clock).
 */

export interface WalkthroughRecord {
  readonly id: string;
  readonly reference: string;
  readonly name: string;
  readonly emailEnc: string | null;
  readonly company: string;
  readonly teamSize: string;
  readonly timeZone: string;
  readonly slots: string;
  readonly topics: string;
  readonly language: string;
  readonly source: string | null;
  readonly riskDecision: 'allow' | 'hold';
  readonly consentAt: Date;
  readonly createdAt: Date;
}

/** What the service needs from storage; the unit tests hand in a fake. */
export interface WalkthroughStore {
  insert(record: WalkthroughRecord, correlationId: string): Promise<void>;
  markNotified(id: string, at: Date, correlationId: string): Promise<void>;
}

const TABLE = ['walkthrough_requests'] as const;

export class WalkthroughRepository implements WalkthroughStore {
  constructor(private readonly database: TenantDatabase) {}

  async insert(record: WalkthroughRecord, correlationId: string): Promise<void> {
    await this.database.identityTransaction({ correlationId, tables: [...TABLE] }, (tx) =>
      tx.query(
        `insert into walkthrough_requests (id, reference, name, email_enc, company, team_size,
           time_zone, slots, topics, language, source, risk_decision, consent_at, notified_at,
           created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)`,
        [
          record.id,
          record.reference,
          record.name,
          record.emailEnc,
          record.company,
          record.teamSize,
          record.timeZone,
          record.slots,
          record.topics,
          record.language,
          record.source,
          record.riskDecision,
          record.consentAt,
          record.createdAt,
        ],
      ),
    );
  }

  async markNotified(id: string, at: Date, correlationId: string): Promise<void> {
    await this.database.identityTransaction({ correlationId, tables: [...TABLE] }, (tx) =>
      tx.query(
        'update walkthrough_requests set notified_at = ? where id = ? and notified_at is null',
        [at, id],
      ),
    );
  }
}
