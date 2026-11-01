import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationsService } from './conversations.service.js';
import { LinkPreviewsController } from './link-previews.controller.js';

/** R7 slice 5 — the read refuses more than 50 ids before it reaches the gate or the database. */
describe('LinkPreviewsController', () => {
  it('answers 400 for more than 50 message ids, touching nothing', async () => {
    let touched = false;
    const touch = () => {
      touched = true;
      throw new Error('touched');
    };
    const controller = new LinkPreviewsController(
      { get: touch } as unknown as ConversationsService,
      { read: touch } as unknown as TenantDatabase,
    );
    const ids = Array.from({ length: 51 }, (_, i) => `m${i}`).join(',');
    const call = controller.list({} as TenantContext, {} as Principal, 'c1', ids);
    await expect(call).rejects.toBeInstanceOf(ApiError);
    await expect(call).rejects.toMatchObject({ status: 400 });
    expect(touched).toBe(false);
  });
});
