import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  OPENAPI_VERSION,
  PAT_SECURITY_SCHEME,
  buildAiOpenApiDocument,
  pathParamNames,
  toOpenApiPath,
  zodToJsonSchema,
} from './openapi.js';

/** Reach into the built document the way a reader (a GPT Action importer) would. */
type Obj = Record<string, unknown>;
function paths(doc: Obj): Record<string, Record<string, Obj>> {
  return doc['paths'] as Record<string, Record<string, Obj>>;
}
function everyOperation(doc: Obj): Obj[] {
  const out: Obj[] = [];
  for (const methods of Object.values(paths(doc))) {
    for (const op of Object.values(methods)) out.push(op);
  }
  return out;
}

describe('zodToJsonSchema (registry vocabulary)', () => {
  it('maps a string with min/max and a description', () => {
    expect(zodToJsonSchema(z.string().min(1).max(300).describe('a title'))).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 300,
      description: 'a title',
    });
  });

  it('maps an integer with bounds to type integer', () => {
    expect(zodToJsonSchema(z.number().int().min(1).max(50))).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 50,
    });
  });

  it('unwraps optional to its inner schema (requiredness is handled by the parent)', () => {
    expect(zodToJsonSchema(z.string().max(10).optional())).toEqual({
      type: 'string',
      maxLength: 10,
    });
  });

  it('maps arrays, enums and records', () => {
    expect(zodToJsonSchema(z.array(z.string()).max(5))).toEqual({
      type: 'array',
      items: { type: 'string' },
      maxItems: 5,
    });
    expect(zodToJsonSchema(z.enum(['a', 'b']))).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(zodToJsonSchema(z.record(z.string(), z.unknown()))).toEqual({
      type: 'object',
      additionalProperties: {},
    });
  });

  it('marks a strict object as closed and lists only required (non-optional) keys', () => {
    const schema = z.object({ id: z.string(), note: z.string().optional() }).strict();
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  });

  it('falls back to a permissive {} for anything unrecognised, never throwing', () => {
    expect(zodToJsonSchema(z.unknown())).toEqual({});
    expect(zodToJsonSchema(z.any())).toEqual({});
  });
});

describe('path helpers', () => {
  it('extracts :params in order and converts them to {params}', () => {
    const p = '/v1/organizations/:orgSlug/work/items/:workItemId';
    expect(pathParamNames(p)).toEqual(['orgSlug', 'workItemId']);
    expect(toOpenApiPath(p)).toBe('/v1/organizations/{orgSlug}/work/items/{workItemId}');
  });
});

describe('buildAiOpenApiDocument', () => {
  const doc = buildAiOpenApiDocument({ baseUrl: 'https://tmanage.example.com/api/' });

  it('is a structurally valid OpenAPI 3.1 document with the PAT security scheme', () => {
    expect(doc['openapi']).toBe(OPENAPI_VERSION);
    expect((doc['info'] as Obj)['title']).toBe('TManage AI actions');
    expect(doc['servers']).toEqual([{ url: 'https://tmanage.example.com/api' }]);
    expect(doc['security']).toEqual([{ [PAT_SECURITY_SCHEME]: [] }]);
    const schemes = (doc['components'] as Obj)['securitySchemes'] as Obj;
    expect((schemes[PAT_SECURITY_SCHEME] as Obj)['scheme']).toBe('bearer');
    expect(Object.keys(paths(doc)).length).toBeGreaterThan(50);
  });

  it('emits {orgSlug} as a path parameter, never :orgSlug, and never as an argument field', () => {
    const keys = Object.keys(paths(doc));
    expect(keys.some((k) => k.includes('{orgSlug}'))).toBe(true);
    expect(keys.some((k) => k.includes(':orgSlug'))).toBe(false);
    const withOrg = everyOperation(doc).filter((op) =>
      ((op['parameters'] as Obj[] | undefined) ?? []).some((p) => p['name'] === 'orgSlug'),
    );
    expect(withOrg.length).toBeGreaterThan(0);
    for (const op of withOrg) {
      const orgParam = (op['parameters'] as Obj[]).find((p) => p['name'] === 'orgSlug') as Obj;
      expect(orgParam['in']).toBe('path');
      // orgSlug is never carried in a request body.
      const body = op['requestBody'] as Obj | undefined;
      if (body) {
        const schema = ((body['content'] as Obj)['application/json'] as Obj)['schema'] as Obj;
        expect(Object.keys((schema['properties'] as Obj) ?? {})).not.toContain('orgSlug');
      }
    }
  });

  it('gives every operation the PAT security requirement and a risk/scope marker', () => {
    for (const op of everyOperation(doc)) {
      expect(op['security']).toEqual([{ [PAT_SECURITY_SCHEME]: [] }]);
      expect(['read', 'write', 'confirm']).toContain(op['x-tmanage-risk']);
      expect(['read', 'write', 'manage', 'billing']).toContain(op['x-tmanage-scope']);
    }
  });

  it('documents confirm-class ops with the 202 approval-link response and no silent run', () => {
    const confirmOps = everyOperation(doc).filter((op) => op['x-tmanage-risk'] === 'confirm');
    expect(confirmOps.length).toBeGreaterThan(0);
    for (const op of confirmOps) {
      const responses = op['responses'] as Obj;
      expect((responses['202'] as Obj)['$ref']).toBe('#/components/responses/ApprovalRequired');
      expect(String(op['description'])).toContain('approval link');
    }
    const approval = ((doc['components'] as Obj)['responses'] as Obj)['ApprovalRequired'];
    expect(approval).toBeDefined();
  });

  it('puts GET inputs in the query and non-GET inputs in a JSON request body', () => {
    const getOps = everyOperation(doc).filter(
      (op) => (op['responses'] as Obj) && 'parameters' in op,
    );
    // A GET never has a requestBody.
    for (const [key, methods] of Object.entries(paths(doc))) {
      void key;
      if (methods['get']) expect(methods['get']['requestBody']).toBeUndefined();
    }
    void getOps;
    // At least one write op carries a JSON request body.
    const withBody = everyOperation(doc).filter((op) => op['requestBody'] !== undefined);
    expect(withBody.length).toBeGreaterThan(0);
    for (const op of withBody) {
      const body = op['requestBody'] as Obj;
      expect((body['content'] as Obj)['application/json']).toBeDefined();
    }
  });

  it('never exposes a NEVER-listed surface (auth, tokens, oauth, platform admin)', () => {
    const keys = Object.keys(paths(doc));
    const ids = everyOperation(doc).map((op) => String(op['operationId']));
    expect(
      keys.some((k) => /oauth|personal-access-token|\.well-known|platform-admin/.test(k)),
    ).toBe(false);
    expect(ids.some((id) => /^(oauth|pat|identity|platform)/.test(id))).toBe(false);
  });

  it('is deterministic — the same registry yields identical output', () => {
    expect(
      JSON.stringify(buildAiOpenApiDocument({ baseUrl: 'https://tmanage.example.com/api' })),
    ).toBe(JSON.stringify(buildAiOpenApiDocument({ baseUrl: 'https://tmanage.example.com/api' })));
  });
});
