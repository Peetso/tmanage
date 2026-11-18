import type { RowDataPacket } from 'mysql2';
import { uuidv7 } from '@tmanage/domain';
import type {
  BootstrapQueryRunner,
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { isPricingBand } from './pricing-survey.rules.js';
import type { PricingBand, PricingSurveyOutcome } from './pricing-survey.rules.js';

/**
 * 57-17 WTP — every statement over `pricing_survey_answers` (migration 0375).
 *
 * - Tenant path: the card's reads and the one INSERT. Each statement names the context's
 *   `organization_id`; the membership is always the acting one (never read from input).
 * - Bootstrap path: the Platform admin list, a read-only cross-organization SELECT over the two
 *   declared tables (`pricing_survey_answers`, `organizations`), at most
 *   {@link MAX_LISTED_ANSWERS} rows. No person's name, e-mail or id leaves the database.
 */

export const MAX_LISTED_ANSWERS = 200;

export const PRICING_SURVEY_LIST_REASON =
  'platform pricing answers (57-17): the TManage operator reads the willingness-to-pay answers ' +
  'owners and admins chose to send, with the workspace name only, never a person';

export const PRICING_SURVEY_BOOTSTRAP_TABLES = ['pricing_survey_answers', 'organizations'] as const;

/** MariaDB/MySQL duplicate-key error: the one-answer-per-person unique key fired. */
const ER_DUP_ENTRY = 1062;

export function isDuplicateAnswer(error: unknown): boolean {
  const marks = (candidate: unknown) =>
    typeof candidate === 'object' &&
    candidate !== null &&
    ((candidate as { errno?: number }).errno === ER_DUP_ENTRY ||
      (candidate as { code?: string }).code === 'ER_DUP_ENTRY');
  return (
    marks(error) ||
    (typeof error === 'object' && error !== null && marks((error as { cause?: unknown }).cause))
  );
}

export interface PricingSurveyState {
  /** When the workspace was created; `null` if the row could not be read. */
  readonly workspaceCreatedAt: Date | null;
  /** Has the acting membership already answered or skipped? */
  readonly alreadyResponded: boolean;
}

export interface PricingAnswerRecord {
  readonly organizationName: string | null;
  readonly outcome: PricingSurveyOutcome;
  readonly band: PricingBand | null;
  readonly note: string | null;
  readonly answeredAt: Date;
}

type Row = RowDataPacket & Record<string, unknown>;

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export class PricingSurveyRepository {
  async readState(runner: TenantQueryRunner, context: TenantContext): Promise<PricingSurveyState> {
    const workspace = await runner.execute<QueryRows>(
      'select o.created_at as created_at from organizations o where o.id = ? limit 1',
      [context.organizationId],
    );
    const answered = await runner.execute<QueryRows>(
      `select psa.id as id from pricing_survey_answers psa
        where psa.organization_id = ? and psa.membership_id = ?
        limit 1`,
      [context.organizationId, context.membershipId],
    );
    return {
      workspaceCreatedAt: date(workspace[0]?.['created_at']),
      alreadyResponded: answered.length > 0,
    };
  }

  /** One row per person per workspace; a second insert fails on the unique key. */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    answer: {
      readonly outcome: PricingSurveyOutcome;
      readonly band: PricingBand | null;
      readonly note: string | null;
      readonly answeredAt: Date;
    },
  ): Promise<void> {
    await runner.execute(
      `insert into pricing_survey_answers
         (id, organization_id, membership_id, outcome, band, note, answered_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv7(),
        context.organizationId,
        context.membershipId,
        answer.outcome,
        answer.band,
        answer.note,
        answer.answeredAt,
      ],
    );
  }

  /** Platform bootstrap path only: the newest answers and skips across workspaces. */
  async listAcrossOrganizations(
    runner: BootstrapQueryRunner,
  ): Promise<readonly PricingAnswerRecord[]> {
    const rows = await runner.query<Row[]>(
      `select o.name as organization_name, psa.outcome as outcome, psa.band as band,
              psa.note as note, psa.answered_at as answered_at
         from pricing_survey_answers psa
         join organizations o on o.id = psa.organization_id
        order by psa.answered_at desc
        limit ${String(MAX_LISTED_ANSWERS)}`,
    );
    return rows.map((row) => ({
      organizationName: row['organization_name'] == null ? null : String(row['organization_name']),
      outcome: row['outcome'] === 'answered' ? 'answered' : 'skipped',
      band: isPricingBand(row['band']) ? row['band'] : null,
      note: row['note'] == null ? null : String(row['note']),
      answeredAt: date(row['answered_at']) ?? new Date(0),
    }));
  }
}
