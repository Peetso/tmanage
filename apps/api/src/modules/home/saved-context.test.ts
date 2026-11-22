import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { HomeService, messageTitle } from './home.service.js';
import { MyDayRepository } from './my-day.repository.js';
import { WaitingRepository } from './waiting.repository.js';
import type {
  SavedContextRepository,
  SavedContextSources,
  SavedDocSource,
  SavedFileSource,
  SavedMessageSource,
  SavedWorkSource,
} from './saved-context.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SavedContextEntityType, SavedContextRow } from '../../common/database/schema.js';

/**
 * HOME-05 pin/unpin/list over fakes, with the **real** `authorize`.
 *
 * The database is faked (there is a `.db.test.ts` for the SQL), but the policy is not: a real
 * `Principal` runs through the real evaluator, so these cases prove the two rules that are the
 * whole of this slice's safety — the entity/project are resolved tenant-scoped BEFORE the relation
 * check (an unknown or cross-tenant id is a 404 with no write, the Known trap), and a pin is
 * private to its user (off-user unpin is a 404, and one user never sees another's pins).
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const ME = '00000000-0000-4000-8000-0000000000c1';
const SOMEONE_ELSE = '00000000-0000-4000-8000-0000000000c2';
const WORK_ITEM = '00000000-0000-4000-8000-0000000000d1';

/** A manager who is a member of PROJECT: holds `work.read` and the project relation. */
function manager(userId = ME): Principal {
  return {
    userId,
    organizationId: ORG,
    kind: 'internal',
    role: 'manager',
    membershipId: '00000000-0000-4000-8000-0000000000e1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

/** An owner whose scope is the whole organization — passes the relation without a project row. */
function owner(): Principal {
  return { ...manager(), role: 'owner', hasOrgWideScope: true, projectIds: [] };
}

const context = { organizationId: ORG, userId: ME } as unknown as TenantContext;
const contextFor = (userId: string) =>
  ({ organizationId: ORG, userId }) as unknown as TenantContext;

/**
 * An in-memory {@link SavedContextRepository} with a configurable set of resolvable projects and
 * entities, so a test can make an id "unknown" simply by leaving it out — which is exactly what a
 * cross-tenant id looks like to the real repository's tenant-scoped resolve.
 */
class FakeSavedContextRepository {
  readonly rows: SavedContextRow[] = [];
  insertCalls = 0;
  /** The source rows the title read resolves; empty unless a test names some. */
  readonly work = new Map<string, SavedWorkSource>();
  readonly doc = new Map<string, SavedDocSource>();
  readonly file = new Map<string, SavedFileSource>();
  readonly message = new Map<string, SavedMessageSource>();
  private nextId = 1;

  constructor(
    private readonly knownProjects: ReadonlySet<string>,
    private readonly knownEntities: ReadonlySet<string>,
  ) {}

  static key(type: SavedContextEntityType, entityId: string, projectId: string): string {
    return `${type}:${entityId}:${projectId}`;
  }

  projectExists(_r: unknown, _c: unknown, projectId: string): Promise<boolean> {
    return Promise.resolve(this.knownProjects.has(projectId));
  }

  entityExistsInProject(
    _r: unknown,
    _c: unknown,
    entityType: SavedContextEntityType,
    entityId: string,
    projectId: string,
  ): Promise<boolean> {
    return Promise.resolve(
      this.knownEntities.has(FakeSavedContextRepository.key(entityType, entityId, projectId)),
    );
  }

  findPin(
    _r: unknown,
    _c: unknown,
    userId: string,
    entityType: SavedContextEntityType,
    entityId: string,
  ): Promise<SavedContextRow | undefined> {
    return Promise.resolve(
      this.rows.find(
        (row) =>
          row.userId === userId && row.entityType === entityType && row.entityId === entityId,
      ),
    );
  }

  insert(
    _r: unknown,
    _c: unknown,
    input: {
      userId: string;
      entityType: SavedContextEntityType;
      entityId: string;
      projectId: string;
    },
  ): Promise<SavedContextRow> {
    this.insertCalls += 1;
    const row: SavedContextRow = {
      id: `pin-${this.nextId++}`,
      organizationId: ORG,
      userId: input.userId,
      entityType: input.entityType,
      entityId: input.entityId,
      projectId: input.projectId,
      createdAt: new Date('2026-09-21T00:00:00.000Z'),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  deleteOwn(_r: unknown, _c: unknown, userId: string, id: string): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.userId === userId && row.id === id);
    if (index === -1) return Promise.resolve(false);
    this.rows.splice(index, 1);
    return Promise.resolve(true);
  }

  sources(): Promise<SavedContextSources> {
    return Promise.resolve({
      work: this.work,
      doc: this.doc,
      file: this.file,
      message: this.message,
    });
  }

  listForUser(_r: unknown, _c: unknown, userId: string): Promise<readonly SavedContextRow[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => row.userId === userId)
        .sort(
          (a, b) =>
            (a.projectId ?? '').localeCompare(b.projectId ?? '') ||
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        ),
    );
  }
}

function serviceWith(repo: FakeSavedContextRepository): HomeService {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new HomeService(
    database,
    new MyDayRepository(),
    new WaitingRepository(),
    repo as unknown as SavedContextRepository,
  );
}

function fullWorld(): FakeSavedContextRepository {
  return new FakeSavedContextRepository(
    new Set([PROJECT]),
    new Set([FakeSavedContextRepository.key('work', WORK_ITEM, PROJECT)]),
  );
}

async function expect404<T>(promise: Promise<T>): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(404);
}

describe('HomeService saved/pinned context (HOME-05)', () => {
  it('pins, lists grouped by project, and unpins — the round trip', async () => {
    const repo = fullWorld();
    const service = serviceWith(repo);

    const afterPin = await service.pinContext(context, manager(), {
      entityType: 'work',
      entityId: WORK_ITEM,
      projectId: PROJECT,
    });
    expect(afterPin).toEqual({
      groups: [
        {
          projectId: PROJECT,
          items: [
            {
              id: 'pin-1',
              entityType: 'work',
              entityId: WORK_ITEM,
              createdAt: '2026-09-21T00:00:00.000Z',
              title: null,
            },
          ],
        },
      ],
    });

    const listed = await service.listSavedContext(context, manager());
    expect(listed.groups[0]?.items).toHaveLength(1);

    const afterUnpin = await service.unpinContext(context, manager(), 'pin-1');
    expect(afterUnpin).toEqual({ groups: [] });
  });

  it('is idempotent: pinning the same entity twice writes one row', async () => {
    const repo = fullWorld();
    const service = serviceWith(repo);
    const command = { entityType: 'work', entityId: WORK_ITEM, projectId: PROJECT } as const;

    await service.pinContext(context, manager(), command);
    const second = await service.pinContext(context, manager(), command);

    expect(repo.insertCalls).toBe(1);
    expect(second.groups[0]?.items).toHaveLength(1);
  });

  it('404s and does not write when the entity id is unknown/cross-tenant', async () => {
    const repo = fullWorld();
    const service = serviceWith(repo);

    await expect404(
      service.pinContext(context, manager(), {
        entityType: 'work',
        entityId: '00000000-0000-4000-8000-0000000000ff',
        projectId: PROJECT,
      }),
    );
    expect(repo.insertCalls).toBe(0);
    expect(repo.rows).toHaveLength(0);
  });

  it('404s an org-wide caller naming an unknown project id, before any write (Known trap)', async () => {
    const repo = fullWorld();
    const service = serviceWith(repo);

    await expect404(
      service.pinContext(context, owner(), {
        entityType: 'work',
        entityId: WORK_ITEM,
        projectId: '00000000-0000-4000-8000-0000000000fe',
      }),
    );
    expect(repo.insertCalls).toBe(0);
  });

  it('404s a pin whose project the caller cannot read (relation gate)', async () => {
    const repo = fullWorld();
    const service = serviceWith(repo);
    // A manager who is a member of no project: the entity resolves, but the relation is denied.
    const stranger: Principal = { ...manager(), projectIds: [] };

    await expect404(
      service.pinContext(context, stranger, {
        entityType: 'work',
        entityId: WORK_ITEM,
        projectId: PROJECT,
      }),
    );
    expect(repo.insertCalls).toBe(0);
  });

  it('denies unpinning another user’s pin (own-user), removing nothing', async () => {
    const repo = fullWorld();
    const service = serviceWith(repo);
    // A pin owned by someone else.
    repo.rows.push({
      id: 'pin-other',
      organizationId: ORG,
      userId: SOMEONE_ELSE,
      entityType: 'work',
      entityId: WORK_ITEM,
      projectId: PROJECT,
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
    });

    await expect404(service.unpinContext(context, manager(), 'pin-other'));
    expect(repo.rows).toHaveLength(1);
  });

  it('never lists another user’s pins', async () => {
    const repo = fullWorld();
    const service = serviceWith(repo);
    repo.rows.push({
      id: 'pin-other',
      organizationId: ORG,
      userId: SOMEONE_ELSE,
      entityType: 'work',
      entityId: WORK_ITEM,
      projectId: PROJECT,
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
    });

    const mine = await service.listSavedContext(contextFor(ME), manager());
    expect(mine).toEqual({ groups: [] });
  });
});

describe('Saved item titles (My Day v3.1): the real name only where the source is readable', () => {
  const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000b2';
  const CONVERSATION_ORG = ORG;

  function pin(id: string, entityType: SavedContextEntityType, entityId: string): SavedContextRow {
    return {
      id,
      organizationId: ORG,
      userId: ME,
      entityType,
      entityId,
      projectId: PROJECT,
      createdAt: new Date(`2026-09-2${id.slice(-1)}T00:00:00.000Z`),
    };
  }

  function message(overrides: Partial<SavedMessageSource>): SavedMessageSource {
    return {
      body: 'Client call notes\nSecond line',
      kind: 'text',
      deleted: false,
      conversationOrganizationId: CONVERSATION_ORG,
      conversationProjectId: PROJECT,
      conversationKind: 'project_channel',
      conversationArchived: false,
      viewerIsMember: true,
      ...overrides,
    };
  }

  async function titles(repo: FakeSavedContextRepository, principal = manager()) {
    const view = await serviceWith(repo).listSavedContext(context, principal);
    return Object.fromEntries(
      view.groups.flatMap((group) => group.items.map((item) => [item.entityId, item.title])),
    );
  }

  it('names work, deliverables, files and messages the viewer may read', async () => {
    const repo = fullWorld();
    repo.rows.push(
      pin('pin-1', 'work', 'w-1'),
      pin('pin-2', 'doc', 'v-1'),
      pin('pin-3', 'file', 'f-1'),
      pin('pin-4', 'message', 'm-1'),
    );
    repo.work.set('w-1', {
      projectId: PROJECT,
      title: 'Homepage concept v2',
      audience: 'internal',
      archived: false,
      deleted: false,
    });
    repo.doc.set('v-1', { projectId: PROJECT, title: 'Homepage brief', deleted: false });
    repo.file.set('f-1', {
      projectId: PROJECT,
      name: 'Logo pack.zip',
      audience: 'internal',
      clientOrganizationId: null,
      gone: false,
    });
    repo.message.set('m-1', message({}));

    expect(await titles(repo)).toEqual({
      'w-1': 'Homepage concept v2',
      'v-1': 'Homepage brief',
      'f-1': 'Logo pack.zip',
      'm-1': 'Client call notes',
    });
  });

  it('keeps the generic label for a source that is gone, unknown or in a project the viewer cannot read', async () => {
    const repo = fullWorld();
    repo.rows.push(
      pin('pin-1', 'work', 'w-gone'),
      pin('pin-2', 'doc', 'v-unknown'),
      pin('pin-3', 'file', 'f-purged'),
      pin('pin-4', 'work', 'w-elsewhere'),
    );
    repo.work.set('w-gone', {
      projectId: PROJECT,
      title: 'Deleted task',
      audience: 'internal',
      archived: false,
      deleted: true,
    });
    repo.file.set('f-purged', {
      projectId: PROJECT,
      name: 'old.pdf',
      audience: 'internal',
      clientOrganizationId: null,
      gone: true,
    });
    // The pin groups under PROJECT, but the work item itself now lives where the viewer is no member.
    repo.work.set('w-elsewhere', {
      projectId: OTHER_PROJECT,
      title: 'Secret task',
      audience: 'internal',
      archived: false,
      deleted: false,
    });

    expect(await titles(repo)).toEqual({
      'w-gone': null,
      'v-unknown': null,
      'f-purged': null,
      'w-elsewhere': null,
    });
  });

  it('names a message only where the conversation read would let the viewer in', async () => {
    const repo = fullWorld();
    repo.rows.push(
      pin('pin-1', 'message', 'm-group-member'),
      pin('pin-2', 'message', 'm-group-outsider'),
      pin('pin-3', 'message', 'm-direct-outsider'),
      pin('pin-4', 'message', 'm-channel-no-row'),
      pin('pin-5', 'message', 'm-deleted'),
    );
    repo.message.set('m-group-member', message({ conversationKind: 'group', body: 'Plan' }));
    repo.message.set(
      'm-group-outsider',
      message({ conversationKind: 'group', viewerIsMember: false }),
    );
    repo.message.set(
      'm-direct-outsider',
      message({ conversationKind: 'direct', conversationProjectId: null, viewerIsMember: false }),
    );
    repo.message.set('m-channel-no-row', message({ viewerIsMember: false }));
    repo.message.set('m-deleted', message({ deleted: true }));

    expect(await titles(repo)).toEqual({
      'm-group-member': 'Plan',
      'm-group-outsider': null,
      'm-direct-outsider': null,
      'm-channel-no-row': null,
      'm-deleted': null,
    });
    // An org-wide owner reads a project channel without a membership row, as the chat read does.
    expect((await titles(repo, owner()))['m-channel-no-row']).toBe('Client call notes');
  });

  it('cuts a long message to its first line, at a word, with an ellipsis', () => {
    expect(messageTitle('\n\n  Hello there  \nmore')).toBe('Hello there');
    expect(messageTitle('   ')).toBeNull();
    const long = messageTitle('word '.repeat(40));
    expect(long?.endsWith('\u2026')).toBe(true);
    expect((long ?? '').length).toBeLessThanOrEqual(80);
  });
});
