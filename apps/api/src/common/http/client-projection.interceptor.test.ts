import { describe, expect, it } from 'vitest';
import { lastValueFrom, of } from 'rxjs';
import { StreamableFile } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Readable } from 'node:stream';
import { ClientProjectionInterceptor } from './client-projection.interceptor.js';
import { ApiError } from './errors.js';

/**
 * SEC-001's last line of defence, exercised where a body can actually be forced.
 *
 * The database suite proves the projections do not produce forbidden fields. This proves the
 * interceptor would catch it if one ever did — which is a different fact, and the only one that
 * says anything about the day somebody changes a projection.
 */

function contextFor(url: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ url }) }),
  } as unknown as ExecutionContext;
}

function handlerReturning(body: unknown): CallHandler {
  return { handle: () => of(body) };
}

const interceptor = new ClientProjectionInterceptor();

async function run(url: string, body: unknown): Promise<unknown> {
  return lastValueFrom(interceptor.intercept(contextFor(url), handlerReturning(body)));
}

describe('the client projection boundary', () => {
  it('lets an ordinary client response through untouched', async () => {
    const body = { requests: [{ id: 'req-1', title: 'Add a careers page', status: 'submitted' }] };
    await expect(run('/v1/organizations/atlas/portal/requests', body)).resolves.toBe(body);
  });

  it('refuses a client response carrying a forbidden field', async () => {
    const leaked = { workItems: [{ id: 'wi-1', title: 'A task', estimate: 13 }] };

    await expect(run('/v1/organizations/atlas/portal/work-items', leaked)).rejects.toThrow(
      ApiError,
    );
  });

  it('refuses it as a 500, because it is a programming error and not the caller’s fault', async () => {
    const leaked = { internalNotes: 'Do not tell the client this' };

    const error = await run('/v1/organizations/atlas/portal/projects', leaked).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    // The field *name* travels on the audit code — it is a key from a fixed list in
    // `packages/domain`, never a value from the row. The value is what would have leaked.
    expect((error as ApiError).auditCode).toBe('client_projection_blocked:internalNotes');
    expect((error as ApiError).message).not.toContain('Do not tell the client');
  });

  it('finds a forbidden field nested inside a list, which is where one would actually be', async () => {
    const leaked = { workItems: [{ id: 'a' }, { id: 'b', storageKey: 's3://bucket/key' }] };

    const error = await run('/v1/organizations/atlas/portal/work-items', leaked).catch(
      (thrown: unknown) => thrown,
    );
    expect((error as ApiError).auditCode).toContain('storageKey');
    expect((error as ApiError).auditCode).not.toContain('s3://');
  });

  it('names every offending field at once, so one fix does not reveal the next', async () => {
    const leaked = { cost: 1, margin: 2 };

    const error = await run('/v1/organizations/atlas/portal/projects', leaked).catch(
      (thrown: unknown) => thrown,
    );
    expect((error as ApiError).auditCode).toBe('client_projection_blocked:cost,margin');
  });

  it('leaves internal responses alone, because they are allowed those fields', async () => {
    // The same body on an internal path. `25-AUTH` §7's list is about the **client** response
    // path; an internal DTO carrying an estimate is the ordinary case, and an interceptor that
    // refused it would have made the API unable to serve its own team.
    const body = { workItems: [{ id: 'wi-1', estimate: 13 }] };
    await expect(run('/v1/organizations/atlas/work-items', body)).resolves.toBe(body);
  });

  it('matches `portal` as a path segment rather than as a substring', async () => {
    const body = { projects: [{ id: 'p-1', estimate: 8 }] };
    // A project slug containing the word would otherwise pull an internal response into the
    // client rules, and a future client path could be missed by the opposite mistake.
    await expect(run('/v1/organizations/atlas/projects/portal-rebuild', body)).resolves.toBe(body);
  });

  it('cannot be escaped by appending to the query string', async () => {
    const leaked = { estimate: 3 };
    await expect(
      run('/v1/organizations/atlas/portal/work-items?after=not-portal', leaked),
    ).rejects.toThrow(ApiError);
  });

  it('does nothing when there is no url to judge', async () => {
    const body = { anything: true };
    const context = {
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;
    await expect(
      lastValueFrom(interceptor.intercept(context, handlerReturning(body))),
    ).resolves.toBe(body);
  });
});

describe('a download under /portal (FILE-002 slice C)', () => {
  it('lets a StreamableFile through by name, without walking the stream it wraps', async () => {
    // A stream is an object with internals; the sweep must not be what decides. Reversal:
    // drop the by-name check and the walk finds this property and answers a 500.
    const stream = Object.assign(Readable.from([Buffer.from('%PDF-')]), { objectKey: 'tenant/x' });
    const file = new StreamableFile(stream);
    expect(await run('/v1/organizations/atlas/portal/files/x/content', file)).toBe(file);
  });

  it('still refuses an object beside it that names a forbidden field', async () => {
    await expect(
      run('/v1/organizations/atlas/portal/files/x', { objectKey: 'tenant/x' }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
