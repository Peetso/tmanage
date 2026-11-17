import { and, asc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientJourneySteps,
  clientMemberships,
  meetingClientAttendees,
  meetings,
  projectClients,
  signatureRequestSigners,
  signatureRequests,
  uploadSessions,
  workForms,
} from '../../common/database/schema.js';
import type { ClientJourneyStepKind, ClientJourneyStepRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { JourneyEvidence } from './portal-journey.js';

export interface NewJourneyStep {
  readonly projectId: string;
  readonly clientOrganizationId: string;
  readonly kind: ClientJourneyStepKind;
  readonly title: string;
  readonly refId: string | null;
}

export interface JourneyStepChange {
  readonly title?: string;
  readonly refId?: string | null;
}

/**
 * 52-27 — `client_journey_steps` (0363) and the evidence a step is done by.
 *
 * Every method takes the unit of work and the `TenantContext` first and puts the tenant predicate
 * on every statement and every joined table; `organization_id` always comes from the context. The
 * evidence reads are filtered by the project **and** the client organization, so a step is never
 * completed by another client's signature, acceptance or upload.
 */
export class JourneyStepsRepository {
  /** One client's steps on one project, in path order. */
  async listForClient(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    clientOrganizationId: string,
  ): Promise<readonly ClientJourneyStepRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(clientJourneySteps)
      .where(
        and(
          eq(clientJourneySteps.organizationId, context.organizationId),
          eq(clientJourneySteps.projectId, projectId),
          eq(clientJourneySteps.clientOrganizationId, clientOrganizationId),
        ),
      )
      .orderBy(asc(clientJourneySteps.sequence));
  }

  /** Every client's steps on one project (the studio's view), grouped by client, in path order. */
  async listForProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly ClientJourneyStepRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(clientJourneySteps)
      .where(
        and(
          eq(clientJourneySteps.organizationId, context.organizationId),
          eq(clientJourneySteps.projectId, projectId),
        ),
      )
      .orderBy(asc(clientJourneySteps.clientOrganizationId), asc(clientJourneySteps.sequence));
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    stepId: string,
  ): Promise<ClientJourneyStepRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(clientJourneySteps)
      .where(
        and(
          eq(clientJourneySteps.organizationId, context.organizationId),
          eq(clientJourneySteps.id, stepId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Append steps after the client's last one; `uq_client_journey_steps_order` backs a race. */
  async append(
    runner: TenantQueryRunner,
    context: TenantContext,
    steps: readonly NewJourneyStep[],
  ): Promise<readonly string[]> {
    const first = steps[0];
    if (!first) return [];
    const [last] = await tenantDrizzle(runner)
      .select({ sequence: max(clientJourneySteps.sequence) })
      .from(clientJourneySteps)
      .where(
        and(
          eq(clientJourneySteps.organizationId, context.organizationId),
          eq(clientJourneySteps.projectId, first.projectId),
          eq(clientJourneySteps.clientOrganizationId, first.clientOrganizationId),
        ),
      );
    const start = (last?.sequence ?? 0) + 1;
    const ids = steps.map(() => uuidv7());
    await tenantDrizzle(runner)
      .insert(clientJourneySteps)
      .values(
        steps.map((step, index) => ({
          id: ids[index] ?? uuidv7(),
          organizationId: context.organizationId,
          projectId: step.projectId,
          clientOrganizationId: step.clientOrganizationId,
          sequence: start + index,
          kind: step.kind,
          title: step.title,
          refId: step.refId,
          evidenceId: null,
          createdBy: context.userId,
          createdAt: sql`current_timestamp(3)`,
          updatedAt: sql`current_timestamp(3)`,
        })),
      );
    return ids;
  }

  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    stepId: string,
    change: JourneyStepChange,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(clientJourneySteps)
      .set({
        ...(change.title === undefined ? {} : { title: change.title }),
        ...(change.refId === undefined ? {} : { refId: change.refId }),
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(clientJourneySteps.organizationId, context.organizationId),
          eq(clientJourneySteps.id, stepId),
        ),
      );
  }

  /**
   * Record the stored form submission on a form step, once: the `evidence_id IS NULL` predicate
   * makes a second submit a no-op, so the answer is whether this call recorded it.
   */
  async recordFormEvidence(
    runner: TenantQueryRunner,
    context: TenantContext,
    stepId: string,
    submissionId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(clientJourneySteps)
      .set({ evidenceId: submissionId, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(clientJourneySteps.organizationId, context.organizationId),
          eq(clientJourneySteps.id, stepId),
          eq(clientJourneySteps.kind, 'form'),
          isNull(clientJourneySteps.evidenceId),
        ),
      );
    return result[0].affectedRows > 0;
  }

  async remove(runner: TenantQueryRunner, context: TenantContext, stepId: string): Promise<void> {
    await tenantDrizzle(runner)
      .delete(clientJourneySteps)
      .where(
        and(
          eq(clientJourneySteps.organizationId, context.organizationId),
          eq(clientJourneySteps.id, stepId),
        ),
      );
  }

  /** Whether the project is shared with this client (the step's foreign key, checked first). */
  async isProjectClient(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    clientOrganizationId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: projectClients.id })
      .from(projectClients)
      .where(
        and(
          eq(projectClients.organizationId, context.organizationId),
          eq(projectClients.projectId, projectId),
          eq(projectClients.clientOrganizationId, clientOrganizationId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Whether `refId` names an object a step of `kind` may point at: a work form of this studio, or
   * a signature request or meeting on this project. An upload step names nothing.
   */
  async refBelongs(
    runner: TenantQueryRunner,
    context: TenantContext,
    kind: ClientJourneyStepKind,
    refId: string,
    projectId: string,
  ): Promise<boolean> {
    const db = tenantDrizzle(runner);
    switch (kind) {
      case 'upload':
        return false;
      case 'form': {
        const rows = await db
          .select({ id: workForms.id })
          .from(workForms)
          .where(and(eq(workForms.organizationId, context.organizationId), eq(workForms.id, refId)))
          .limit(1);
        return rows.length > 0;
      }
      case 'sign': {
        const rows = await db
          .select({ id: signatureRequests.id })
          .from(signatureRequests)
          .where(
            and(
              eq(signatureRequests.organizationId, context.organizationId),
              eq(signatureRequests.id, refId),
              eq(signatureRequests.projectId, projectId),
            ),
          )
          .limit(1);
        return rows.length > 0;
      }
      case 'meeting': {
        const rows = await db
          .select({ id: meetings.id })
          .from(meetings)
          .where(
            and(
              eq(meetings.organizationId, context.organizationId),
              eq(meetings.id, refId),
              eq(meetings.projectId, projectId),
            ),
          )
          .limit(1);
        return rows.length > 0;
      }
    }
  }

  /**
   * The evidence for one client's steps on one project: completed requests a person of this
   * client signed, meetings a person of this client accepted, and this client's latest completed
   * upload. Each read is bounded by the project and the client organization.
   */
  async evidence(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    clientOrganizationId: string,
    steps: readonly ClientJourneyStepRow[],
  ): Promise<JourneyEvidence> {
    const db = tenantDrizzle(runner);
    const refsOf = (kind: ClientJourneyStepKind): string[] =>
      steps.flatMap((step) => (step.kind === kind && step.refId !== null ? [step.refId] : []));
    const signRefs = refsOf('sign');
    const meetingRefs = refsOf('meeting');

    const signed =
      signRefs.length === 0
        ? []
        : await db
            .select({ id: signatureRequests.id })
            .from(signatureRequests)
            .innerJoin(
              signatureRequestSigners,
              and(
                eq(signatureRequestSigners.organizationId, signatureRequests.organizationId),
                eq(signatureRequestSigners.requestId, signatureRequests.id),
              ),
            )
            .where(
              and(
                eq(signatureRequests.organizationId, context.organizationId),
                eq(signatureRequestSigners.organizationId, context.organizationId),
                eq(signatureRequests.projectId, projectId),
                inArray(signatureRequests.id, signRefs),
                eq(signatureRequests.status, 'completed'),
                eq(signatureRequestSigners.clientOrganizationId, clientOrganizationId),
                eq(signatureRequestSigners.status, 'signed'),
              ),
            );

    const accepted =
      meetingRefs.length === 0
        ? []
        : await db
            .select({ id: meetingClientAttendees.meetingId })
            .from(meetingClientAttendees)
            .innerJoin(
              clientMemberships,
              and(
                eq(clientMemberships.organizationId, meetingClientAttendees.organizationId),
                eq(clientMemberships.id, meetingClientAttendees.clientMembershipId),
              ),
            )
            .innerJoin(
              meetings,
              and(
                eq(meetings.organizationId, meetingClientAttendees.organizationId),
                eq(meetings.id, meetingClientAttendees.meetingId),
              ),
            )
            .where(
              and(
                eq(meetingClientAttendees.organizationId, context.organizationId),
                eq(clientMemberships.organizationId, context.organizationId),
                eq(meetings.organizationId, context.organizationId),
                eq(meetings.projectId, projectId),
                inArray(meetingClientAttendees.meetingId, meetingRefs),
                eq(meetingClientAttendees.rsvp, 'accepted'),
                eq(clientMemberships.clientOrganizationId, clientOrganizationId),
              ),
            );

    const upload = steps.some((step) => step.kind === 'upload')
      ? await db
          .select({ at: max(uploadSessions.completedAt) })
          .from(uploadSessions)
          .where(
            and(
              eq(uploadSessions.organizationId, context.organizationId),
              eq(uploadSessions.projectId, projectId),
              eq(uploadSessions.clientOrganizationId, clientOrganizationId),
              eq(uploadSessions.status, 'completed'),
            ),
          )
      : [];

    return {
      signedRequestIds: new Set(signed.map((row) => row.id)),
      acceptedMeetingIds: new Set(accepted.map((row) => row.id)),
      lastUploadAt: upload[0]?.at ?? null,
    };
  }
}
