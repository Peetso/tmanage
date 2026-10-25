import { describe, expect, it } from 'vitest';
import { OPS, findOpById } from './index.js';
import { grantCoversOp } from '../../mcp/catalog-runtime.js';

/**
 * Wave 9 S7 — security audit run 1, F11 / F12a / F33: the registry labels are the only thing the
 * hosted `/mcp` runtime gates scope and approval on, so they must say what an op does.
 *
 * - Every non-read op behind the admin capability `org.manage` needs the opt-in `manage` scope
 *   (or `billing` for billing ops) — never the default everyday `write`.
 * - Role, session and security-policy changes are confirm-class (a person approves in TManage).
 * - Ops that widen what a client organization can see are never plain `write`.
 */

const DEFAULT_GRANT = 'tmanage:read tmanage:write';
const MANAGE_GRANT = 'tmanage:read tmanage:write tmanage:manage';

/** Role, session and org security-policy changes (F11, F12a). */
const ROLE_SESSION_SECURITY_OPS = [
  'admin.members.bulk_role.create',
  'members.role.update',
  'admin.sessions.revoke.create',
  'settings.set',
  'settings.organization.update',
  'admin.feature_flags.set',
  'settings.download_scan_policy.update',
];

/** Ops that widen what a client organization sees (F33). */
const CLIENT_EXPOSURE_OPS = [
  'projects.clients.create',
  'projects.client.update',
  'projects.portal_settings.set',
  'client_memberships.create',
  'client_memberships.update',
  'portal.client_members.create',
  'portal.branding.set',
];

describe('F11/F12a — admin ops are never reachable with the everyday write scope', () => {
  it('every non-read org.manage op needs manage (or billing)', () => {
    const underScoped = OPS.filter(
      (op) =>
        op.capability === 'org.manage' &&
        op.risk !== 'read' &&
        op.scope !== 'manage' &&
        op.scope !== 'billing',
    ).map((op) => `${op.id} (${op.risk}/${op.scope})`);
    expect(underScoped).toEqual([]);
  });

  it('role, session and security-policy changes are confirm-class under manage', () => {
    for (const id of ROLE_SESSION_SECURITY_OPS) {
      const op = findOpById(id);
      expect(op, id).toBeDefined();
      expect(op!.risk, id).toBe('confirm');
      expect(op!.scope, id).toBe('manage');
    }
  });

  it('a read+write grant does not cover bulk role change or settings.set (exploit refused)', () => {
    expect(grantCoversOp(DEFAULT_GRANT, findOpById('admin.members.bulk_role.create')!)).toBe(false);
    expect(grantCoversOp(DEFAULT_GRANT, findOpById('settings.set')!)).toBe(false);
    expect(grantCoversOp(DEFAULT_GRANT, findOpById('admin.sessions.revoke.create')!)).toBe(false);
  });

  it('a manage grant covers them, and they stay confirm-class (approval, never a direct run)', () => {
    const op = findOpById('admin.members.bulk_role.create')!;
    expect(grantCoversOp(MANAGE_GRANT, op)).toBe(true);
    expect(op.risk).toBe('confirm');
  });

  it('everyday writes still work under the default grant', () => {
    const create = findOpById('work_items.create');
    expect(create).toBeDefined();
    expect(grantCoversOp(DEFAULT_GRANT, create!)).toBe(true);
  });
});

describe('F33 — client-exposure-widening ops are never plain write', () => {
  it('each named op is confirm-class under manage', () => {
    for (const id of CLIENT_EXPOSURE_OPS) {
      const op = findOpById(id);
      expect(op, id).toBeDefined();
      expect(op!.risk, id).toBe('confirm');
      expect(op!.scope, id).toBe('manage');
    }
  });

  it('no non-read op on a project-clients, client-membership or portal-settings path is write', () => {
    const exposure = /\/(clients|client|client-memberships|client-members|portal-settings)(\/|$)/;
    const plainWrites = OPS.filter(
      (op) => op.risk === 'write' && exposure.test(op.path) && !op.path.includes('client-requests'),
    ).map((op) => op.id);
    expect(plainWrites).toEqual([]);
  });

  it('a read+write grant cannot share a project with a client organization', () => {
    expect(grantCoversOp(DEFAULT_GRANT, findOpById('projects.clients.create')!)).toBe(false);
  });
});
