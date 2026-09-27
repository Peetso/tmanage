import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { PortalClientMessagesController } from './client-messages.controller.js';
import { ClientMessagesService } from './client-messages.service.js';
import type { CreateClientMessageInput } from './client-messages.repository.js';
import type { ClientMessagesRepository } from './client-messages.repository.js';
import type { ClientOrganizationsRepository } from './client-organizations.repository.js';
import type { PortalClientMessageRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * SEC / Client portal messages (x322) — the client write/own-read and the staff inbound read, over
 * fakes with **real** `authorize()`.
 *
 * The fakes stand in only for the database and the two repositories; `authorize()` is the real policy,
 * so these cases prove the actual security decisions: a client posts as the context user and reads
 * only their own client-org scope (never another client's), an off-client principal is a 404, an empty
 * subject/body is a 400 with no write, a cross-tenant admin scope id is a 404, and the route ceiling
 * refuses a client's admin read with `client_member.manage` (and the POST requires
 * `client_projection.read`). No DB in this suite (the chain owns the round-trip and the migrator proof).
 */

const ORG = 'org-under-test';
const CLIENT_ORG = 'client-org-under-test';
const CLIENT_OTHER = 'client-org-someone-else';
const CLIENT_USER = 'client-user-1';

function clientPrincipal(clientOrganizationId: string | null): Principal {
  return {
    userId: CLIENT_USER,
    organizationId: ORG,
    kind: 'client',
    role: 'client_viewer',
    membershipId: 'membership-client-1',
    membershipStatus: 'active',
    clientOrganizationId,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

const clientContext = { organizationId: ORG, userId: CLIENT_USER } as unknown as TenantContext;

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

/** Client-organizations repo that resolves exactly the ids it was seeded with (tenant-scoped). */
function fakeOrganizations(ids: readonly string[]): ClientOrganizationsRepository {
  return {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(ids.includes(id) ? ({ id } as never) : null),
  } as unknown as ClientOrganizationsRepository;
}

/** A stateful message store: `create` appends, `listForScope` filters by client-org scope. */
function fakeMessages(seed: readonly PortalClientMessageRow[] = []): {
  repo: ClientMessagesRepository;
  created: CreateClientMessageInput[];
  rows: PortalClientMessageRow[];
} {
  const created: CreateClientMessageInput[] = [];
  const rows: PortalClientMessageRow[] = [...seed];
  let seq = 0;
  const repo = {
    create: (_r: never, _c: TenantContext, input: CreateClientMessageInput) => {
      created.push(input);
      seq += 1;
      const row = {
        id: `m-${seq}`,
        organizationId: ORG,
        clientOrgScopeId: input.clientOrgScopeId,
        authorUserId: input.authorUserId,
        subject: input.subject,
        body: input.body,
        createdAt: new Date(`2026-09-2${seq}T00:00:00.000Z`),
      } as unknown as PortalClientMessageRow;
      rows.push(row);
      return Promise.resolve(row);
    },
    listForScope: (_r: never, _c: TenantContext, scopeId: string) =>
      Promise.resolve(rows.filter((row) => row.clientOrgScopeId === scopeId)),
  } as unknown as ClientMessagesRepository;
  return { repo, created, rows };
}

function serviceFor(
  store: ReturnType<typeof fakeMessages>,
  orgIds: readonly string[] = [CLIENT_ORG],
): ClientMessagesService {
  return new ClientMessagesService(fakeDatabase(), fakeOrganizations(orgIds), store.repo);
}

function otherClientRow(): PortalClientMessageRow {
  return {
    id: 'm-other',
    organizationId: ORG,
    clientOrgScopeId: CLIENT_OTHER,
    authorUserId: 'client-user-other',
    subject: 'Not yours',
    body: 'A different client organization wrote this',
    createdAt: new Date('2026-09-10T00:00:00.000Z'),
  } as unknown as PortalClientMessageRow;
}

describe('ClientMessagesService (x322)', () => {
  it('posts as the context user in the caller own scope, and the own-thread read hides internal fields', async () => {
    const store = fakeMessages();
    const service = serviceFor(store);

    const created = await service.post(clientContext, clientPrincipal(CLIENT_ORG), {
      subject: 'Question about the deliverable',
      body: 'When will the next draft be ready?',
    });

    // The author and the scope come from the session, never the body.
    expect(store.created[0]).toMatchObject({
      clientOrgScopeId: CLIENT_ORG,
      authorUserId: CLIENT_USER,
    });
    // The client view carries no author, no scope id and no tenant id.
    expect(Object.keys(created).sort()).toEqual(['body', 'createdAt', 'id', 'subject'].sort());

    const thread = await service.listOwnThread(clientContext, clientPrincipal(CLIENT_ORG));
    expect(thread.map((m) => m.subject)).toEqual(['Question about the deliverable']);
    expect(thread[0]).not.toHaveProperty('authorUserId');
    expect(thread[0]).not.toHaveProperty('clientOrgScopeId');
  });

  it('never returns another client organization messages on the own-thread read', async () => {
    const store = fakeMessages([otherClientRow()]);
    const service = serviceFor(store);

    const thread = await service.listOwnThread(clientContext, clientPrincipal(CLIENT_ORG));
    expect(thread).toHaveLength(0);
  });

  it('answers 404 and writes nothing for an off-client principal (no client-org scope)', async () => {
    const store = fakeMessages();
    const service = serviceFor(store);

    await expect(
      service.post(clientContext, clientPrincipal(null), { subject: 's', body: 'b' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.created).toHaveLength(0);
  });

  it('answers 404 for a staff read of a cross-tenant / unknown client-org scope id', async () => {
    const store = fakeMessages([otherClientRow()]);
    // The scope id the staff caller names does not resolve in this tenant.
    const service = serviceFor(store, [CLIENT_ORG]);

    await expect(service.listForAdmin(clientContext, CLIENT_OTHER)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('lets staff read a resolved client organization full inbound record', async () => {
    const store = fakeMessages([otherClientRow()]);
    const service = serviceFor(store, [CLIENT_OTHER]);

    const inbound = await service.listForAdmin(clientContext, CLIENT_OTHER);
    expect(inbound).toHaveLength(1);
    // Staff see the author and the scope — the full record.
    expect(inbound[0]).toMatchObject({
      clientOrganizationId: CLIENT_OTHER,
      authorUserId: 'client-user-other',
    });
  });
});

describe('client-messages controller validation and route capabilities', () => {
  it('rejects an empty subject or body with 400 and never reaches the service', async () => {
    const store = fakeMessages();
    const controller = new PortalClientMessagesController(serviceFor(store));

    await expect(
      controller.post(clientContext, clientPrincipal(CLIENT_ORG), { subject: '  ', body: 'b' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.post(clientContext, clientPrincipal(CLIENT_ORG), { subject: 's', body: '' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.created).toHaveLength(0);
  });

  const capabilityOf = (key: string): unknown =>
    Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      (PortalClientMessagesController.prototype as Record<string, unknown>)[key] as object,
    );

  it('guards the client post and own-thread read with client_projection.read', () => {
    expect(capabilityOf('post')).toBe('client_projection.read');
    expect(capabilityOf('list')).toBe('client_projection.read');
  });

  it('guards the staff inbound read with client_member.manage', () => {
    expect(capabilityOf('listForAdmin')).toBe('client_member.manage');
  });
});
