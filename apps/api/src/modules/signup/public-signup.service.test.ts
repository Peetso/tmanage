import { describe, expect, it, vi } from 'vitest';
import { capabilitiesFor } from '@tmanage/domain';
import type {
  InvitationRegistrationScope,
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { CredentialsRepository } from '../identity/credentials.repository.js';
import type * as PasswordModule from '../identity/password.js';
import { ProvisioningService } from '../tenancy/provisioning.service.js';
import { OrganizationSlugTakenError } from '../tenancy/organizations.repository.js';
import type { OrganizationsRepository } from '../tenancy/organizations.repository.js';
import type { WorkspacesRepository } from '../tenancy/workspaces.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { PublicSignupService, slugBaseFrom } from './public-signup.service.js';
import {
  SignupEmailTakenError,
  type SignupAccountsRepository,
} from './signup-accounts.repository.js';

vi.mock('../identity/password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PasswordModule>();
  return { ...actual, hashPassword: vi.fn(async () => 'hashed-password') };
});

const CORR_1 = '0199aa00-0000-7000-8000-0000000000c1';
const CORR_2 = '0199aa00-0000-7000-8000-0000000000c2';

const BODY = {
  displayName: 'Mona Adel',
  email: '  Mona@Example.com ',
  password: 'correct horse battery staple 9',
  organizationName: 'Nile Studio',
  timezone: 'Africa/Cairo',
  defaultLocale: 'ar',
};

/**
 * The real `ProvisioningService` over fake repositories, so what is asserted is the context the
 * shared provisioning path actually builds — organization id, role, capabilities — not a spy's
 * echo of the arguments.
 */
function harness(options: { emailTaken?: boolean; slugTakenTimes?: number } = {}) {
  const tenantContexts: TenantContext[] = [];
  const founders: { organizationId: string; userId: string; role: string }[] = [];
  const createdSlugs: string[] = [];
  let slugTaken = options.slugTakenTimes ?? 0;
  const runner = {} as TenantQueryRunner;

  const database = {
    invitationRegistrationTransaction: vi.fn(
      async <T>(_o: unknown, work: (scope: InvitationRegistrationScope) => Promise<T>) =>
        work({
          identity: runner,
          tenant: (context) => {
            tenantContexts.push(context);
            return runner;
          },
        }),
    ),
    bootstrapRead: vi.fn(),
  } as unknown as TenantDatabase;

  const organizations = {
    create: vi.fn(
      async (
        _tx: unknown,
        context: TenantContext,
        input: { id: string; slug: string; name: string },
      ) => {
        if (slugTaken > 0) {
          slugTaken -= 1;
          throw new OrganizationSlugTakenError(input.slug);
        }
        expect(input.id).toBe(context.organizationId);
        createdSlugs.push(input.slug);
        return { id: input.id, slug: input.slug, name: input.name };
      },
    ),
  } as unknown as OrganizationsRepository;
  const workspaces = {
    create: vi.fn(async () => ({ id: 'ws-1' })),
  } as unknown as WorkspacesRepository;
  const memberships = {
    createFounder: vi.fn(
      async (
        _tx: unknown,
        context: TenantContext,
        input: { id: string; userId: string; role: string },
      ) => {
        founders.push({
          organizationId: context.organizationId,
          userId: input.userId,
          role: input.role,
        });
        return { id: input.id, role: input.role };
      },
    ),
  } as unknown as MembershipsRepository;
  const settings = { upsert: vi.fn() } as unknown as OrgSettingsRepository;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const provisioning = new ProvisioningService(
    database,
    audit,
    organizations,
    workspaces,
    memberships,
    settings,
  );

  const insertUser = vi.fn(async () => {
    if (options.emailTaken) throw new SignupEmailTakenError();
  });
  const accounts = { insertUser } as unknown as SignupAccountsRepository;
  const setPassword = vi.fn(async () => undefined);
  const credentials = { setPassword } as unknown as CredentialsRepository;
  const deliver = vi.fn(async () => 'sent' as const);

  const service = new PublicSignupService(
    database,
    provisioning,
    { deliver } as never,
    accounts,
    credentials,
  );
  return {
    service,
    database,
    tenantContexts,
    founders,
    createdSlugs,
    insertUser,
    setPassword,
    deliver,
    audit,
  };
}

describe('PublicSignupService', () => {
  it('creates the user and a NEW organization with that user as its only owner', async () => {
    const h = harness();
    const result = await h.service.signUp(BODY, CORR_1);

    expect(h.insertUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email: 'mona@example.com',
        displayName: 'Mona Adel',
        emailVerified: false,
      }),
    );
    expect(h.setPassword).toHaveBeenCalledWith(expect.anything(), result.userId, 'hashed-password');
    expect(h.founders).toEqual([
      { organizationId: result.organizationId, userId: result.userId, role: 'owner' },
    ]);
    expect(result.slug).toBe('nile-studio');
    expect(h.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'mona@example.com',
        organizationSlug: 'nile-studio',
        locale: 'ar',
      }),
    );
  });

  it('scopes every tenant statement to the new organization only, with owner capabilities and nothing more', async () => {
    const h = harness();
    const first = await h.service.signUp(BODY, CORR_1);
    const second = await h.service.signUp({ ...BODY, email: 'other@example.com' }, CORR_2);

    expect(first.organizationId).not.toBe(second.organizationId);
    expect(h.tenantContexts.map((c) => c.organizationId)).toEqual([
      first.organizationId,
      second.organizationId,
    ]);
    for (const context of h.tenantContexts) {
      expect(context.principalKind).toBe('internal');
      expect([...context.capabilities].sort()).toEqual([...capabilitiesFor('owner')].sort());
    }
    // No cross-tenant read happens on this path: nothing bypasses the tenant guard.
    expect(h.database.bootstrapRead).not.toHaveBeenCalled();
  });

  it('lets an existing account surface as SignupEmailTakenError (the controller says "sign in")', async () => {
    const h = harness({ emailTaken: true });
    await expect(h.service.signUp(BODY, CORR_1)).rejects.toBeInstanceOf(SignupEmailTakenError);
    expect(h.founders).toEqual([]);
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('retries a taken web link with a random suffix', async () => {
    const h = harness({ slugTakenTimes: 1 });
    const result = await h.service.signUp(BODY, CORR_1);
    expect(result.slug).toMatch(/^nile-studio-[0-9a-f]{4}$/);
  });

  it('refuses a weak password and a missing workspace name with field details', async () => {
    const h = harness();
    await expect(
      h.service.signUp({ ...BODY, password: 'short', organizationName: ' ' }, CORR_1),
    ).rejects.toMatchObject({
      status: 422,
      details: expect.arrayContaining([
        expect.objectContaining({ field: 'password' }),
        expect.objectContaining({ field: 'organizationName' }),
      ]),
    });
    expect(h.insertUser).not.toHaveBeenCalled();
  });

  it('derives a safe web link from any name', () => {
    expect(slugBaseFrom('استوديو النيل')).toBe('workspace');
    expect(slugBaseFrom('  Café & Co. ')).toBe('cafe-co');
  });
});
