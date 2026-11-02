import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CLIENT_ROLES,
  INTERNAL_ROLES,
  capabilitySetFor,
  customRoleKey,
  hasCapability,
  isInternalOnlyCapability,
} from './capabilities.js';

/** 52-23 §10 — `finance.view` / `finance.manage` replace the `project.manage` / `workspace.manage` stand-ins. */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROLE_ID = '0199aa00-0000-7000-8000-0000000000f1';
const MANAGE = new Set(['owner', 'org_admin', 'workspace_admin', 'platform_support']);

describe('finance capabilities', () => {
  it('role grid: manage = the workspace.manage holders, view = the project.manage holders, no client', () => {
    expect(CAPABILITIES.slice(-2)).toEqual(['finance.view', 'finance.manage']);
    for (const role of [...INTERNAL_ROLES, ...CLIENT_ROLES]) {
      expect(hasCapability(role, 'finance.manage'), role).toBe(MANAGE.has(role));
      expect(hasCapability(role, 'finance.manage')).toBe(hasCapability(role, 'workspace.manage'));
      expect(hasCapability(role, 'finance.view')).toBe(hasCapability(role, 'project.manage'));
    }
    expect(hasCapability('manager', 'finance.view')).toBe(true);
    expect(
      isInternalOnlyCapability('finance.view') && isInternalOnlyCapability('finance.manage'),
    ).toBe(true);
  });

  it('a 14-nibble mask minted with 56 keys decodes the same set and no finance key', () => {
    const held = ['org.manage', 'workspace.manage', 'report.export'];
    const legacy = customRoleKey(ROLE_ID, held).slice(0, -1);
    expect([...capabilitySetFor(legacy)].sort()).toEqual([...held].sort());
    expect(capabilitySetFor(customRoleKey(ROLE_ID, ['finance.manage'])).has('finance.manage')).toBe(
      true,
    );
  });

  it('every finance route guard asks a finance key: GET view, writes manage', () => {
    const source = readFileSync(
      `${ROOT}/apps/api/src/modules/finance/finance.controller.ts`,
      'utf8',
    );
    const guards = [
      ...source.matchAll(/@(Get|Post|Put)\([^)]*\)\s*@RequireCapability\('([^']+)'\)/g),
    ];
    expect(guards).toHaveLength(9); // 52-23's 8 + 52-28 GET tax-document-rules (R19-a)
    for (const [, verb, capability] of guards) {
      expect(capability).toBe(verb === 'Get' ? 'finance.view' : 'finance.manage');
    }
  });

  it('0264 dry run: workspace.manage gains both, project.manage gains view, second run is a no-op', () => {
    const sql = readFileSync(
      `${ROOT}/apps/api/migrations/0264_finance_capability_backfill.sql`,
      'utf8',
    );
    const steps = [
      ...sql.matchAll(
        /'\$', '([^']+)'\)\s+WHERE[^;]*JSON_QUOTE\('([^']+)'\)\)\s+AND NOT JSON_CONTAINS\(capabilities_json, JSON_QUOTE\('([^']+)'\)\);/g,
      ),
    ];
    expect(steps).toHaveLength(3);
    const roles = [['workspace.manage'], ['project.manage'], ['work.read']];
    const run = () => {
      for (const [, add, from, guard] of steps) {
        for (const r of roles) if (r.includes(from!) && !r.includes(guard!)) r.push(add!);
      }
    };
    run();
    const once = JSON.stringify(roles);
    run();
    expect(JSON.stringify(roles)).toBe(once);
    expect(roles).toEqual([
      ['workspace.manage', 'finance.manage', 'finance.view'],
      ['project.manage', 'finance.view'],
      ['work.read'],
    ]);
    expect(sql.match(/AND NOT EXISTS \(/g)).toHaveLength(2);
  });
});
