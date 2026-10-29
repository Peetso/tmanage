import { describe, expect, it } from 'vitest';
import {
  EXPORT_ROW_CAP,
  EXPORT_TTL_MS,
  exportExpiry,
  exportFileName,
  exportObjectKey,
  normalizeFilter,
  requireScope,
  signInsToCsv,
  viewStatus,
} from './exports.js';
import { EXPORT_SQL } from './exports.repository.js';

/** platform-admin v2 · PA-09 — C6 exports: scope → filter, size cap, 24 h expiry, file key, delete. */

const JOB = '0199aa00-0000-7000-8000-0000000000f1';

describe('export rules', () => {
  it('accepts the six scopes and nothing else', () => {
    for (const scope of ['actions', 'sign-ins', 'sessions', 'platform', 'orgs', 'people']) {
      expect(requireScope(scope)).toBe(scope);
    }
    expect(() => requireScope('messages')).toThrow();
  });

  it('keeps only the scope’s filter keys', () => {
    expect(
      normalizeFilter('actions', {
        organizationId: 'org',
        supportOnly: true,
        hasChanges: true,
        body: 'x',
        result: '',
      }),
    ).toEqual({ organizationId: 'org', supportOnly: 'true' });
    expect(normalizeFilter('platform', { adminId: 'a', organizationId: 'o', q: 'x' })).toEqual({
      adminId: 'a',
      organizationId: 'o',
    });
    expect(() => normalizeFilter('actions', { action: 'x'.repeat(201) })).toThrow();
    expect(() => normalizeFilter('actions', [])).toThrow();
  });

  it('caps one file and lets it live 24 hours', () => {
    expect(EXPORT_ROW_CAP).toBe(50_000);
    expect(EXPORT_TTL_MS).toBe(86_400_000);
    const finished = new Date('2026-10-28T14:06:00.000Z');
    expect(exportExpiry(finished).toISOString()).toBe('2026-10-29T14:06:00.000Z');
    expect(EXPORT_SQL.finishReady).toContain('interval 24 hour');
  });

  it('shows a ready file past its expiry as expired', () => {
    const now = new Date('2026-10-29T15:00:00.000Z');
    expect(viewStatus('ready', new Date('2026-10-29T14:06:00.000Z'), now)).toBe('expired');
    expect(viewStatus('ready', new Date('2026-10-29T16:00:00.000Z'), now)).toBe('ready');
    expect(viewStatus('running', null, now)).toBe('running');
  });

  it('keys the file under an unguessable private path', () => {
    const key = exportObjectKey(JOB);
    expect(key).toMatch(new RegExp(`^platform/exports/${JOB}/[0-9a-f]{32}\\.csv$`, 'u'));
    expect(exportObjectKey(JOB)).not.toBe(key);
    expect(exportFileName({ scope: 'actions', createdAt: '2026-10-28T14:06:00.000Z' })).toBe(
      'tmanage-actions-2026-10-28.csv',
    );
  });

  it('deletes by status, never by DELETE', () => {
    expect(EXPORT_SQL.markDeleted).toMatch(/^update platform_export_jobs set status = 'deleted'/u);
    expect(Object.values(EXPORT_SQL).join('\n')).not.toMatch(/\bdelete\s+from\b/iu);
  });

  it('writes sign-ins with the action log export’s formula guard and quoting', () => {
    const csv = signInsToCsv([
      {
        id: 'e1',
        userId: null,
        email: '=cmd@x.co',
        displayName: null,
        action: 'password_sign_in',
        outcome: 'failed',
        reason: 'no_such_user',
        ip: '185.220.101.4',
        userAgent: 'curl/8.4, x',
        correlationId: null,
        occurredAt: '2026-10-28T14:02:40.000Z',
      },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('occurredAt,email,action,outcome,reason,ip,device,correlationId');
    expect(lines[1]).toBe(
      '2026-10-28T14:02:40.000Z,\'=cmd@x.co,password_sign_in,failed,no_such_user,185.220.101.4,"curl/8.4, x",',
    );
  });
});
