import { regionForTimezone } from '@tmanage/mail';
import type {
  MailLanguage,
  MailPerson,
  MailPersonRef,
  MailPersonRegion,
  SenderDirectory,
} from '@tmanage/mail';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

/**
 * EMAILBUILD — the worker's read of the people registry (0371): which TManage person signs a tip
 * to one user on one topic. The first tip on a topic picks the less-loaded active person of the
 * pair for the user's region and topic and remembers it (`mail_person_assignments`); every later
 * tip on that topic comes from the same person. A remembered person who was switched off is
 * replaced once by the other one of the pair. At most four small indexed statements per call;
 * the resolver caches the answer for 60 s.
 *
 * Grants (users.sql): SELECT on `platform_mail_people` and `organizations`; SELECT, INSERT,
 * UPDATE on `mail_person_assignments`.
 */

interface PersonRow {
  readonly id: string;
  readonly name_en: string;
  readonly name_ar: string;
  readonly role_en: string;
  readonly role_ar: string;
  readonly address: string;
  readonly active: number | boolean;
}

const PERSON_COLUMNS =
  'p.id AS id, p.name_en AS name_en, p.name_ar AS name_ar, p.role_en AS role_en, ' +
  'p.role_ar AS role_ar, p.address AS address, p.active AS active';

export const MAIL_PEOPLE_SQL = {
  assigned: `SELECT ${PERSON_COLUMNS} FROM mail_person_assignments a
      JOIN platform_mail_people p ON p.id = a.person_id
     WHERE a.organization_id = ? AND a.user_id = ? AND a.topic = ? LIMIT 1`,
  timezone: `SELECT o.timezone AS timezone FROM organizations o WHERE o.id = ? LIMIT 1`,
  // Two people per (region, topic): the count runs over the person_id index for two rows only.
  pick: `SELECT ${PERSON_COLUMNS},
       (SELECT COUNT(*) FROM mail_person_assignments x WHERE x.person_id = p.id) AS load_count
      FROM platform_mail_people p
     WHERE p.region = ? AND p.topic = ? AND p.active = 1
     ORDER BY load_count ASC, p.id ASC LIMIT 1`,
  insert: `INSERT IGNORE INTO mail_person_assignments
      (organization_id, user_id, topic, person_id, assigned_at) VALUES (?, ?, ?, ?, ?)`,
  reassign: `UPDATE mail_person_assignments SET person_id = ?, assigned_at = ?
     WHERE organization_id = ? AND user_id = ? AND topic = ? AND person_id = ?`,
} as const;

function toPerson(row: PersonRow, language: MailLanguage): MailPerson {
  return language === 'ar'
    ? { name: row.name_ar, role: row.role_ar, address: row.address }
    : { name: row.name_en, role: row.role_en, address: row.address };
}

const isActive = (row: PersonRow): boolean => row.active === true || Number(row.active) === 1;

async function first<T>(tx: WorkerTransaction, sql: string, params: readonly unknown[]) {
  const rows = await tx.query<readonly T[]>(sql, params);
  return rows[0];
}

export interface MailPeopleStoreOptions {
  readonly now?: () => Date;
}

export function createMailPeopleDirectory(
  database: WorkerDatabase,
  options: MailPeopleStoreOptions = {},
): SenderDirectory {
  const now = options.now ?? (() => new Date());
  return {
    async personFor(
      organizationId: string | undefined,
      ref: MailPersonRef,
      language: MailLanguage,
    ): Promise<MailPerson | null> {
      // The worker never sends a test mail; a test reference is the API's alone.
      if (organizationId === undefined || ref.kind !== 'assigned') return null;
      const { userId, topic } = ref;
      return database.transaction(async (tx) => {
        const kept = await first<PersonRow>(tx, MAIL_PEOPLE_SQL.assigned, [
          organizationId,
          userId,
          topic,
        ]);
        if (kept !== undefined && isActive(kept)) return toPerson(kept, language);
        const zone = await first<{ timezone: string | null }>(tx, MAIL_PEOPLE_SQL.timezone, [
          organizationId,
        ]);
        const region: MailPersonRegion = regionForTimezone(zone?.timezone, language);
        const pick = await first<PersonRow>(tx, MAIL_PEOPLE_SQL.pick, [region, topic]);
        if (pick === undefined) return null;
        const at = now();
        if (kept === undefined) {
          await tx.query(MAIL_PEOPLE_SQL.insert, [organizationId, userId, topic, pick.id, at]);
          // Insert-if-absent, then read back: a concurrent send that won keeps its person.
          const stored = await first<PersonRow>(tx, MAIL_PEOPLE_SQL.assigned, [
            organizationId,
            userId,
            topic,
          ]);
          return stored !== undefined && isActive(stored) ? toPerson(stored, language) : null;
        }
        await tx.query(MAIL_PEOPLE_SQL.reassign, [
          pick.id,
          at,
          organizationId,
          userId,
          topic,
          kept.id,
        ]);
        return toPerson(pick, language);
      });
    },
  };
}
