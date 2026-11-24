import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';
import { MAIL_LAYOUT_MARK } from '@tmanage/mail';
import type { Mailer, MailMessage } from '@tmanage/mail';
import { PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { PLATFORM_PERMISSION_METADATA } from '../require-platform-permission.decorator.js';
import { PlatformMailPeopleController } from './mail-people.controller.js';
import type { MailPeopleRepository, MailPersonRecord } from './mail-people.repository.js';
import { MailPeopleService, parseMailPeopleCsv, parseMailPerson } from './mail-people.service.js';
import type { MailPeopleServiceOptions } from './mail-people.service.js';

/** EMAILBUILD — the "E-mail people" card: validation, audit, test send, guard. */

const ctx = { correlationId: 'c', ip: null, userAgent: null };
const actor: PlatformAdminActor = {
  account: {
    userId: 'u',
    email: 'admin@tmanageapp.com',
    displayName: 'Admin',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 's',
  stepUp: null,
};
const LAYLA: MailPersonRecord = {
  id: '0199aa00-0000-7000-8000-0000000000d1',
  nameEn: 'Layla',
  nameAr: 'ليلى',
  roleEn: 'product specialist',
  roleAr: 'أخصائي المنتج',
  address: 'layla@tmanageapp.com',
  languages: 'en+ar',
  region: 'me',
  topic: 'features',
  active: true,
};
const body = {
  nameEn: 'Mariam',
  nameAr: 'مريم',
  roleEn: 'onboarding',
  roleAr: 'تهيئة العملاء',
  address: 'Mariam@tmanageapp.com',
  languages: 'en+ar',
  region: 'me',
  topic: 'onboarding',
};

function harness(
  taken: string[] = [],
  routes: {
    personMailConfigured?: boolean;
    loginCheck?: MailPeopleServiceOptions['loginCheck'];
  } = {},
) {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    send: (message) => {
      sent.push(message);
      return Promise.resolve('sent');
    },
  };
  const repository = {
    list: vi.fn(async () => [LAYLA]),
    byId: vi.fn(async (id: string) => (id === LAYLA.id ? LAYLA : null)),
    taken: vi.fn(async (addresses: readonly string[]) =>
      addresses.filter((a) => taken.includes(a)),
    ),
    insert: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined),
  };
  const service = new MailPeopleService(repository as unknown as MailPeopleRepository, {
    mailer,
    personMailConfigured: routes.personMailConfigured ?? false,
    loginCheck: routes.loginCheck,
  });
  return { service, repository, sent };
}

describe('EMAILBUILD — mail people', () => {
  it('saves a valid person, lower-cases the address and audits the write', async () => {
    const { service, repository } = harness();
    await service.create(actor, body, ctx);
    const [rows, audit] = repository.insert.mock.calls[0] as unknown as [
      MailPersonRecord[],
      { action: string; actorUserId: string },
    ];
    expect(rows[0]?.address).toBe('mariam@tmanageapp.com');
    expect(audit).toMatchObject({ action: 'platform.mail_person_added', actorUserId: 'u' });
  });

  it('refuses another domain, header tricks and a duplicate address', async () => {
    expect(() => parseMailPerson({ ...body, address: 'mariam@gmail.com' })).toThrow(
      'The address must end in @tmanageapp.com',
    );
    for (const nameEn of ['M\r\nBcc: x', 'M"x', 'M<x>', 'a,b']) {
      expect(() => parseMailPerson({ ...body, nameEn })).toThrow();
    }
    expect(() => parseMailPerson({ ...body, topic: 'billing' })).toThrow();
    const { service } = harness(['mariam@tmanageapp.com']);
    await expect(service.create(actor, body, ctx)).rejects.toMatchObject({ status: 409 });
  });

  it('imports at most 100 rows of the template, all or nothing', () => {
    const header = 'name_en,name_ar,role_en,role_ar,address,languages,region,topic,active';
    const line = 'Mei,مي,product specialist,أخصائي المنتج,mei@tmanageapp.com,en,asia,features,yes';
    expect(parseMailPeopleCsv(`${header}\n${line}`)).toHaveLength(1);
    expect(() =>
      parseMailPeopleCsv(`${header}\n${line.replace('tmanageapp.com', 'x.io')}`),
    ).toThrow(/Line 2/u);
    expect(() => parseMailPeopleCsv(`${header}\n${Array(101).fill(line).join('\n')}`)).toThrow();
    expect(() => parseMailPeopleCsv(line)).toThrow();
  });

  it('switching a person off is audited as such', async () => {
    const { service, repository } = harness();
    await service.update(actor, LAYLA.id, { active: false }, ctx);
    const call = repository.update.mock.calls[0] as unknown as [MailPersonRecord, object];
    expect(call[1]).toMatchObject({
      action: 'platform.mail_person_switched_off',
    });
  });

  it('sends the test only to the acting admin, signed through the registry, and audits it', async () => {
    const { service, repository, sent } = harness();
    const view = await service.sendTest(actor, LAYLA.id, {}, ctx);
    expect(view).toEqual({ sent: true, route: 'none', address: 'layla@tmanageapp.com' });
    expect(sent[0]).toMatchObject({
      to: 'admin@tmanageapp.com',
      templateKey: 'tip',
      personRef: { kind: 'test', personId: LAYLA.id },
    });
    // MAILDESIGN: the test mail is drawn like every mail, signed by the person's tokens.
    expect(sent[0]?.html).toContain(MAIL_LAYOUT_MARK);
    expect(sent[0]?.html).toContain('[[tm.sign.by]]');
    expect(sent[0]?.text).toContain('[[tm.sign.by]]');
    expect(repository.audit).toHaveBeenCalledOnce();
  });

  it('PERSONMAIL: the test says which mailbox it left from, with the address', async () => {
    const own = harness([], { personMailConfigured: true });
    expect(await own.service.sendTest(actor, LAYLA.id, {}, ctx)).toEqual({
      sent: true,
      route: 'own_mailbox',
      address: 'layla@tmanageapp.com',
    });
    const none = harness([], { personMailConfigured: false });
    expect((await none.service.sendTest(actor, LAYLA.id, {}, ctx)).route).toBe('none');
  });

  it('MAILSTATUS: the list says which mailbox logins are refused, by state, never a value', async () => {
    const { service } = harness([], {
      loginCheck: {
        status: async () => ({
          state: 'login_refused' as const,
          checkedAt: '2026-11-20T08:40:00.000Z',
          mailboxes: [
            {
              mailbox: 'noreply' as const,
              address: 'noreply@tmanageapp.com',
              state: 'login_refused' as const,
            },
            { mailbox: 'hello' as const, address: 'hello@tmanageapp.com', state: 'ok' as const },
            {
              mailbox: 'support' as const,
              address: 'support@tmanageapp.com',
              state: 'ok' as const,
            },
            { mailbox: 'security' as const, address: null, state: 'not_configured' as const },
          ],
        }),
      },
    });
    const view = await service.list(ctx);
    expect(view.mailboxes?.[0]).toEqual({
      mailbox: 'noreply',
      address: 'noreply@tmanageapp.com',
      state: 'login_refused',
    });
    expect(view.mailboxes).toHaveLength(4);
    // A check that throws is "no reading", and without SMTP there is none.
    const broken = harness([], { loginCheck: { status: () => Promise.reject(new Error('x')) } });
    expect((await broken.service.list(ctx)).mailboxes).toBeNull();
    expect((await harness().service.list(ctx)).mailboxes).toBeNull();
  });

  it('every route sits behind the platform-admin guard and a platform permission', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PlatformMailPeopleController)).toContain(
      PlatformAdminGuard,
    );
    for (const handler of ['list', 'create', 'importList', 'update', 'sendTest'] as const) {
      expect(
        Reflect.getMetadata(
          PLATFORM_PERMISSION_METADATA,
          PlatformMailPeopleController.prototype[handler],
        ),
        handler,
      ).toBe('platform.settings.edit');
    }
  });
});
