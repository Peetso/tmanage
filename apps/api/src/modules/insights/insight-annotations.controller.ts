import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { InsightSnapshotsRepository } from './snapshots.repository.js';
import { InsightAnnotationsRepository } from './insight-annotations.repository.js';
import { InsightAnnotationsService } from './insight-annotations.service.js';
import type { InsightAnnotationView } from './insight-annotations.service.js';

/** DI token for the annotations service, owned by this slice (registered in `app.module.ts`). */
export const INSIGHT_ANNOTATIONS_SERVICE = Symbol.for('tmanage.InsightAnnotationsService');

/** The longest an annotation note may be — prose, not an essay. Over this is a 400, nothing written. */
const MAX_NOTE_LENGTH = 2000;

/**
 * x271's HTTP surface — insight annotations (module 15, Insights & reporting). An explanatory note
 * attached to an insight snapshot so a frozen figure carries context (INS-01 "every score is
 * explainable"). Three routes under `/v1/organizations/:orgSlug/insights/snapshots/:snapshotId/
 * annotations`, all behind `work.read` — the internal-read capability the sibling insights slices
 * reuse, so this slice needs no new capability and no `capabilities.ts` / role-grid edit. It is a
 * separate controller and module from x211's `InsightSnapshotsController`, disjoint by file so the
 * insights slices land in parallel (it never edits the snapshots controller — it soft-reads the
 * snapshot in the service).
 *
 * Validation lives here, not in the store: an empty or over-long note is the client's error to be told
 * about (400), never a state the store should hold, so nothing is written when it is rejected. The
 * snapshot is resolved tenant-scoped in the service before the relation authorize, so a cross-tenant
 * or unknown snapshot is a 404; a delete of another author's note is a 403 (the mandated refusal).
 */
@Controller('v1/organizations/:orgSlug/insights/snapshots/:snapshotId/annotations')
export class InsightAnnotationsController {
  constructor(
    @Inject(INSIGHT_ANNOTATIONS_SERVICE) private readonly annotations: InsightAnnotationsService,
  ) {}

  /** List one snapshot's annotations, newest first. Unknown snapshot → 404. */
  @Get()
  @RequireCapability('report.view')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('snapshotId') snapshotId: string,
  ): Promise<{ readonly annotations: readonly InsightAnnotationView[] }> {
    requireId(snapshotId, 'snapshotId');
    return { annotations: await this.annotations.list(context, principal, snapshotId) };
  }

  /** Attach a note to a snapshot, authored by the caller (201). Empty/over-long note → 400. */
  @Post()
  @RequireCapability('report.view')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('snapshotId') snapshotId: string,
    @Body() body: unknown,
  ): Promise<InsightAnnotationView> {
    requireId(snapshotId, 'snapshotId');
    const note = parseNote(body);
    return this.annotations.add(context, principal, snapshotId, note);
  }

  /**
   * Delete one of the caller's own annotations (204). An unknown annotation is a 404; one authored by
   * another member is a 403, with no delete.
   */
  @Delete(':annotationId')
  @RequireCapability('report.view')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('snapshotId') snapshotId: string,
    @Param('annotationId') annotationId: string,
  ): Promise<void> {
    requireId(snapshotId, 'snapshotId');
    requireId(annotationId, 'annotationId');
    await this.annotations.remove(context, principal, snapshotId, annotationId);
  }
}

/** Reject a missing/empty path id with a 400 before any resolution. */
function requireId(value: string, field: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(400, 'validation_failed', `${field} is required`, [
      { field, message: 'must be a non-empty string' },
    ]);
  }
}

/**
 * Validate a create body into a well-formed note: a non-empty string of at most {@link MAX_NOTE_LENGTH}
 * characters (trimmed). Any violation is a 400 and nothing is written.
 */
function parseNote(body: unknown): string {
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const raw = value['note'];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ApiError(400, 'validation_failed', 'The annotation is invalid', [
      { field: 'note', message: 'must be a non-empty string' },
    ]);
  }
  if (raw.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The annotation is invalid', [
      { field: 'note', message: `must be at most ${MAX_NOTE_LENGTH} characters` },
    ]);
  }
  return raw.trim();
}

/**
 * x271's wiring — a self-contained module registered from `app.module.ts` (the shared append point)
 * rather than folded into x211's `InsightSnapshotsModule`, so the insights slices stay file-disjoint.
 * The service constructs its own repository and a read-only `InsightSnapshotsRepository` (to resolve
 * the parent snapshot tenant-scoped before it acts), and takes the `@Global` `TENANT_DATABASE` for its
 * tenant-scoped reads and writes.
 */
@Module({})
export class InsightAnnotationsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: INSIGHT_ANNOTATIONS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new InsightAnnotationsService(
          database,
          new InsightAnnotationsRepository(),
          new InsightSnapshotsRepository(),
        ),
    };

    return {
      module: InsightAnnotationsModule,
      providers: [service],
      controllers: [InsightAnnotationsController],
    };
  }
}
