import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { PendingAiActionRow } from '../../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../../common/database/tenant-context.js';
import { REQUIRED_CAPABILITY } from '../../../common/http/decorators.js';
import { ClientInvoicesController } from '../../finance/client-invoices.controller.js';
import { allDetailsById } from '../../mcp/tool-catalog.js';
import { freezeConfirmAction, verifyFrozenAction } from '../../mcp/pending-actions.js';
import { PendingAiActionsService } from '../../mcp/pending-actions.service.js';
import type { PendingAiActionsRepository } from '../../mcp/pending-actions.repository.js';
import { PortalInvoicesController } from '../../portal/portal-invoices.controller.js';
import { PublicFormsAdminController } from '../../public-forms/public-forms.controller.js';
import { QuotesController } from '../../quotes/quotes.controller.js';
import { TimeLocksController } from '../../time/locks.controller.js';
import {
  FINANCE_DOCUMENTS_STILL_NEVER,
  financeDocumentDetails,
  financeDocumentOps,
} from './finance-documents.js';
import { findOpById, findOpByRoute, neverByKey, routeKey, sensitivityOf } from './index.js';

/**
 * 52-22 (MCPWRITE). The quote, invoice, lock-request and form-triage routes left NEVER for ops:
 * (a) each runs under its route's capability, re-checked as the approving member; (b) one approval
 * is bound to one op and its exact arguments; (c) money, lock changes, export and files stay NEVER.
 */
const CONFIRM = [
  'quotes.send',
  'quotes.convert',
  'client_invoices.send',
  'client_invoices.mark_sent',
  'client_invoices.reminders.create',
  'client_invoices.label.set',
  'client_invoices.tax_registration.create',
  'work_forms.publish',
  'work_forms.submissions.convert',
];

const HANDLERS: readonly (readonly [object, string, string])[] = [
  [QuotesController, 'list', 'quotes.list'],
  [QuotesController, 'create', 'quotes.create'],
  [QuotesController, 'get', 'quotes.get'],
  [QuotesController, 'update', 'quotes.update_draft'],
  [QuotesController, 'send', 'quotes.send'],
  [QuotesController, 'convert', 'quotes.convert'],
  [ClientInvoicesController, 'list', 'client_invoices.list'],
  [ClientInvoicesController, 'create', 'client_invoices.create'],
  [ClientInvoicesController, 'aging', 'client_invoices.aging'],
  [ClientInvoicesController, 'get', 'client_invoices.get'],
  [ClientInvoicesController, 'update', 'client_invoices.update_draft'],
  [ClientInvoicesController, 'pull', 'client_invoices.pull'],
  [ClientInvoicesController, 'send', 'client_invoices.send'],
  [ClientInvoicesController, 'markSent', 'client_invoices.mark_sent'],
  [ClientInvoicesController, 'reminder', 'client_invoices.reminders.create'],
  [ClientInvoicesController, 'setLabel', 'client_invoices.label.set'],
  [ClientInvoicesController, 'taxRegistration', 'client_invoices.tax_registration.create'],
  [PortalInvoicesController, 'list', 'portal.invoices.list'],
  [PortalInvoicesController, 'get', 'portal.invoices.get'],
  [TimeLocksController, 'list', 'time.locks.list'],
  [TimeLocksController, 'requestUnlock', 'time.locks.unlock_request'],
  [PublicFormsAdminController, 'publish', 'work_forms.publish'],
  [PublicFormsAdminController, 'unpublish', 'work_forms.unpublish'],
  [PublicFormsAdminController, 'list', 'work_forms.submissions.list'],
  [PublicFormsAdminController, 'spam', 'work_forms.submissions.spam'],
  [PublicFormsAdminController, 'convert', 'work_forms.submissions.convert'],
];

const NOW = new Date('2026-11-17T09:00:00.000Z');
const approver = {
  organizationId: 'org-1',
  userId: 'user-1',
  membershipId: 'mem-1',
  correlationId: 'corr-1',
} as unknown as TenantContext;
const SEND = { quoteId: 'q_1', to: 'sara@acme.example' };

function approvalOf(argsJson: Record<string, unknown>) {
  const frozen = freezeConfirmAction('quotes.send', SEND);
  const row = {
    id: 'pa-1',
    organizationId: 'org-1',
    membershipId: 'mem-1',
    userId: 'user-1',
    clientId: 'pat:1',
    clientName: 'Claude',
    opId: 'quotes.send',
    argsJson,
    argsSha256: frozen.argsSha256,
    status: 'pending',
    expiresAt: new Date(NOW.getTime() + 60_000),
    decidedAt: null,
    resultStatus: null,
    resultJson: null,
    createdAt: NOW,
  } as PendingAiActionRow;
  const execute = vi.fn(async (_request: unknown, _grant: unknown, _correlationId: string) => ({
    status: 200,
    body: '{}',
  }));
  const repository = {
    findOwn: vi.fn(async () => ({ row, memberName: 'Maya', memberEmail: 'm@x.test' })),
    decide: vi.fn(async () => 1),
    recordResult: vi.fn(async () => undefined),
  } as unknown as PendingAiActionsRepository;
  const database = {
    read: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
    transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
  } as unknown as TenantDatabase;
  return {
    service: new PendingAiActionsService(database, execute, repository, () => NOW),
    execute,
  };
}

describe('52-22 quotes, invoices, lock requests and form triage on the AI surface', () => {
  it('moves each route out of NEVER once; everything that reaches a client needs approval', () => {
    expect(financeDocumentOps).toHaveLength(26);
    for (const op of financeDocumentOps) {
      expect(findOpByRoute(op.method, op.path), op.id).toBe(op);
      expect(neverByKey.has(routeKey(op.method, op.path)), op.id).toBe(false);
    }
    const confirm = financeDocumentOps.filter((o) => o.risk === 'confirm').map((o) => o.id);
    expect(confirm.sort()).toEqual([...CONFIRM].sort());
    for (const op of financeDocumentOps) {
      if (op.risk === 'confirm') expect(op.scope, op.id).toBe('manage');
      if (op.method === 'GET') expect(op.risk, op.id).toBe('read');
    }
  });

  it('(c) keeps the step-up export and the anonymous form door blocked', () => {
    for (const [method, path] of FINANCE_DOCUMENTS_STILL_NEVER) {
      expect(neverByKey.has(routeKey(method, path)), `${method} ${path}`).toBe(true);
      expect(findOpByRoute(method, path), `${method} ${path}`).toBeUndefined();
    }
    // Parity batch 2: a payment is an op now, but only ever through an approval (money gate).
    const payment = findOpById('client_invoices.payments.record')!;
    expect(payment.risk).toBe('confirm');
    expect(sensitivityOf(payment)).toBe('money');
  });

  it("(a) mirrors each controller's capability, re-checked as the approving member", async () => {
    expect(HANDLERS).toHaveLength(26);
    for (const [ctor, handler, id] of HANDLERS) {
      const method = (ctor as { prototype: Record<string, unknown> }).prototype[handler];
      const required = Reflect.getMetadata(REQUIRED_CAPABILITY, method as object) as unknown;
      expect(required, id).toBeDefined();
      expect(findOpById(id)?.capability, id).toBe(required);
    }
    const { service, execute } = approvalOf(SEND);
    await service.approve(approver, 'studio', 'pa-1');
    expect(execute).toHaveBeenCalledOnce();
    const grant = execute.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(grant).toMatchObject({ userId: 'user-1', membershipId: 'mem-1', opId: 'quotes.send' });
    // No AI-claimed scopes ride along: the guard chain resolves the member's own rights now.
    expect(grant['scopes']).toBeUndefined();
  });

  it('(b) binds one approval to the exact op and arguments, run once', async () => {
    const { argsSha256 } = freezeConfirmAction('quotes.send', SEND);
    expect(verifyFrozenAction('quotes.send', SEND, argsSha256)).toBeDefined();
    const other = { ...SEND, to: 'attacker@evil.example' };
    expect(verifyFrozenAction('quotes.send', other, argsSha256)).toBeUndefined();
    expect(verifyFrozenAction('quotes.convert', { quoteId: 'q_1' }, argsSha256)).toBeUndefined();

    const tampered = approvalOf(other);
    await expect(tampered.service.approve(approver, 'studio', 'pa-1')).rejects.toMatchObject({
      status: 404,
    });
    expect(tampered.execute).not.toHaveBeenCalled();

    const intact = approvalOf(SEND);
    await intact.service.approve(approver, 'studio', 'pa-1');
    expect(intact.execute.mock.calls[0]?.[0]).toEqual({
      method: 'POST',
      url: '/v1/organizations/studio/quotes/q_1/send',
      body: JSON.stringify({ to: 'sara@acme.example' }),
    });
  });

  it('gives each op one strict bilingual detail whose examples parse and extra keys fail', () => {
    expect(financeDocumentDetails.map((d) => d.id).sort()).toEqual(
      financeDocumentOps.map((o) => o.id).sort(),
    );
    for (const d of financeDocumentDetails) {
      expect(allDetailsById.get(d.id), d.id).toBe(d);
      expect(d.descriptionAr?.length ?? 0, d.id).toBeGreaterThan(0);
      expect(d.examples.length, d.id).toBe(2);
      for (const e of d.examples) expect(d.input.safeParse(e.args).success, d.id).toBe(true);
      const first = d.examples[0]?.args ?? {};
      expect(d.input.safeParse({ ...first, orgSlug: 'other' }).success, d.id).toBe(false);
    }
    const send = allDetailsById.get('client_invoices.send');
    expect(send?.input.safeParse({ invoiceId: 'i', to: ['not-an-address'] }).success).toBe(false);
  });
});
