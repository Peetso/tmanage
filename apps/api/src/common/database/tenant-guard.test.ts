import { describe, expect, it, vi } from 'vitest';
import {
  analyzeStatement,
  assertTenantScoped,
  isTenantTable,
  NON_TENANT_TABLES,
  TENANT_TABLES,
  TenantGuardViolation,
} from './tenant-guard.js';

/**
 * Unit tests for ADR-0001 layer 3.
 *
 * These run without a server so the analyser can be exercised across many statement shapes
 * cheaply. `test/tenant-isolation.db.test.ts` then proves the same guard against a real
 * MySQL server with real rows — including the case that matters most, which is what the
 * rejected statements *would* have returned had the guard let them through.
 */

const ORG = '0198f4a2-1c00-7000-8000-00000000000a';
const TWIN = '0198f4a2-1c00-7000-8000-000000000009';

const violations = (sql: string, params: readonly unknown[] = []): readonly string[] =>
  analyzeStatement(sql, params, ORG).violations;

const accepts = (sql: string, params: readonly unknown[] = []): void => {
  const found = violations(sql, params);
  expect(found, `expected no violation but got:\n${found.join('\n')}`).toEqual([]);
};

const rejects = (sql: string, params: readonly unknown[] = []): void => {
  expect(violations(sql, params).length, `expected a violation for: ${sql}`).toBeGreaterThan(0);
};

describe('registry', () => {
  it('maps organizations to its own id, every other tenant table to organization_id', () => {
    expect(TENANT_TABLES['organizations']).toBe('id');
    for (const [table, column] of Object.entries(TENANT_TABLES)) {
      if (table === 'organizations') continue;
      expect(column, table).toBe('organization_id');
    }
  });

  it('does not treat global identity tables as tenant-owned', () => {
    for (const table of NON_TENANT_TABLES) expect(isTenantTable(table)).toBe(false);
  });
});

describe('SELECT', () => {
  it('accepts a scoped read', () => {
    accepts('select id, name from projects where organization_id = ? and id = ?', [ORG, 'p1']);
  });

  it('rejects a read with no tenant predicate', () => {
    // The statement MySQL would happily answer with every tenant's projects.
    rejects('select id, name from projects');
    rejects('select id from work_items where state = ?', ['in_progress']);
  });

  it('rejects a predicate bound to a different organization', () => {
    rejects('select id from projects where organization_id = ?', [TWIN]);
  });

  it('rejects an inline literal even when the literal is correct', () => {
    rejects(`select id from projects where organization_id = '${ORG}'`);
  });

  it('does not accept organization_id appearing only in the select list', () => {
    rejects('select organization_id, name from projects');
  });

  it('is not fooled by a string literal that looks like a predicate', () => {
    rejects(`select id from projects where name = 'organization_id = 1'`);
  });

  it('is not fooled by a commented-out predicate', () => {
    rejects('select id from projects -- where organization_id = ?\n');
    rejects('select id from projects /* where organization_id = ? */');
  });

  it('accepts backtick-quoted identifiers', () => {
    accepts('select `id` from `projects` where `organization_id` = ?', [ORG]);
  });

  it('accepts an alias-qualified predicate', () => {
    accepts('select p.id from projects p where p.organization_id = ? order by p.created_at', [ORG]);
  });

  it('accepts IN over bound parameters that are all the active organization', () => {
    accepts('select id from projects where organization_id in (?, ?)', [ORG, ORG]);
  });

  it('rejects IN that smuggles in another organization', () => {
    rejects('select id from projects where organization_id in (?, ?)', [ORG, TWIN]);
  });

  it('accepts a scoped read of the tenant root by its own id', () => {
    accepts('select name from organizations where id = ?', [ORG]);
  });

  it('rejects an unscoped read of the tenant root', () => {
    rejects('select id, name from organizations');
  });

  it('leaves non-tenant tables alone', () => {
    accepts('select id from users where email = ?', ['maya.hassan@northstar.example']);
    accepts('select 1');
    accepts('select id from sessions where refresh_token_hash = ?', ['abc']);
  });
});

describe('joins', () => {
  it('accepts a join where both sides are anchored', () => {
    accepts(
      `select w.title from work_items w join projects p on p.id = w.project_id
        where w.organization_id = ? and p.organization_id = ?`,
      [ORG, ORG],
    );
  });

  it('accepts a join anchored transitively through an organization_id equality', () => {
    accepts(
      `select w.title from work_items w
         join projects p on p.organization_id = w.organization_id and p.id = w.project_id
        where w.organization_id = ?`,
      [ORG],
    );
  });

  it('accepts a join to the tenant root through its id', () => {
    accepts(
      `select p.name from projects p join organizations o on o.id = p.organization_id
        where o.id = ?`,
      [ORG],
    );
  });

  it('rejects a join whose second table is never bound to the tenant', () => {
    // p.id = w.project_id relates the rows but says nothing about p's tenant, so this
    // returns every tenant's projects joined onto our work items.
    rejects(
      `select w.title, p.name from work_items w join projects p on p.id = w.project_id
        where w.organization_id = ?`,
      [ORG],
    );
  });

  it('rejects a comma join with only one side scoped', () => {
    rejects('select * from projects p, work_items w where p.organization_id = ?', [ORG]);
  });

  it('accepts a subquery scoped in its own scope', () => {
    accepts(
      `select id from projects where organization_id = ?
         and id in (select project_id from work_items where organization_id = ?)`,
      [ORG, ORG],
    );
  });

  it('rejects a subquery that loses the predicate', () => {
    rejects(
      `select id from projects where organization_id = ?
         and id in (select project_id from work_items)`,
      [ORG],
    );
  });
});

describe('INSERT', () => {
  it('accepts an insert that writes the active organization', () => {
    accepts('insert into work_items (id, organization_id, project_id, title) values (?, ?, ?, ?)', [
      'w1',
      ORG,
      'p1',
      'Prepare mobile booking flow concepts',
    ]);
  });

  it('rejects an insert that writes some other organization', () => {
    rejects('insert into work_items (id, organization_id, project_id, title) values (?, ?, ?, ?)', [
      'w1',
      TWIN,
      'p1',
      'Prepare mobile booking flow concepts',
    ]);
  });

  it('rejects an insert that omits the tenant key', () => {
    rejects('insert into work_items (id, project_id, title) values (?, ?, ?)', ['w1', 'p1', 't']);
  });

  it('rejects a positional insert with no column list', () => {
    rejects('insert into work_items values (?, ?, ?, ?)', ['w1', ORG, 'p1', 't']);
  });

  it('counts columns correctly across multi-token value expressions', () => {
    accepts(
      'insert into work_items (id, organization_id, project_id, title) values (?, ?, ?, concat(?, ?))',
      ['w1', ORG, 'p1', 'a', 'b'],
    );
    rejects(
      'insert into work_items (id, organization_id, project_id, title) values (?, ?, ?, concat(?, ?))',
      ['w1', TWIN, 'p1', 'a', 'b'],
    );
  });

  it('checks every tuple of a multi-row insert', () => {
    rejects(
      'insert into work_items (id, organization_id, project_id, title) values (?, ?, ?, ?), (?, ?, ?, ?)',
      ['w1', ORG, 'p1', 'a', 'w2', TWIN, 'p2', 'b'],
    );
  });

  it('accepts the SET form when it derives the organization from context', () => {
    accepts('insert into work_items set id = ?, organization_id = ?, project_id = ?, title = ?', [
      'w1',
      ORG,
      'p1',
      't',
    ]);
  });

  it('requires the SELECT half of INSERT … SELECT to be scoped', () => {
    accepts(
      `insert into work_items (id, organization_id, project_id, title)
       select ?, organization_id, id, ? from projects where organization_id = ?`,
      ['w1', 'title', ORG],
    );
    rejects(
      `insert into work_items (id, organization_id, project_id, title)
       select ?, organization_id, id, ? from projects`,
      ['w1', 'title'],
    );
  });

  it('FIX4: accepts an upsert whose update arm calls a function with a bound value', () => {
    accepts(
      `insert into user_preferences
         (id, organization_id, membership_id, prefs_json, created_at, updated_at)
       values (?, ?, ?, ?, current_timestamp(3), current_timestamp(3))
       on duplicate key update prefs_json = json_merge_patch(prefs_json, ?),
                               updated_at = current_timestamp(3)`,
      ['u1', ORG, 'm1', '{}', '{"coachMarks":{}}'],
    );
    rejects(
      `insert into user_preferences (id, organization_id, membership_id, prefs_json)
       values (?, ?, ?, ?) on duplicate key update prefs_json = json_merge_patch(prefs_json, ?)`,
      ['u1', TWIN, 'm1', '{}', ORG],
    );
  });

  it('FIX4: scalar subqueries in a projection are scoped by their own predicates', () => {
    accepts('select exists(select 1 from projects where organization_id = ?) as a', [ORG]);
    accepts(
      `select exists(select 1 from projects where organization_id = ?)
           or (select count(*) from memberships where organization_id = ? and status = ?) > 1 as a,
         exists(select 1 from work_items where organization_id = ?) as b`,
      [ORG, ORG, 'active', ORG],
    );
    // An unscoped or wrongly scoped subquery is still refused.
    rejects('select exists(select 1 from projects) as a');
    rejects('select exists(select 1 from projects where organization_id = ?) as a', [TWIN]);
    // A correlated predicate inside a projection subquery never scopes the outer rows.
    rejects(
      'select (select count(*) from work_items w where projects.organization_id = ?) as n from projects',
      [ORG],
    );
  });

  it('rejects an ON DUPLICATE KEY UPDATE that rewrites the tenant key', () => {
    rejects(
      `insert into work_items (id, organization_id, project_id, title) values (?, ?, ?, ?)
       on duplicate key update organization_id = ?`,
      ['w1', ORG, 'p1', 't', TWIN],
    );
  });
});

describe('UPDATE and DELETE', () => {
  it('accepts a scoped update', () => {
    accepts('update work_items set state = ? where organization_id = ? and id = ?', [
      'done',
      ORG,
      'w1',
    ]);
  });

  it('rejects a bulk update with no tenant predicate', () => {
    rejects('update work_items set state = ?', ['done']);
  });

  it('rejects an update that assigns the tenant key', () => {
    rejects('update work_items set organization_id = ? where organization_id = ? and id = ?', [
      TWIN,
      ORG,
      'w1',
    ]);
  });

  it('does not let a SET assignment masquerade as a predicate', () => {
    // `organization_id = ?` appears, bound to the active org — but in the assignment
    // clause, where it moves the row rather than selecting it.
    rejects('update work_items set organization_id = ?', [ORG]);
  });

  describe('a scalar sub-select on the SET value side (0412 offboarding hand-over)', () => {
    // The statement `WorkItemAssigneesRepository.removeMember` sends, as Drizzle renders it.
    const handOver = (subqueryOrg: string): readonly unknown[] => [subqueryOrg, 'm1', ORG, 'u1'];
    const HAND_OVER =
      'update work_items set owner_user_id = (select memberships.user_id from work_item_assignees ' +
      'inner join memberships on memberships.organization_id = work_item_assignees.organization_id ' +
      'and memberships.id = work_item_assignees.membership_id ' +
      'where work_item_assignees.organization_id = ? and work_item_assignees.work_item_id = work_items.id ' +
      "and work_item_assignees.role = 'doer' and work_item_assignees.membership_id <> ? " +
      'order by work_item_assignees.created_at limit 1), version = version + 1 ' +
      'where work_items.organization_id = ? and work_items.owner_user_id = ?';

    it('reads the tenant key inside the sub-select; it does not assign it', () => {
      accepts(HAND_OVER, handOver(ORG));
    });

    it('still requires the sub-select to be scoped to the active organization', () => {
      rejects(HAND_OVER, handOver(TWIN));
      rejects(
        'update work_items set owner_user_id = (select memberships.user_id from memberships ' +
          'where memberships.id = ? limit 1) where organization_id = ? and id = ?',
        ['m1', ORG, 'w1'],
      );
    });

    it('a correlated outer predicate inside the sub-select never scopes the updated rows', () => {
      rejects(
        'update work_items set owner_user_id = (select memberships.user_id from memberships ' +
          'where memberships.organization_id = ? and work_items.organization_id = ? limit 1) ' +
          'where id = ?',
        [ORG, ORG, 'w1'],
      );
    });

    it('still rejects assigning the tenant key, plain, qualified or from a sub-select', () => {
      rejects('update work_items set work_items.organization_id = ? where organization_id = ?', [
        TWIN,
        ORG,
      ]);
      rejects(
        'update work_items set state = ?, organization_id = (select organization_id from projects ' +
          'where organization_id = ? limit 1) where organization_id = ? and id = ?',
        ['done', ORG, ORG, 'w1'],
      );
    });
  });

  it('accepts a scoped delete and rejects an unscoped one', () => {
    accepts('delete from work_items where organization_id = ? and id = ?', [ORG, 'w1']);
    rejects('delete from work_items');
    rejects('delete from work_items where state = ?', ['cancelled']);
  });
});

describe('statements that cannot be scoped at all', () => {
  it('rejects DDL and bulk operations against tenant tables', () => {
    rejects('truncate table work_items');
    rejects('drop table projects');
    rejects('alter table projects add column note varchar(10)');
  });

  it('rejects a payload carrying more than one statement', () => {
    rejects('select id from projects where organization_id = ?; drop table projects', [ORG]);
  });

  it('fails closed on a tenant table it cannot place', () => {
    rejects('select id from (values row(1)) as work_items');
  });
});

describe('assertTenantScoped', () => {
  const context = { organizationId: ORG, correlationId: 'c1' };

  it('throws in enforce mode and reports the tables involved', () => {
    const onEvent = vi.fn();
    expect(() =>
      assertTenantScoped('select * from projects', [], context, { mode: 'enforce', onEvent }),
    ).toThrow(TenantGuardViolation);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0].tenantTables).toEqual(['projects']);
  });

  it('records but does not throw in observe mode', () => {
    const onEvent = vi.fn();
    expect(() =>
      assertTenantScoped('select * from projects', [], context, { mode: 'observe', onEvent }),
    ).not.toThrow();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0].mode).toBe('observe');
  });

  it('never puts parameter values or literals into the event', () => {
    const onEvent = vi.fn();
    assertTenantScoped(
      `select * from projects where name = 'Atlas Website Relaunch' and slug = ?`,
      ['northstar-studio'],
      context,
      { mode: 'observe', onEvent },
    );
    const shape: string = onEvent.mock.calls[0]?.[0].shape;
    expect(shape).not.toContain('Atlas Website Relaunch');
    expect(shape).not.toContain('northstar-studio');
    expect(shape).toContain('?');
  });

  it('permits an audited unscoped statement and records the reason', () => {
    const onEvent = vi.fn();
    expect(() =>
      assertTenantScoped(
        'select id, payload_json from outbox_events where published_at is null limit 100',
        [],
        context,
        {
          mode: 'enforce',
          onEvent,
          allowUnscoped: { reason: 'outbox relay claims events across all organizations' },
        },
      ),
    ).not.toThrow();
    expect(onEvent.mock.calls[0]?.[0].allowedReason).toContain('outbox relay');
  });

  it('refuses an escape hatch without a substantive reason', () => {
    expect(() =>
      assertTenantScoped('select * from projects', [], context, {
        mode: 'enforce',
        allowUnscoped: { reason: 'ok' },
      }),
    ).toThrow(TypeError);
  });
});
