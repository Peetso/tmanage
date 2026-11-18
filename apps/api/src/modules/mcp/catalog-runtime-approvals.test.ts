import { describe, expect, it, vi } from 'vitest';
import type { CatalogTool } from '@tmanage/mcp-server';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { PAT_SCOPES, liveMcpSurface } from './catalog-runtime.js';
import type { McpApprovals } from './catalog-runtime.js';
import { PendingActionRefusedError } from './pending-actions.js';

/**
 * S10 / architecture F3 on the live `/mcp` runtime. A confirm-class call is frozen as a pending AI
 * action and answered with its approve link — what `tmanage_run_action` promises — and nothing
 * runs; `tmanage_check_approval` reads the outcome back for the same member only.
 */

const REQUESTER = {
  organizationId: 'org-1',
  membershipId: 'mem-1',
  userId: 'user-1',
  clientId: 'oauth-client-1',
  clientName: 'Claude',
};
const EXPIRES_AT = new Date('2026-11-18T12:10:00.000Z');

const meta = (name: string): CatalogTool =>
  ({ name, title: '', description: '', inputSchema: {} }) as never;

function surface(approvals?: Partial<McpApprovals['service']>) {
  const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
  const service = {
    request: vi.fn(async () => ({
      id: 'appr-1',
      title: 'Delete a document',
      expiresAt: EXPIRES_AT,
    })),
    check: vi.fn(async () => ({ status: 'pending' as const, resultStatus: null, result: null })),
    ...approvals,
  };
  const { runtime } = liveMcpSurface({
    profile: 'full',
    scopes: PAT_SCOPES,
    capabilities: new Set(['doc.delete', 'work.read', 'work.update']),
    orgSlug: 'acme',
    baseUrl: 'http://in-process',
    fetch: fetch as unknown as typeof globalThis.fetch,
    approvals: {
      service,
      requester: REQUESTER,
      webOrigin: 'https://app.example',
      correlationId: 'corr-1',
    },
  });
  return { runtime, fetch, service };
}

describe('MCP runtime — confirm-class calls wait for approval (S10)', () => {
  it('freezes tmanage_run_action of a confirm op and answers with the approve link', async () => {
    const { runtime, fetch, service } = surface();
    const result = await runtime.runTool(meta('tmanage_run_action'), {
      action_id: 'documents.delete',
      args: { documentId: 'doc_9' },
    });

    expect(result.isError).toBeUndefined();
    expect(result.data).toEqual({
      status: 'pending',
      approval_id: 'appr-1',
      approval_url: 'https://app.example/acme/ai/approve/appr-1',
      expires_at: '2026-11-18T12:10:00.000Z',
    });
    expect(result.summary).toContain('needs your approval');
    expect(service.request).toHaveBeenCalledWith(
      REQUESTER,
      'documents.delete',
      { documentId: 'doc_9' },
      'corr-1',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses, and runs nothing, a call the approval store will not freeze', async () => {
    const { runtime, fetch } = surface({
      request: vi.fn(async () => {
        throw new PendingActionRefusedError('not_confirm_class', 'does not need approval');
      }),
    });
    const result = await runtime.runTool(meta('tmanage_run_action'), {
      action_id: 'documents.delete',
      args: { documentId: 'doc_9' },
    });
    expect(result.isError).toBe(true);
    expect(String(result.data)).toContain('needs your approval');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads the outcome with tmanage_check_approval, as the same requester', async () => {
    const { runtime, service } = surface({
      check: vi.fn(async () => ({ status: 'approved' as const, resultStatus: 204, result: null })),
    });
    const result = await runtime.runTool(meta('tmanage_check_approval'), { approval_id: 'appr-1' });
    expect(result.data).toEqual({
      approval_id: 'appr-1',
      status: 'approved',
      result_status: 204,
      result: null,
    });
    expect(service.check).toHaveBeenCalledWith(REQUESTER, 'appr-1', 'corr-1');
  });

  it('answers an approval that is not the member’s own as unknown', async () => {
    const { runtime } = surface({
      check: vi.fn(async () => {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }),
    });
    const result = await runtime.runTool(meta('tmanage_check_approval'), { approval_id: 'other' });
    expect(result).toEqual({ isError: true, data: 'Unknown approval: other' });
  });
});
