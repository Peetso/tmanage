import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { FieldCipher } from '@tmanage/domain/field-cipher';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { PLATFORM_PERMISSION_METADATA } from '../platform-admin/require-platform-permission.decorator.js';
import { THROTTLE_POLICY } from '../rate-limits/throttle-policies.js';
import { isSecurityReportReference, parseSecurityReport } from './security-report-content.js';
import {
  PlatformSecurityReportsController,
  PublicSecurityReportsController,
} from './security-reports.controller.js';
import type { SecurityReportRecord, SecurityReportStore } from './security-reports.repository.js';
import { SecurityReportsService } from './security-reports.service.js';

const cipher = {
  enabled: true,
  encrypt: (plain: string, aad: { ownerId: string }) => `fc1.reporter_email.1.${aad.ownerId}.x.y`,
  decrypt: () => 'r@example.com',
} as unknown as FieldCipher;
const actor = { account: { userId: 'u-1', email: 'op@example.com' } } as PlatformAdminActor;
const ctx = { correlationId: 'c-1', ip: null, userAgent: null };
const report = {
  title: 'IDOR on files',
  body: 'Steps: a < b, then GET /x',
  email: 'R@example.com',
};

function setup(decision?: 'allow' | 'spam') {
  const rows: SecurityReportRecord[] = [];
  const audits: unknown[] = [];
  const store: SecurityReportStore = {
    insert: vi.fn((row: SecurityReportRecord) => (rows.push(row), Promise.resolve())),
    markAcknowledged: vi.fn(() => Promise.resolve()),
    list: () => Promise.resolve(rows),
    findAudited: (id) => Promise.resolve(rows.find((r) => r.id === id) ?? null),
    updateAudited: (id, change) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return Promise.resolve(null);
      const { next, audit } = change(row);
      audits.push(audit);
      return Promise.resolve({ ...row, ...next });
    },
  };
  const send = vi.fn(() => Promise.resolve('sent' as const));
  const assess = decision && (() => Promise.resolve({ decision, score: 0, reasons: [] }));
  const svc = new SecurityReportsService(store, cipher, { send }, assess ?? null);
  const submit = (body: Record<string, unknown>) =>
    svc.submit({ body, ip: '203.0.113.9', acceptLanguage: undefined, correlationId: 'c-1' });
  return { svc, rows, audits, send, store, submit };
}

describe('56-17 vulnerability disclosure', () => {
  it('accepts plain text and refuses HTML, oversize fields and unknown severities', () => {
    expect(parseSecurityReport({ ...report, severity: 'high' }).reporterEmail).toBe(
      'r@example.com',
    );
    const fields = (body: Record<string, unknown>) => {
      try {
        parseSecurityReport(body);
        return [];
      } catch (error) {
        return (error as { details: { field: string }[] }).details.map((d) => d.field);
      }
    };
    expect(fields({ ...report, body: 'see <script>alert(1)</script>' })).toEqual(['body']);
    expect(fields({ ...report, title: 'x'.repeat(201), body: 'y'.repeat(20_001) })).toEqual([
      'title',
      'body',
    ]);
    expect(fields({ ...report, severity: 'urgent', email: 'nope' })).toEqual(['email', 'severity']);
  });

  it('answers a filled honeypot like a success: a reference, nothing stored, nobody mailed', async () => {
    const { submit, rows, send } = setup('allow');
    const result = await submit({ ...report, website: 'http://spam' });
    expect(result.kind === 'accepted' && isSecurityReportReference(result.reference)).toBe(true);
    expect(rows).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('stores the e-mail sealed and acknowledges on the security lane with the reference only', async () => {
    const { submit, rows, send, store } = setup('allow');
    const result = await submit(report);
    expect(Object.keys(result)).toEqual(['kind', 'reference']);
    expect(rows[0]?.reporterEmailEnc).toMatch(/^fc1\.reporter_email\./u);
    expect(JSON.stringify(rows[0])).not.toContain('r@example.com');
    const mail = (send.mock.calls[0] as unknown as [{ text: string; templateKey: string }])[0];
    expect(mail.templateKey).toBe('security_report_ack');
    expect(mail.text).not.toMatch(/IDOR|GET \/x/u);
    expect(store.markAcknowledged).toHaveBeenCalledOnce();
  });

  it('stamps resolved_at on a terminal status and audits the change', async () => {
    const { svc, submit, rows, audits } = setup();
    await submit(report);
    const view = await svc.update(actor, rows[0]!.id, { status: 'fixed', creditPublic: true }, ctx);
    expect(view.resolvedAt).not.toBeNull();
    expect(audits[0]).toMatchObject({ action: 'platform.security_report_updated' });
  });

  it('throttles the door and guards every triage route with settings.edit', () => {
    const meta = (key: symbol, target: object) =>
      new Reflector().get(key, target as unknown as () => void);
    expect(meta(THROTTLE_POLICY, PublicSecurityReportsController.prototype.submit)).toMatchObject({
      name: 'security_report_submit',
      key: 'ip',
    });
    for (const method of ['list', 'get', 'update'] as const) {
      expect(
        meta(PLATFORM_PERMISSION_METADATA, PlatformSecurityReportsController.prototype[method]),
      ).toBe('platform.settings.edit');
    }
  });
});
