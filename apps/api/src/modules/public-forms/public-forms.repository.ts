import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { formSubmissions, workForms } from '../../common/database/schema.js';
import type {
  FormSubmissionRow,
  FormSubmissionState,
  WorkFormRow,
} from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 52-20 — `work_forms`' public columns and `form_submissions` (0258).
 *
 * Every method but {@link PublicFormsRepository.findPublishedBySlug} takes the unit of work and the
 * `TenantContext`, and puts the tenant predicate on every statement. The slug lookup is the one
 * pre-context read: it runs on `bootstrapRead(['work_forms'])`, returns only the form's
 * `(organization_id, id)`, and the caller re-reads the form under a service context for that
 * organization — the organization always comes from the form row, never from the request.
 */

export interface NewSubmission {
  readonly formId: string;
  readonly reference: string;
  readonly valuesJson: string;
  readonly language: string | null;
  readonly state: FormSubmissionState;
  readonly riskDecision: string;
  readonly riskScore: number;
  readonly riskReasons: string | null;
}

export interface ListSubmissionsOptions {
  readonly state?: FormSubmissionState;
  /** Keyset cursor: the last row of the previous page. */
  readonly before?: { readonly createdAt: Date; readonly id: string };
  readonly limit: number;
}

export class PublicFormsRepository {
  async findPublishedBySlug(
    runner: BootstrapQueryRunner,
    slug: string,
  ): Promise<{ readonly organizationId: string; readonly id: string } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ organizationId: workForms.organizationId, id: workForms.id })
      .from(workForms)
      .where(and(eq(workForms.publicSlug, slug), eq(workForms.publicEnabled, true)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findForm(
    runner: TenantQueryRunner,
    context: TenantContext,
    formId: string,
  ): Promise<WorkFormRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workForms)
      .where(and(eq(workForms.organizationId, context.organizationId), eq(workForms.id, formId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Publish (keeping an existing slug, or setting `slug`) or unpublish one form. */
  async setPublic(
    runner: TenantQueryRunner,
    context: TenantContext,
    formId: string,
    change: { readonly enabled: boolean; readonly slug?: string },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(workForms)
      .set({
        publicEnabled: change.enabled,
        ...(change.slug === undefined ? {} : { publicSlug: change.slug }),
        ...(change.enabled ? { publishedAt: sql`current_timestamp(3)` } : {}),
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(and(eq(workForms.organizationId, context.organizationId), eq(workForms.id, formId)));
  }

  async insertSubmission(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: NewSubmission,
    at: Date,
  ): Promise<string> {
    const id = uuidv7();
    await tenantDrizzle(runner).insert(formSubmissions).values({
      id,
      organizationId: context.organizationId,
      formId: input.formId,
      reference: input.reference,
      valuesJson: input.valuesJson,
      language: input.language,
      state: input.state,
      riskDecision: input.riskDecision,
      riskScore: input.riskScore,
      riskReasons: input.riskReasons,
      createdAt: at,
    });
    return id;
  }

  /** Newest first, bounded, optionally one state; keyset over `(created_at, id)`. */
  async listSubmissions(
    runner: TenantQueryRunner,
    context: TenantContext,
    formId: string,
    options: ListSubmissionsOptions,
  ): Promise<readonly FormSubmissionRow[]> {
    const predicates = [
      eq(formSubmissions.organizationId, context.organizationId),
      eq(formSubmissions.formId, formId),
    ];
    if (options.state !== undefined) predicates.push(eq(formSubmissions.state, options.state));
    if (options.before !== undefined) {
      const cursor = or(
        lt(formSubmissions.createdAt, options.before.createdAt),
        and(
          eq(formSubmissions.createdAt, options.before.createdAt),
          lt(formSubmissions.id, options.before.id),
        ),
      );
      if (cursor !== undefined) predicates.push(cursor);
    }
    return tenantDrizzle(runner)
      .select()
      .from(formSubmissions)
      .where(and(...predicates))
      .orderBy(desc(formSubmissions.createdAt), desc(formSubmissions.id))
      .limit(options.limit);
  }

  async findSubmission(
    runner: TenantQueryRunner,
    context: TenantContext,
    formId: string,
    submissionId: string,
  ): Promise<FormSubmissionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(formSubmissions)
      .where(
        and(
          eq(formSubmissions.organizationId, context.organizationId),
          eq(formSubmissions.formId, formId),
          eq(formSubmissions.id, submissionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Move one submission from one of `from` to a new state — a compare-and-set, so two triagers
   * racing on the same row get exactly one winner (`1`) and one loser (`0`).
   */
  async transition(
    runner: TenantQueryRunner,
    context: TenantContext,
    submissionId: string,
    from: readonly FormSubmissionState[],
    to: {
      readonly state: FormSubmissionState;
      readonly convertedBy?: string | null;
      readonly convertedAt?: Date | null;
      readonly createdWorkItemId?: string | null;
      readonly spamMarkedBy?: string | null;
    },
  ): Promise<number> {
    const { state, ...rest } = to;
    const result = await tenantDrizzle(runner)
      .update(formSubmissions)
      .set({ state, ...rest })
      .where(
        and(
          eq(formSubmissions.organizationId, context.organizationId),
          eq(formSubmissions.id, submissionId),
          inArray(formSubmissions.state, [...from]),
        ),
      );
    return result[0].affectedRows;
  }
}
