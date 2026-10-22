import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MemberPasswordResetController } from './member-password-reset.controller.js';
import type { MemberResetMailer } from './member-password-reset.controller.js';
import type {
  MemberPasswordResetRepository,
  ResetMember,
} from './member-password-reset.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const context = {
  organizationId: ORG,
  membershipId: 'm0',
  userId: 'u0',
  correlationId: '00000000-0000-4000-8000-0000000000c1',
} as unknown as TenantContext;

const REASON = 'Locked out after a phone change';

function setup(rows: ResetMember[]) {
  const calls: string[] = [];
  const audits: unknown[] = [];
  const requested: unknown[] = [];
  const members = {
    findMember: (_r: unknown, c: TenantContext, id: string) =>
      Promise.resolve(
        c.organizationId === ORG ? (rows.find((m) => m.membershipId === id) ?? null) : null,
      ),
  } as unknown as MemberPasswordResetRepository;
  const database = {
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => {
      const result = await work({});
      calls.push('commit');
      return result;
    },
  } as unknown as TenantDatabase;
  const audit = {
    record: (_t: unknown, _c: unknown, e: unknown) => {
      calls.push('audit');
      audits.push(e);
      return Promise.resolve({});
    },
  } as unknown as AuditService;
  const resets: MemberResetMailer = {
    request: (email: unknown) => {
      calls.push('request');
      requested.push(email);
      return Promise.resolve({});
    },
  };
  const controller = new MemberPasswordResetController(database, resets, audit, members);
  return { controller, calls, audits, requested };
}

const member = (over: Partial<ResetMember> = {}): ResetMember => ({
  membershipId: 'm1',
  userId: 'u1',
  status: 'active',
  email: 'sam@example.com',
  ...over,
});

async function status(promise: Promise<unknown>): Promise<number> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).status;
}

describe('MemberPasswordResetController (Q4)', () => {
  it('answers 404 for a membership that is not in the caller’s organization', async () => {
    const { controller, calls } = setup([member()]);
    expect(await status(controller.send(context, 'm-foreign', { reason: REASON }))).toBe(404);
    expect(calls).toEqual([]);
  });

  it('refuses resetting yourself, an inactive member and a short reason with 422', async () => {
    const { controller, calls } = setup([
      member({ membershipId: 'm0', userId: 'u0' }),
      member({ membershipId: 'm2', userId: 'u2', status: 'suspended' }),
      member(),
    ]);
    expect(await status(controller.send(context, 'm0', { reason: REASON }))).toBe(422);
    expect(await status(controller.send(context, 'm2', { reason: REASON }))).toBe(422);
    expect(await status(controller.send(context, 'm1', { reason: 'abc' }))).toBe(422);
    expect(await status(controller.send(context, 'm1', {}))).toBe(422);
    expect(calls).toEqual([]);
  });

  it('records the audit row and commits it before requesting the ordinary reset link', async () => {
    const { controller, calls, audits, requested } = setup([member()]);
    await expect(controller.send(context, 'm1', { reason: REASON })).resolves.toEqual({
      status: 'sent',
    });
    expect(calls).toEqual(['audit', 'commit', 'request']);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'member.password_reset_sent',
        objectId: 'm1',
        result: 'allowed',
        metadata: { target_user_id: 'u1' },
      }),
    ]);
    expect(requested).toEqual(['sam@example.com']);
  });

  it('sits behind org.manage and answers 202', () => {
    const handler = MemberPasswordResetController.prototype.send;
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, handler)).toBe('org.manage');
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(202);
  });
});
