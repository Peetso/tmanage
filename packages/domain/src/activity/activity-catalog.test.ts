import { describe, expect, it } from 'vitest';
import { auditObjectTypeFor, isAuditAction } from '../policies/audit.js';
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_ACTION_CATALOG,
  ACTIVITY_KINDS,
  ACTIVITY_SOURCES,
  activityActionsOfKind,
  activityDefinitionFor,
} from './activity-catalog.js';

describe('activity catalogue (62-A2)', () => {
  it('every action is an audit action whose object type is the entry source', () => {
    for (const action of ACTIVITY_ACTIONS) {
      expect(isAuditAction(action), action).toBe(true);
      if (isAuditAction(action)) {
        expect(auditObjectTypeFor(action), action).toBe(ACTIVITY_ACTION_CATALOG[action].source);
      }
    }
  });

  it('money sources are finance entries and nothing else is', () => {
    const money = new Set(['client_invoice', 'quote', 'expense']);
    for (const action of ACTIVITY_ACTIONS) {
      const definition = ACTIVITY_ACTION_CATALOG[action];
      if (money.has(definition.source)) expect(definition.finance, action).toBe(true);
      if (definition.finance) expect(definition.kind, action).toBe('money');
    }
  });

  it('every source and kind is used, so no read rule is dead', () => {
    const sources = new Set(ACTIVITY_ACTIONS.map((a) => ACTIVITY_ACTION_CATALOG[a].source));
    expect([...sources].sort()).toEqual([...ACTIVITY_SOURCES].sort());
    for (const kind of ACTIVITY_KINDS) {
      expect(activityActionsOfKind(kind).length, kind).toBeGreaterThan(0);
    }
  });

  it('noise and deletions are not catalogued', () => {
    for (const action of [
      'file_asset.downloaded',
      'file_preview.viewed',
      'file_asset.scanned',
      'work_item.deleted',
      'project.exported',
      'session_revoked',
    ]) {
      expect(activityDefinitionFor(action), action).toBeNull();
    }
    expect(activityDefinitionFor('approval.approved')).toEqual({
      kind: 'approvals',
      source: 'approval',
      finance: false,
    });
  });
});
