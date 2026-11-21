import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../../common/http/decorators.js';
import { ApiError } from '../../../common/http/errors.js';
import type { TenantContext } from '../../../common/database/tenant-context.js';
import { MAX_PASSAGES } from './knowledge-retrieval.js';
import type { KnowledgeRetrieval, Passage } from './knowledge-retrieval.js';

export const KNOWLEDGE_RETRIEVAL = Symbol.for('tmanage.KnowledgeRetrieval');

/** The search route's own query cap (`search.controller.ts`). */
export const MAX_PASSAGE_QUERY_LENGTH = 300;

/** One passage as the route answers it: the file's in-app path, never its storage key. */
export interface FilePassageView {
  readonly fileId: string;
  readonly fileName: string;
  readonly projectId: string;
  readonly pageNo: number | null;
  readonly href: string;
  readonly text: string;
}

export interface FilePassageListView {
  readonly passages: readonly FilePassageView[];
}

export function filePassageView(passage: Passage): FilePassageView {
  return {
    fileId: passage.fileId,
    fileName: passage.fileName,
    projectId: passage.projectId,
    pageNo: passage.pageNo,
    href: `/files/${encodeURIComponent(passage.fileId)}`,
    text: passage.text,
  };
}

function validation(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', `${field} ${message}`, [{ field, message }]);
}

/**
 * 62-24 — `GET …/knowledge/file-passages?q=&projectId=&limit=`: the passages of files the member
 * can open that best answer `q` (`knowledge-retrieval.ts`: filter before rank, hybrid rank,
 * re-check of every hit). Behind `search.use` like the global search. A `projectId` the member is
 * not on is 404, with no hint whether it exists. A read op of the AI registry
 * (`knowledge.file_passages.list`), so the chat reaches it through the member's own route; its
 * results are text other people wrote and are marked untrusted there.
 */
@Controller('v1/organizations/:orgSlug/knowledge')
export class KnowledgeController {
  constructor(@Inject(KNOWLEDGE_RETRIEVAL) private readonly retrieval: KnowledgeRetrieval) {}

  @Get('file-passages')
  @RequireCapability('search.use')
  async filePassages(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('q') q?: string,
    @Query('projectId') projectId?: string,
    @Query('limit') limit?: string,
  ): Promise<FilePassageListView> {
    const query = typeof q === 'string' ? q.trim() : '';
    if (query === '') throw validation('q', 'must be a non-empty string');
    if ([...query].length > MAX_PASSAGE_QUERY_LENGTH) {
      throw validation('q', `must be ${String(MAX_PASSAGE_QUERY_LENGTH)} characters or fewer`);
    }
    if (projectId !== undefined && (typeof projectId !== 'string' || projectId === '')) {
      throw validation('projectId', 'must be a non-empty string');
    }
    if (
      projectId !== undefined &&
      !principal.hasOrgWideScope &&
      !principal.projectIds.includes(projectId)
    ) {
      throw new ApiError(404, 'not_found', 'Not found.', undefined, 'project_not_visible');
    }
    const parsed = limit === undefined ? undefined : Number(limit);
    if (
      parsed !== undefined &&
      (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PASSAGES)
    ) {
      throw validation('limit', `must be an integer from 1 to ${String(MAX_PASSAGES)}`);
    }
    const passages = await this.retrieval.passages(context, principal, query, {
      ...(projectId === undefined ? {} : { projectId }),
      ...(parsed === undefined ? {} : { limit: parsed }),
    });
    return { passages: passages.map(filePassageView) };
  }
}
