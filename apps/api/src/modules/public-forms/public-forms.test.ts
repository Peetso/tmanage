import { describe, expect, it, vi } from 'vitest';
import type { WorkFormFieldDef, WorkFormRow } from '../../common/database/schema.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AssessPublicWrite } from '../public-abuse/public-abuse.guard.js';
import {
  openDraftToken,
  PublicFormAttachmentGate,
  sealDraftToken,
} from './public-form-attachments.js';
import type { PublicFormsRepository } from './public-forms.repository.js';
import { PublicFormsService } from './public-forms.service.js';
import {
  checkPublicValues,
  isPublicSlug,
  newPublicSlug,
  toPublicDefinition,
} from './public-forms.validate.js';

const ORG_A = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const SECRET = 'test-secret-0123456789abcdef0123456789';
const SCANNER = { kind: 'engine' } as const;
const FIELDS: WorkFormFieldDef[] = [
  { label: 'Name', type: 'text', required: true },
  { label: 'Budget', type: 'number', required: false },
];

describe('52-20 public intake forms', () => {
  it('mints 10-symbol slugs the door accepts, and refuses any other shape', () => {
    const slug = newPublicSlug();
    expect(isPublicSlug(slug)).toBe(true);
    expect(new Set(Array.from({ length: 50 }, newPublicSlug)).size).toBe(50);
    for (const bad of ['short', `${slug}x`, 'ABCDEFGHJK', "a' OR 1=1-", 42]) {
      expect(isPublicSlug(bad)).toBe(false);
    }
  });

  it('shows fields under opaque keys only, never labels as keys or internal ids', () => {
    const definition = toPublicDefinition('Request a design', FIELDS);
    expect(definition.fields.map((f) => f.key)).toEqual(['f1', 'f2']);
    expect(JSON.stringify(definition)).not.toMatch(/organization|project|createdBy|"id"/u);
  });

  it('types and caps every value, rejects unknown keys, and stores by label', () => {
    expect(checkPublicValues(FIELDS, { f1: '  Mona ', f2: 5 })).toEqual({
      Name: 'Mona',
      Budget: 5,
    });
    const refused = (values: unknown) => {
      try {
        checkPublicValues(FIELDS, values);
        return [];
      } catch (error) {
        return (error as { details?: { field: string }[] }).details?.map((d) => d.field) ?? [];
      }
    };
    expect(refused({ f1: 'x'.repeat(201) })).toEqual(['values.f1']);
    expect(refused({ f2: '5' })).toEqual(['values.f1', 'values.f2']);
    expect(refused({ f1: 'a', projectId: 'p', Name: 'b' })).toEqual([
      'values.projectId',
      'values.Name',
    ]);
  });

  it('takes the org from the form row, stores a spam verdict as spam and answers a reference', async () => {
    const form = {
      id: 'form-1',
      name: 'F',
      fieldsJson: FIELDS,
      publicEnabled: true,
    } as unknown as WorkFormRow;
    const insertSubmission = vi.fn().mockResolvedValue('sub-1');
    const repository = {
      findPublishedBySlug: vi.fn().mockResolvedValue({ organizationId: ORG_A, id: 'form-1' }),
      findForm: vi.fn().mockResolvedValue(form),
      insertSubmission,
    } as unknown as PublicFormsRepository;
    const run = (_c: unknown, work: (db: unknown) => unknown) => work({});
    const database = {
      bootstrapRead: (_o: unknown, work: (db: unknown) => unknown) => work({}),
      read: run,
      transaction: run,
    } as unknown as TenantDatabase;
    const assess = vi
      .fn()
      .mockResolvedValue({ decision: 'spam', score: 90, reasons: ['honeypot'] });
    const service = new PublicFormsService(
      database,
      repository,
      { create: vi.fn() },
      assess as AssessPublicWrite,
      new PublicFormAttachmentGate(database, repository, SCANNER, SECRET),
    );

    await expect(
      service.submit({
        slug: 'NOT-A-SLUG',
        body: {},
        ip: undefined,
        acceptLanguage: undefined,
        correlationId: ORG_A,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(repository.findPublishedBySlug).not.toHaveBeenCalled();

    const result = await service.submit({
      slug: newPublicSlug(),
      body: { values: { f1: 'Mona' }, organizationId: 'org-B' },
      ip: '203.0.113.9',
      acceptLanguage: 'ar',
      correlationId: ORG_A,
    });
    expect(result).toMatchObject({
      kind: 'stored',
      reference: expect.stringMatching(/^REQ-[A-Z2-9]{6}$/u),
    });
    const [, context, row] = insertSubmission.mock.calls[0] as [
      unknown,
      { organizationId: string },
      { state: string },
    ];
    expect(context.organizationId).toBe(ORG_A);
    expect(row.state).toBe('spam');
    expect(assess).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'form_submit', orgId: ORG_A }),
    );
  });
});

describe('52-20a public form attachments', () => {
  const PROJECT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c';
  const formRow = (attachmentProjectId: string | null) =>
    ({
      id: 'form-1',
      name: 'F',
      fieldsJson: FIELDS,
      publicEnabled: true,
      createdBy: 'author-1',
      attachmentProjectId,
    }) as unknown as WorkFormRow;
  const run = (_c: unknown, work: (db: unknown) => unknown) => work({});
  const database = {
    bootstrapRead: (_o: unknown, work: (db: unknown) => unknown) => work({}),
    read: run,
    transaction: run,
  } as unknown as TenantDatabase;
  const gateFor = (
    attachmentProjectId: string | null,
    scanner = SCANNER as { kind: 'none' | 'engine' },
  ) => {
    const repository = {
      findPublishedBySlug: vi.fn().mockResolvedValue({ organizationId: ORG_A, id: 'form-1' }),
      findForm: vi.fn().mockResolvedValue(formRow(attachmentProjectId)),
      findSubmission: vi.fn().mockResolvedValue(null),
      insertSubmission: vi.fn().mockResolvedValue('sub'),
    };
    const gate = new PublicFormAttachmentGate(
      database,
      repository as unknown as PublicFormsRepository,
      scanner,
      SECRET,
    );
    return { gate, repository };
  };
  const slug = newPublicSlug();

  it('opens only a token it sealed, unexpired', () => {
    const claims = {
      organizationId: ORG_A,
      formId: 'form-1',
      submissionId: 's-1',
      expiresAt: 2_000,
    };
    const token = sealDraftToken(claims, SECRET);
    expect(openDraftToken(token, SECRET, 1_000)).toEqual(claims);
    expect(openDraftToken(token, SECRET, 2_000)).toBeNull();
    expect(openDraftToken(token, 'other-secret', 1_000)).toBeNull();
    expect(openDraftToken(`${token}x`, SECRET, 1_000)).toBeNull();
  });

  it('offers attachments only when the owner allows them and a scanner runs', async () => {
    await expect(gateFor(null).gate.openDraft(slug, ORG_A)).rejects.toMatchObject({
      status: 409,
      auditCode: 'attachments_disabled',
    });
    await expect(
      gateFor(PROJECT, { kind: 'none' }).gate.openDraft(slug, ORG_A),
    ).rejects.toMatchObject({ status: 409 });
    await expect(gateFor(null).gate.uploadTarget(slug, 'x', ORG_A)).rejects.toMatchObject({
      status: 409,
    });
    expect(gateFor(null).gate.rule(formRow(null))).toBeNull();
  });

  it('never names the attachment project in the public form response', async () => {
    const { gate, repository } = gateFor(PROJECT);
    const service = new PublicFormsService(
      database,
      repository as unknown as PublicFormsRepository,
      { create: vi.fn() },
      vi.fn() as unknown as AssessPublicWrite,
      gate,
    );
    const view = await service.publicDefinition(slug, ORG_A);
    expect(view.attachments).not.toBeNull();
    expect(JSON.stringify(view)).not.toContain(PROJECT);
  });

  it("binds an upload to this form's owner, project and token submission only", async () => {
    const { gate } = gateFor(PROJECT);
    const { uploadToken } = await gate.openDraft(slug, ORG_A);
    const { context, target } = await gate.uploadTarget(slug, uploadToken, ORG_A);
    expect(context.organizationId).toBe(ORG_A);
    expect(target).toMatchObject({ projectId: PROJECT, ownerUserId: 'author-1' });
    const exp = Math.floor(Date.now() / 1000) + 600;
    const otherForm = sealDraftToken(
      { organizationId: ORG_A, formId: 'form-2', submissionId: 's', expiresAt: exp },
      SECRET,
    );
    const otherOrg = sealDraftToken(
      { organizationId: 'org-B', formId: 'form-1', submissionId: 's', expiresAt: exp },
      SECRET,
    );
    for (const token of [otherForm, otherOrg, undefined]) {
      await expect(gate.uploadTarget(slug, token, ORG_A)).rejects.toMatchObject({ status: 400 });
    }
  });

  it('stores the submission under the token id, once', async () => {
    const { gate, repository } = gateFor(PROJECT);
    const service = new PublicFormsService(
      database,
      repository as unknown as PublicFormsRepository,
      { create: vi.fn() },
      null,
      gate,
    );
    const { uploadToken } = await gate.openDraft(slug, ORG_A);
    const { target } = await gate.uploadTarget(slug, uploadToken, ORG_A);
    const submit = () =>
      service.submit({
        slug,
        body: { values: { f1: 'Mona' }, uploadToken },
        ip: undefined,
        acceptLanguage: undefined,
        correlationId: ORG_A,
      });
    await submit();
    expect(repository.insertSubmission.mock.calls[0]?.[2]).toMatchObject({
      id: target.submissionId,
    });
    repository.findSubmission.mockResolvedValue({ id: target.submissionId });
    await expect(submit()).rejects.toMatchObject({ status: 409 });
  });
});
