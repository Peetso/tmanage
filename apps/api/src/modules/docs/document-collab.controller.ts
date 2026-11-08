import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { CollabPush } from './document-collab.authority.js';
import type {
  CollabJoinResult,
  CollabPollResult,
  DocumentCollabService,
} from './document-collab.service.js';

export const DOCUMENT_COLLAB_SERVICE = Symbol.for('tmanage.DocumentCollabService');

/** The longest HTML a snapshot may carry — the same ceiling as a saved version body. */
const MAX_SNAPSHOT_LENGTH = 1_000_000;

/**
 * Slice 53-10 — `…/documents/:documentId/collab` (Figma 586:33239). `GET` joins (base + steps +
 * the caller's role and colour), `GET steps?since=` polls, `POST steps` appends, `POST snapshot`
 * persists, `PUT cursor` shows where the caller is. Reads are `doc.read`; writes are `doc.write`
 * and the service adds the per-project relation check, so a viewer is read-only.
 */
@Controller('v1/organizations/:orgSlug/documents/:documentId/collab')
export class DocumentCollabController {
  constructor(@Inject(DOCUMENT_COLLAB_SERVICE) private readonly collab: DocumentCollabService) {}

  @Get()
  @RequireCapability('doc.read')
  async join(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<CollabJoinResult> {
    return this.collab.join(context, principal, requireText(documentId, 'documentId'));
  }

  @Get('steps')
  @RequireCapability('doc.read')
  async poll(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Query('since') since?: string,
  ): Promise<CollabPollResult> {
    const version = Number(since);
    if (since === undefined || !/^\d+$/.test(since) || !Number.isSafeInteger(version)) {
      throw invalid('since', 'must be a non-negative integer');
    }
    return this.collab.poll(context, principal, requireText(documentId, 'documentId'), version);
  }

  @Post('steps')
  @RequireCapability('doc.write')
  @HttpCode(200)
  async push(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Body() body: { version?: unknown; clientId?: unknown; steps?: unknown },
  ): Promise<CollabPush> {
    if (!Array.isArray(body?.steps)) throw invalid('steps', 'must be an array');
    return this.collab.push(context, principal, requireText(documentId, 'documentId'), {
      version: requireVersion(body?.version),
      clientId: requireText(body?.clientId, 'clientId'),
      steps: body.steps as unknown[],
    });
  }

  @Post('snapshot')
  @RequireCapability('doc.write')
  @HttpCode(200)
  async snapshot(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('orgSlug') orgSlug: string,
    @Param('documentId') documentId: string,
    @Body() body: { version?: unknown; html?: unknown },
  ): Promise<{ readonly saved: boolean; readonly version: number }> {
    const html = body?.html;
    if (typeof html !== 'string' || html === '' || html.length > MAX_SNAPSHOT_LENGTH) {
      throw invalid('html', `must be a non-empty string of ${MAX_SNAPSHOT_LENGTH} or fewer`);
    }
    return this.collab.snapshot(context, principal, requireText(documentId, 'documentId'), {
      version: requireVersion(body?.version),
      html,
      orgSlug,
    });
  }

  @Put('cursor')
  @RequireCapability('doc.write')
  @HttpCode(204)
  async cursor(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Body() body: { clientId?: unknown; anchor?: unknown; head?: unknown },
  ): Promise<void> {
    await this.collab.cursor(context, principal, requireText(documentId, 'documentId'), {
      clientId: requireText(body?.clientId, 'clientId'),
      anchor: requireVersion(body?.anchor, 'anchor'),
      head: requireVersion(body?.head, 'head'),
    });
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 100) {
    throw invalid(field, 'must be a non-empty string of 100 characters or fewer');
  }
  return value;
}

function requireVersion(value: unknown, field = 'version'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(field, 'must be a non-negative integer');
  }
  return value;
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}
