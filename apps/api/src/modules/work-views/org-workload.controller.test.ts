import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { OrgWorkloadController } from './org-workload.controller.js';
import type { OrgWorkloadService } from './org-workload.service.js';

/** 53-08 part 2a (R21-a) — the route ceiling and the query pass-through. */

describe('GET …/work-views/workload', () => {
  it('sits behind work.read', () => {
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, OrgWorkloadController.prototype.grid)).toBe(
      'work.read',
    );
  });

  it('passes scope, window and cursor to the service', async () => {
    let seen: unknown;
    const service = {
      grid: async (_c: unknown, _p: unknown, query: unknown) => {
        seen = query;
        return {} as never;
      },
    } as unknown as OrgWorkloadService;
    await new OrgWorkloadController(service).grid(
      {} as TenantContext,
      {} as Principal,
      'org',
      '2026-11-02',
      '2026-11-08',
      'm-049',
    );
    expect(seen).toEqual({ scope: 'org', from: '2026-11-02', to: '2026-11-08', cursor: 'm-049' });
  });
});
