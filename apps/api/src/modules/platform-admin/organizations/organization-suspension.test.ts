import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ensureRequestState } from '../../../common/http/request-state.js';
import { TenantContextGuard } from '../../../common/http/guards/tenant-context.guard.js';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import {
  MembershipResolver,
  SUSPENDED_MESSAGE,
} from '../../tenancy/membership-resolver.repository.js';
import type { PrincipalRepository } from '../../tenancy/principal.repository.js';

/** A suspended company stops its members — the owner included — at the tenant guard. */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const USER = '0199aa00-0000-7000-8000-0000000000a1';
const CORRELATION = '0199aa00-0000-7000-8000-0000000000e9';

function guardOver(suspendedAt: string | null) {
  let call = 0;
  // The internal-membership query returns one owner row (positional, as Drizzle asks); client none.
  const runner = {
    query: async (sql: string) => {
      // PA-01's once-per-process probe for `organizations.deleted_at` (0243): answer "no column".
      if (/limit 0/iu.test(sql)) throw Object.assign(new Error('unknown column'), { errno: 1054 });
      return ++call === 1 ? [[ORG, 1, ORG, 'owner', 1, 1, null, suspendedAt]] : [];
    },
  };
  const database = {
    bootstrapRead: async <T>(_o: unknown, work: (db: unknown) => Promise<T>) => work(runner),
    // PA-01's live-overrides read (none) runs through `read`; anything else answers `{}` as before.
    read: async <T>(_c: unknown, work?: (db: unknown) => Promise<T>) =>
      work ? work({ query: async () => [] }) : ({} as T),
  } as unknown as TenantDatabase;
  const guard = new TenantContextGuard(
    new Reflector(),
    new MembershipResolver(database),
    { load: async () => ({}) } as unknown as PrincipalRepository,
    database,
  );
  const request = { params: { orgSlug: 'northstar' }, headers: {} };
  const state = ensureRequestState(request);
  Object.assign(state, { correlationId: CORRELATION, session: { sessionId: 's', userId: USER } });
  class Route {
    handle(): void {}
  }
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => Route.prototype.handle,
    getClass: () => Route,
  } as unknown as ExecutionContext;
  return guard.canActivate(context);
}

describe('organization suspension', () => {
  it('lets members of an active company in', async () => {
    await expect(guardOver(null)).resolves.toBe(true);
  });

  it('refuses even the owner of a suspended company with the suspended message', async () => {
    await expect(guardOver('2026-10-18 10:00:00.000')).rejects.toMatchObject({
      status: 403,
      message: SUSPENDED_MESSAGE,
    });
  });
});
