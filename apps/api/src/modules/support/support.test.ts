import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlatformPermission } from '@tmanage/domain';
import type { Mailer } from '@tmanage/mail';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import { PlatformAdminGuard } from '../platform-admin/platform-admin.guard.js';
import type {
  PlatformAdminActor,
  PlatformAdminLookup,
} from '../platform-admin/platform-admin.guard.js';
import { PlatformSupportThreadsController } from './support.controller.js';
import { buildSupportReplyEmail } from './support-email.js';
import { maySeeThread, mayWriteInThread, parseNewThread } from './support.policy.js';
import type { SupportRepository, SupportThreadRecord } from './support.repository.js';
import { SUPPORT_BOOTSTRAP_TABLES, SupportService } from './support.service.js';

const ORG = '0199aa00-0000-7000-8000-0000000000aa';
const ME = '0199aa00-0000-7000-8000-0000000000c1';
const OTHER = '0199aa00-0000-7000-8000-0000000000c2';
const THREAD = '0199aa00-0000-7000-8000-0000000000e1';
const FILE = '0199aa00-0000-7000-8000-0000000000f1';

function ctx(over: Partial<TenantContext> = {}): TenantContext {
  return {
    organizationId: ORG,
    userId: ME,
    principalKind: 'internal',
    membershipId: 'm',
    capabilities: ['work.read'],
    policyVersion: 'p',
    correlationId: 'corr',
    ...over,
  } as TenantContext;
}

function thread(over: Partial<SupportThreadRecord> = {}): SupportThreadRecord {
  return {
    id: THREAD,
    organizationId: ORG,
    organizationSlug: null,
    organizationName: null,
    startedByUserId: OTHER,
    startedByName: 'Lina',
    startedByEmail: 'lina@example.com',
    subject: 'Logo',
    status: 'open',
    contextPath: '/atlas',
    contextAppVersion: '1.0',
    messageCount: 1,
    lastMessageAt: new Date(0),
    lastAuthorKind: 'member',
    createdAt: new Date(0),
    closedAt: null,
    category: 'question',
    priority: 'normal',
    planIdAtOpen: 'free',
    slaTimezone: 'Asia/Riyadh',
    slaFirstResponseMinutes: 1080,
    slaResolutionMinutes: 2700,
    firstResponseAt: null,
    slaPausedAt: null,
    slaPausedMinutes: 0,
    slaBreached: false,
    ...over,
  };
}

function harness(found: SupportThreadRecord | null = thread()) {
  const queries: string[] = [];
  const db = { query: async (sql: string) => (queries.push(sql), []) };
  const run = async (_a: unknown, work: (d: typeof db) => unknown) => work(db);
  const database = { read: run, transaction: run, bootstrapRead: vi.fn(run) };
  const repository = {
    list: vi.fn(async () => [found ?? thread()]),
    find: vi.fn(async () => found),
    messages: vi.fn(async () => []),
    organizationLabel: vi.fn(async () => ({ slug: 'atlas', name: 'Atlas' })),
    insertThread: vi.fn(async () => undefined),
    appendMessage: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
    listAcrossOrganizations: vi.fn(async () => []),
    organizationOfThread: vi.fn(async () => (found ? ORG : null)),
    slaSource: vi.fn(async () => ({ planId: 'business', timezone: 'Asia/Riyadh' })),
    updateSla: vi.fn(async () => undefined),
  };
  const outbox = { append: vi.fn(async () => 'event') };
  const notifications = { insertForRecipient: vi.fn(async () => undefined) };
  const files = { findById: vi.fn(async () => null as unknown) };
  const mailer = { send: vi.fn(async () => 'sent' as const) };
  const service = new SupportService({
    database: database as unknown as TenantDatabase,
    repository: repository as unknown as SupportRepository,
    files: files as never,
    notifications,
    outbox,
    mailer: mailer as unknown as Mailer,
    webPublicUrl: 'https://tmanage.example',
    now: () => new Date('2026-11-08T10:00:00.000Z'),
  });
  return { service, repository, notifications, files, mailer, database, queries, outbox };
}

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );

describe('55-17 support · who may see and write a thread', () => {
  it('the starter sees and writes; an org admin sees but does not write; others see nothing', () => {
    const t = { startedByUserId: ME };
    expect(maySeeThread(ctx(), t)).toBe(true);
    expect(mayWriteInThread(ctx(), t)).toBe(true);
    expect(maySeeThread(ctx({ userId: OTHER }), t)).toBe(false);
    const admin = ctx({ userId: OTHER, capabilities: ['work.read', 'org.manage'] });
    expect(maySeeThread(admin, t)).toBe(true);
    expect(mayWriteInThread(admin, t)).toBe(false);
    expect(maySeeThread(ctx({ principalKind: 'client' }), t)).toBe(false);
  });

  it('a member lists only their own threads; an org admin lists the whole organization', async () => {
    const h = harness();
    await h.service.list(ctx());
    expect(h.repository.list).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), ME);
    await h.service.list(ctx({ capabilities: ['work.read', 'org.manage'] }));
    expect(h.repository.list).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), null);
  });

  it("another member's thread answers 404, and a follow-up by an admin is 403", async () => {
    const h = harness(thread({ startedByUserId: OTHER }));
    expect(await status(h.service.get(ctx(), THREAD))).toBe(404);
    expect(await status(h.service.postMessage(ctx(), THREAD, { message: 'hi' }))).toBe(404);
    const admin = ctx({ capabilities: ['work.read', 'org.manage'] });
    expect(await status(h.service.postMessage(admin, THREAD, { message: 'hi' }))).toBe(403);
    expect(h.repository.appendMessage).not.toHaveBeenCalled();
  });

  it('a client principal is refused', async () => {
    expect(await status(harness().service.list(ctx({ principalKind: 'client' })))).toBe(403);
  });
});

describe('55-17 support · new thread input', () => {
  it('validates subject, message, page path and attachment', async () => {
    expect(() => parseNewThread({ subject: '', message: 'x' })).toThrow();
    expect(() => parseNewThread({ subject: 's'.repeat(161), message: 'x' })).toThrow();
    expect(() =>
      parseNewThread({ subject: 's', message: 'x', contextPath: 'https://evil.example' }),
    ).toThrow();
    expect(parseNewThread({ subject: ' s ', message: 'x', contextPath: '/a/b' })).toMatchObject({
      subject: 's',
      contextPath: '/a/b',
    });
    const h = harness(thread({ startedByUserId: ME }));
    h.files.findById.mockResolvedValue({ ownerUserId: OTHER, name: 'shot.png', status: 'ready' });
    const create = h.service.create(ctx(), { subject: 's', message: 'm', attachmentFileId: FILE });
    expect(await status(create)).toBe(400);
    expect(h.repository.insertThread).not.toHaveBeenCalled();
  });
});

describe('55-17 support · platform path', () => {
  const ACTOR = { account: { userId: 'ops', email: 'ops@example.com' } } as PlatformAdminActor;
  const REQUEST = {
    correlationId: '0199aa00-0000-7000-8000-0000000000d1',
    ip: null,
    userAgent: null,
  };

  it('lists across organizations only through the declared bootstrap tables', async () => {
    const h = harness();
    await h.service.platformList('corr');
    expect(h.database.bootstrapRead).toHaveBeenCalledWith(
      expect.objectContaining({ tables: [...SUPPORT_BOOTSTRAP_TABLES] }),
      expect.any(Function),
    );
  });

  it('a reply notifies the starter, audits, and e-mails with the support reply-to', async () => {
    const h = harness();
    await h.service.platformReply(ACTOR, THREAD, { message: 'Fixed' }, REQUEST);
    expect(h.repository.appendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG }),
      expect.objectContaining({ authorKind: 'platform' }),
      'waiting',
    );
    expect(h.notifications.insertForRecipient).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ recipientUserId: OTHER, objectId: THREAD }),
    );
    expect(h.queries.some((q) => /platform_admin_audit_events/u.test(q))).toBe(true);
    expect(h.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'lina@example.com', replyTo: 'support@tmanageapp.com' }),
    );
  });

  it('a failed e-mail does not undo the reply; an unknown thread is 404', async () => {
    const h = harness();
    h.mailer.send.mockRejectedValue(new Error('smtp down'));
    expect(await status(h.service.platformReply(ACTOR, THREAD, { message: 'ok' }, REQUEST))).toBe(
      200,
    );
    expect(await status(harness(null).service.platformGet(THREAD, 'corr'))).toBe(404);
  });

  it('the reply mail links back into the app and keeps the text out', () => {
    const mail = buildSupportReplyEmail({
      to: 'a@example.com',
      subject: 'Logo\nwrong',
      organizationSlug: 'atlas',
      threadId: THREAD,
      webPublicUrl: 'https://tm.example/',
    });
    expect(mail.subject).toBe('Re: Logo wrong');
    expect(mail.text).toContain(`https://tm.example/atlas/help?request=${THREAD}`);
  });

  async function guardStatus(permissions: PlatformPermission[], handler: 'get' | 'reply') {
    const lookup: PlatformAdminLookup = {
      findAccount: async () => ({
        userId: ME,
        email: 'ops@example.com',
        displayName: 'O',
        emailVerified: true,
        mfaEnabled: true,
      }),
      findLiveStepUp: async () => ({
        expiresAt: new Date(Date.now() + 600_000),
        mfaVerified: true,
      }),
      findPlatformAdmin: async () => ({
        id: 'admin-1',
        userId: ME,
        preset: 'support',
        customPermissions: null,
        permissions,
        status: 'active',
      }),
      hasActivePlatformAdmins: async () => true,
    };
    const guard = new PlatformAdminGuard(new Reflector(), [], lookup);
    const request = { headers: {} };
    const state = ensureRequestState(request);
    state.session = { sessionId: 's', userId: ME };
    state.authScheme = 'cookie';
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => PlatformSupportThreadsController.prototype[handler],
      getClass: () => PlatformSupportThreadsController,
    } as unknown as ExecutionContext;
    return guard.canActivate(context).then(
      () => 200,
      (error: { status: number }) => error.status,
    );
  }

  it('reading needs platform.orgs.view; replying needs platform.orgs.edit', async () => {
    expect(await guardStatus([], 'get')).toBe(403);
    expect(await guardStatus(['platform.orgs.view'], 'get')).toBe(200);
    expect(await guardStatus(['platform.orgs.view'], 'reply')).toBe(403);
    expect(await guardStatus(['platform.orgs.view', 'platform.orgs.edit'], 'reply')).toBe(200);
  });
});
