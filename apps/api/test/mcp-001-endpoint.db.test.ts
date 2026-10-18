import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { uuidv7 } from '@tmanage/domain';
import { mintPersonalAccessToken } from '../src/modules/personal-access-tokens/personal-access-token.js';
import { bootHttpHarness, reseed, signIn, stopHarness } from './support/http-harness.js';
import type { InjectedResponse } from './support/http-harness.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * MCP-001 — the hosted MCP endpoint (`POST /mcp`) over the real API and a real database.
 *
 * Refusals: no token, an unknown token, a revoked token, and a browser session are all 401 before
 * any tool runs. Scope: a valid token's tools act in the token's own organization only — another
 * tenant's work item is not found through MCP exactly as it is not found over REST.
 */

let app: NestFastifyApplication;
let db: TestDatabase;
let world: SeedWorld;
let liveToken: string;
let revokedToken: string;

async function insertToken(revoked: boolean): Promise<string> {
  const minted = mintPersonalAccessToken();
  await db.admin.execute(
    `insert into personal_access_tokens
       (id, organization_id, membership_id, user_id, name, token_hash, token_prefix, created_at,
        revoked_at)
     values (?, ?, ?, ?, 'MCP test', ?, ?, now(3), ${revoked ? 'now(3)' : 'null'})`,
    [
      uuidv7(),
      world.northstar.organizationId,
      world.northstar.owner.membershipId,
      world.northstar.owner.id,
      minted.tokenHash,
      minted.displayPrefix,
    ],
  );
  return minted.token;
}

async function mcp(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    payload: { jsonrpc: '2.0', id: 1, ...body },
  })) as unknown as InjectedResponse;
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

function toolText(response: InjectedResponse): { text: string; isError: boolean } {
  const result = response.json<{
    result: { content: { text: string }[]; isError?: boolean };
  }>().result;
  return { text: result.content[0]?.text ?? '', isError: result.isError === true };
}

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'mcp_001_endpoint_suite' }));
  world = await reseed(db);
  liveToken = await insertToken(false);
  revokedToken = await insertToken(true);
}, 300_000);

afterAll(async () => {
  await stopHarness({ app, db });
});

describe('MCP-001 hosted MCP endpoint', () => {
  it('refuses a request with no token', async () => {
    const response = await mcp({ method: 'tools/list' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses an unknown token', async () => {
    const response = await mcp({ method: 'tools/list' }, bearer(mintPersonalAccessToken().token));
    expect(response.statusCode).toBe(401);
  });

  it('refuses a revoked token', async () => {
    const response = await mcp({ method: 'tools/list' }, bearer(revokedToken));
    expect(response.statusCode).toBe(401);
  });

  it('refuses a browser session without a token', async () => {
    const session = await signIn(app, world.northstar.owner.id);
    const response = await mcp(
      { method: 'tools/list' },
      { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    );
    expect(response.statusCode).toBe(401);
  });

  it('lists the tools for a valid token', async () => {
    const response = await mcp({ method: 'tools/list' }, bearer(liveToken));
    expect(response.statusCode, response.body).toBe(200);
    const names = response
      .json<{ result: { tools: { name: string }[] } }>()
      .result.tools.map((tool) => tool.name);
    expect(names).toContain('get_work_item');
  });

  it("reads a work item in the token's own organization", async () => {
    const response = await mcp(
      {
        method: 'tools/call',
        params: { name: 'get_work_item', arguments: { work_item_id: world.northstar.workItemId } },
      },
      bearer(liveToken),
    );
    expect(response.statusCode, response.body).toBe(200);
    const result = toolText(response);
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain(world.northstar.workItemTitle);
  });

  it("cannot read another tenant's work item", async () => {
    const response = await mcp(
      {
        method: 'tools/call',
        params: { name: 'get_work_item', arguments: { work_item_id: world.brightops.workItemId } },
      },
      bearer(liveToken),
    );
    expect(response.statusCode, response.body).toBe(200);
    const result = toolText(response);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('404');
    expect(result.text).not.toContain(world.brightops.workItemTitle);
  });

  it('only lists the organization the token is bound to', async () => {
    const response = await mcp(
      { method: 'tools/call', params: { name: 'list_organizations', arguments: {} } },
      bearer(liveToken),
    );
    const result = toolText(response);
    expect(result.isError, result.text).toBe(false);
    expect(response.body).toContain('northstar-studio');
    expect(response.body).not.toContain('brightops');
  });
});
