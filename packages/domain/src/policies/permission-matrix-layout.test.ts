import { describe, expect, it } from 'vitest';
import { CAPABILITIES, MATRIX_NEW_CAPABILITIES } from './capabilities.js';

const KNOWN: ReadonlySet<string> = new Set(CAPABILITIES);
import {
  MATRIX,
  MATRIX_ACTIONS,
  MATRIX_AREAS,
  MATRIX_MERGED_CELLS,
  actionCapabilities,
  areaCapabilities,
  capabilitiesWithoutCell,
  capabilityCell,
  cellsOfCapability,
} from './permission-matrix-layout.js';

/** platform-admin v2 · PA-01 — the matrix layout the editor and the preview draw (SPEC §3.3). */
describe('permission matrix layout', () => {
  it('has 20 areas and 7 actions', () => {
    expect(MATRIX_AREAS).toHaveLength(20);
    expect(MATRIX_ACTIONS).toEqual([
      'view',
      'create',
      'edit',
      'delete',
      'approve',
      'export',
      'manage',
    ]);
  });

  it('every cell is null or an allowlisted capability', () => {
    for (const area of MATRIX_AREAS) {
      for (const action of MATRIX_ACTIONS) {
        const capability = MATRIX[area][action];
        if (capability !== null) expect(KNOWN.has(capability)).toBe(true);
      }
    }
  });

  it('every one of the 62 capabilities has exactly one primary cell', () => {
    expect(CAPABILITIES).toHaveLength(62);
    expect(capabilitiesWithoutCell()).toEqual([]);
    for (const capability of CAPABILITIES) {
      const cell = capabilityCell(capability);
      expect(cell).not.toBeNull();
      expect(MATRIX[cell!.area][cell!.action]).toBe(capability);
    }
  });

  it('declares the 24 new capabilities in the agreed order', () => {
    expect(MATRIX_NEW_CAPABILITIES).toEqual([
      'project.delete',
      'work.delete',
      'work.export',
      'conversation.delete',
      'conversation.export',
      'doc.delete',
      'doc.export',
      'decision.read',
      'decision.write',
      'decision.delete',
      'meeting.delete',
      'file.delete',
      'storage.manage',
      'people.view',
      'people.invite',
      'people.edit',
      'roles.assign',
      'billing.view',
      'billing.manage',
      'settings.view',
      'ai.use',
      'ai.manage',
      'report.view',
      'report.export',
    ]);
  });

  it('merged edit cells share the create capability; projects · view mirrors work.read', () => {
    for (const key of MATRIX_MERGED_CELLS) {
      const [area] = key.split('.') as [keyof typeof MATRIX];
      expect(MATRIX[area].edit).toBe(MATRIX[area].create);
    }
    expect(MATRIX.projects.view).toBe('work.read');
    expect(capabilityCell('work.read')).toEqual({ area: 'work_items', action: 'view' });
    expect(cellsOfCapability('work.read')).toHaveLength(2);
    expect(capabilityCell('doc.write')).toEqual({ area: 'docs', action: 'create' });
  });

  it('52-23 §10: the finance row draws finance.view and finance.manage', () => {
    expect(areaCapabilities('finance')).toEqual(['finance.view', 'finance.manage']);
    expect(capabilityCell('finance.manage')).toEqual({ area: 'finance', action: 'manage' });
  });

  it('60-01: the AI employees row and the brief library cell', () => {
    expect(areaCapabilities('ai_employees')).toEqual(['ai_employee.assign', 'ai_employee.manage']);
    expect(capabilityCell('brief.manage')).toEqual({ area: 'work_items', action: 'manage' });
  });

  it('row and column toggles list each capability once', () => {
    expect(areaCapabilities('docs')).toEqual(['doc.read', 'doc.write', 'doc.delete', 'doc.export']);
    expect(actionCapabilities('export')).toEqual([
      'work.export',
      'conversation.export',
      'doc.export',
      'report.export',
      'audit.export',
    ]);
  });
});
