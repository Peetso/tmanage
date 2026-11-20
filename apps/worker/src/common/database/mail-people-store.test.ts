import { describe, expect, it } from 'vitest';
import { MAIL_PEOPLE_SQL, createMailPeopleDirectory } from './mail-people-store.js';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

interface Person {
  id: string;
  name_en: string;
  name_ar: string;
  role_en: string;
  role_ar: string;
  address: string;
  active: number;
  region: string;
  topic: string;
}

const person = (id: string, region: string, topic: string, active = 1): Person => ({
  id,
  name_en: id,
  name_ar: `${id}-ar`,
  role_en: 'product specialist',
  role_ar: 'أخصائي المنتج',
  address: `${id.toLowerCase()}@tmanageapp.com`,
  active,
  region,
  topic,
});

/** A tiny in-memory registry answering the store's five statements. */
function fakeDatabase(people: Person[], timezone = 'Africa/Cairo') {
  const assignments = new Map<string, string>();
  const key = (org: unknown, user: unknown, topic: unknown) =>
    `${String(org)}|${String(user)}|${String(topic)}`;
  const tx: WorkerTransaction = {
    query<T>(sql: string, params: readonly unknown[] = []): Promise<T> {
      const [a, b, c, d, , f] = params;
      let rows: unknown[] = [];
      if (sql === MAIL_PEOPLE_SQL.assigned) {
        const id = assignments.get(key(a, b, c));
        rows = people.filter((p) => p.id === id);
      } else if (sql === MAIL_PEOPLE_SQL.timezone) {
        rows = [{ timezone }];
      } else if (sql === MAIL_PEOPLE_SQL.pick) {
        const load = (id: string) => [...assignments.values()].filter((v) => v === id).length;
        rows = people
          .filter((p) => p.region === a && p.topic === b && p.active === 1)
          .sort((x, y) => load(x.id) - load(y.id) || x.id.localeCompare(y.id))
          .slice(0, 1);
      } else if (sql === MAIL_PEOPLE_SQL.insert) {
        if (!assignments.has(key(a, b, c))) assignments.set(key(a, b, c), String(d));
      } else if (sql === MAIL_PEOPLE_SQL.byId) {
        rows = people.filter((p) => p.id === a);
      } else if (sql === MAIL_PEOPLE_SQL.reassign) {
        const k = key(c, d, params[4]);
        if (assignments.get(k) === f) assignments.set(k, String(a));
      }
      return Promise.resolve(rows as T);
    },
  };
  const database: WorkerDatabase = {
    transaction: (work) => work(tx),
    read: (work) => work(tx),
    end: () => Promise.resolve(),
  };
  return { database, assignments };
}

const REF = { kind: 'assigned', userId: 'user-1', topic: 'features' } as const;

describe('EMAILBUILD — mail people directory', () => {
  const pair = [person('Layla', 'me', 'features'), person('Karim', 'me', 'features')];

  it('keeps the same person for the same user and topic, and spreads users over the pair', async () => {
    const { database } = fakeDatabase([...pair, person('Hana', 'me', 'security')]);
    const directory = createMailPeopleDirectory(database);
    const first = await directory.personFor('org-1', REF, 'en');
    expect(await directory.personFor('org-1', REF, 'en')).toEqual(first);
    const other = await directory.personFor('org-1', { ...REF, userId: 'user-2' }, 'en');
    expect(other?.name).not.toBe(first?.name);
    const security = await directory.personFor('org-1', { ...REF, topic: 'security' }, 'en');
    expect(security?.name).toBe('Hana');
  });

  it('routes by region and writes Arabic names for Arabic readers', async () => {
    const { database } = fakeDatabase([...pair, person('Mei', 'asia', 'features')], 'Asia/Tokyo');
    const directory = createMailPeopleDirectory(database);
    expect((await directory.personFor('org-1', REF, 'ar'))?.name).toBe('Mei-ar');
  });

  it('moves a user off a switched-off person once, to the other of the pair', async () => {
    const people = [...pair];
    const { database } = fakeDatabase(people);
    const directory = createMailPeopleDirectory(database);
    const first = await directory.personFor('org-1', REF, 'en');
    const kept = people.find((p) => p.name_en === first?.name);
    if (kept === undefined) throw new Error('no person');
    kept.active = 0;
    const next = await directory.personFor('org-1', REF, 'en');
    expect(next?.name).not.toBe(first?.name);
    expect(await directory.personFor('org-1', REF, 'en')).toEqual(next);
  });

  it('answers nobody for an empty pair or a test reference', async () => {
    const { database } = fakeDatabase([]);
    const directory = createMailPeopleDirectory(database);
    expect(await directory.personFor('org-1', REF, 'en')).toBeNull();
    expect(await directory.personFor('org-1', { kind: 'test', personId: 'x' }, 'en')).toBeNull();
  });

  it('LANE-Q: a campaign mail is signed by its chosen person, only while switched on', async () => {
    const { database } = fakeDatabase([
      person('Emma', 'west', 'onboarding'),
      person('Liam', 'west', 'security', 0),
    ]);
    const directory = createMailPeopleDirectory(database);
    expect(
      await directory.personFor(undefined, { kind: 'campaign', personId: 'Emma' }, 'en'),
    ).toEqual({
      name: 'Emma',
      role: 'product specialist',
      address: 'emma@tmanageapp.com',
    });
    expect(
      await directory.personFor(undefined, { kind: 'campaign', personId: 'Liam' }, 'en'),
    ).toBeNull();
    expect(
      await directory.personFor(undefined, { kind: 'campaign', personId: 'nobody' }, 'en'),
    ).toBeNull();
  });
});
