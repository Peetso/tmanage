import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  buildApiReference,
  filterGroups,
  typeLabel,
} from '../src/components/website/pages/developers/api-reference';
import { ReferenceExplorer } from '../src/components/website/pages/developers/DevelopersPage';
import snapshot from '../src/content/developers/openapi-snapshot.json';

/** 54-04 — the developer portal's API reference, built from the committed contract snapshot. */

const SPEC = {
  info: { title: 'T', version: '1' },
  tags: [{ name: 'Projects' }, { name: 'Work' }],
  paths: {
    '/orgs/{orgSlug}/projects': {
      parameters: [{ $ref: '#/components/parameters/Org' }],
      get: {
        tags: ['Projects'],
        operationId: 'listProjects',
        parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Project' } },
              },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/work': {
      post: {
        tags: ['Work'],
        operationId: 'createWork',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Project' } } },
        },
        responses: { '201': { description: 'created' } },
      },
    },
  },
  components: {
    parameters: {
      Org: { name: 'orgSlug', in: 'path', required: true, schema: { type: 'string' } },
    },
    responses: { NotFound: { description: 'missing' } },
    schemas: {
      Project: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } },
      },
    },
  },
};

describe('buildApiReference', () => {
  const ref = buildApiReference(SPEC);

  it('groups operations by tag in the contract order, with resolved params and responses', () => {
    expect(ref.groups.map((g) => g.tag)).toEqual(['Projects', 'Work']);
    const list = ref.groups[0]!.operations[0]!;
    expect(list).toMatchObject({ id: 'listProjects', method: 'get' });
    expect(list.params).toEqual([
      { name: 'orgSlug', in: 'path', required: true, type: 'string' },
      { name: 'cursor', in: 'query', required: false, type: 'string' },
    ]);
    expect(list.responses).toEqual([
      { status: '200', description: 'ok', schema: 'Project[]' },
      { status: '404', description: 'missing', schema: null },
    ]);
    expect(ref.groups[1]!.operations[0]!.requestSchema).toBe('Project');
  });

  it('lists schema fields with their types and required flags', () => {
    expect(ref.schemas[0]).toEqual({
      name: 'Project',
      fields: [
        { name: 'id', type: 'string (uuid)', required: true },
        { name: 'name', type: 'string', required: false },
      ],
    });
    expect(typeLabel({ enum: ['a', 'b'] })).toBe('a | b');
  });

  it('searches by method, path, id or tag', () => {
    expect(filterGroups(ref.groups, 'post').map((g) => g.tag)).toEqual(['Work']);
    expect(filterGroups(ref.groups, 'listprojects')[0]!.operations).toHaveLength(1);
    expect(filterGroups(ref.groups, 'nothing-here')).toEqual([]);
  });

  it('builds every operation of the committed contract', () => {
    const real = buildApiReference(snapshot);
    expect(real.operationCount).toBeGreaterThan(20);
    for (const g of real.groups) for (const op of g.operations) expect(op.path).toMatch(/^\//);
  });
});

describe('ReferenceExplorer', () => {
  it('narrows the list as the visitor types and says when nothing matches', () => {
    render(<ReferenceExplorer reference={buildApiReference(SPEC)} />);
    expect(screen.getByText('/orgs/{orgSlug}/projects')).toBeTruthy();
    const search = screen.getByLabelText('Search endpoints');
    fireEvent.change(search, { target: { value: 'createWork' } });
    expect(screen.queryByText('/orgs/{orgSlug}/projects')).toBeNull();
    expect(screen.getByText('/work')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByRole('status').textContent).toBe('No endpoint matches your search.');
  });
});
