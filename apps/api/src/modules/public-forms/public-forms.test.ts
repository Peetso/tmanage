import { describe, expect, it, vi } from 'vitest';
import type { WorkFormFieldDef, WorkFormRow } from '../../common/database/schema.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AssessPublicWrite } from '../public-abuse/public-abuse.guard.js';
import type { PublicFormsRepository } from './public-forms.repository.js';
import { PublicFormsService } from './public-forms.service.js';
import {
  checkPublicValues,
  isPublicSlug,
  newPublicSlug,
  toPublicDefinition,
} from './public-forms.validate.js';

const ORG_A = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
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
