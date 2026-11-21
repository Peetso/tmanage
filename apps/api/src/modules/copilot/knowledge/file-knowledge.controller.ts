import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../../common/http/decorators.js';
import { ApiError } from '../../../common/http/errors.js';
import type { TenantContext } from '../../../common/database/tenant-context.js';
import type { FileKnowledgeService, FileKnowledgeView } from './file-knowledge.js';
import { MAX_PASSAGE_QUERY_LENGTH } from './knowledge.controller.js';

export const FILE_KNOWLEDGE_SERVICE = Symbol.for('tmanage.FileKnowledgeService');

/**
 * 62-25 — `GET …/knowledge/files/:fileAssetId?q=`: one file as the AI may read it for a question
 * (`file-knowledge.ts`): its text state, the cached summary of its bytes, and the text or the
 * passages that answer `q`. Behind `search.use` like the passage route; a file the member cannot
 * open is 404. A read op of the AI registry (`knowledge.files.get`), so the chat reaches it through
 * the member's own route; its result is text other people wrote and is marked untrusted there.
 */
@Controller('v1/organizations/:orgSlug/knowledge')
export class FileKnowledgeController {
  constructor(@Inject(FILE_KNOWLEDGE_SERVICE) private readonly files: FileKnowledgeService) {}

  @Get('files/:fileAssetId')
  @RequireCapability('search.use')
  async file(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileAssetId') fileAssetId: string,
    @Query('q') q?: string,
  ): Promise<FileKnowledgeView> {
    const question = typeof q === 'string' ? q.trim() : '';
    if ([...question].length > MAX_PASSAGE_QUERY_LENGTH) {
      throw new ApiError(
        400,
        'validation_failed',
        `q must be ${String(MAX_PASSAGE_QUERY_LENGTH)} characters or fewer`,
        [{ field: 'q', message: `${String(MAX_PASSAGE_QUERY_LENGTH)} characters or fewer` }],
      );
    }
    return this.files.view(context, principal, fileAssetId, question === '' ? null : question);
  }
}
