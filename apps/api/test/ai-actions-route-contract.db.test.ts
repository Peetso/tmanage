import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { OPS, isPlatformOp } from '../src/modules/ai-actions/registry/index.js';
import type { AiActionOp } from '../src/modules/ai-actions/registry/index.js';
import { allDetailsById } from '../src/modules/mcp/tool-catalog.js';
import { buildOpRequest } from '../src/modules/mcp/pending-actions.js';
import { ROUTE_CONTRACT_EXCEPTIONS } from '../src/modules/ai-actions/registry/route-contract-exceptions.js';
import { bootHttpHarness, reseed, signIn, stopHarness } from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * Fix lane B, 2026-11-23 — DC-9 "an action's input schema does not match its route", the route
 * half. `src/modules/ai-actions/registry/route-contract.test.ts` (unit) calls every handler with
 * stub services; validation that lives in a service, and the real authorization, are only seen
 * here: every example of every **read** op (and of the writes the live test named) is sent through
 * the real app, a real database and a real signed-in owner, exactly as the AI runtime would build
 * the request (`buildOpRequest`).
 *
 * The examples name placeholder ids. The ids the seed world has (`projectId`, `workspaceId`,
 * `workItemId`) are swapped for real ones; any other id stays a placeholder, so a 404 is a pass
 * and so is a 400 that names only placeholder-id fields. What fails is a 400/422 that names a
 * field the example really chose (a missing required field, a wrong name, an enum value the
 * route refuses) or names nothing at all.
 */

const ORG = 'northstar-studio';

/** The writes the 2026-11-23 live test failed on, run here as well as every read. */
const WRITES_TO_RUN: ReadonlySet<string> = new Set([
  'conversations.create',
  'automations.templates.create',
  'meetings.create',
  'documents.create',
  'work_items.create',
  'decisions.create',
  'work_forms.create',
  'imports.validations.create',
]);

let app: NestFastifyApplication;
let db: TestDatabase;
let world: SeedWorld;
let owner: Session;
let client: Session;

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'ai_route_contract_suite' }));
  world = await reseed(db);
  owner = await signIn(app, world.northstar.owner.id);
  client = await signIn(app, world.atlas.admin.id);
}, 300_000);

afterAll(async () => {
  await stopHarness({ app, db });
});

function realIds(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const swap: Record<string, string> = {
    projectId: world.northstar.projectId,
    workspaceId: world.northstar.workspaceId,
    workItemId: world.northstar.workItemId,
  };
  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(swap)) if (key in out) out[key] = value;
  return out;
}

/** A key whose example value is a placeholder id the seed world cannot supply. */
function isPlaceholderId(field: string): boolean {
  const root = field.split(/[.[]/)[0] ?? field;
  return /(^id$|Id$|Ids$)/.test(root) && !['projectId', 'workspaceId', 'workItemId'].includes(root);
}

async function send(op: AiActionOp, args: Record<string, unknown>): Promise<InjectedResponse> {
  const request = buildOpRequest(op, args, ORG);
  const session = op.id.startsWith('portal.') ? client : owner;
  return (await app.inject({
    method: request.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: request.url,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(request.body === undefined ? {} : { payload: request.body }),
  })) as unknown as InjectedResponse;
}

describe('DC-9 route half: every example the AI is shown is accepted by the live route', () => {
  it('reads and the named writes: no 400/422 on a field the example chose', async () => {
    const failures: string[] = [];
    for (const op of OPS) {
      const detail = allDetailsById.get(op.id);
      if (detail === undefined || isPlatformOp(op)) continue;
      if (op.risk !== 'read' && !WRITES_TO_RUN.has(op.id)) continue;
      for (const example of detail.examples) {
        if (ROUTE_CONTRACT_EXCEPTIONS[`${op.id} example-route`] !== undefined) continue;
        const args = realIds(example.args);
        if (!detail.input.safeParse(args).success) continue; // the unit half reports it
        const response = await send(op, args);
        if (response.statusCode !== 400 && response.statusCode !== 422) continue;
        const fields = (
          response.json<{ error?: { details?: { field: string }[] } }>().error?.details ?? []
        ).map((d) => d.field);
        const chosen = fields.filter((field) => !isPlaceholderId(field));
        if (fields.length === 0 || chosen.length > 0) {
          failures.push(
            `${op.id} "${example.summary}" → ${response.statusCode} ${response.body.slice(0, 300)}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
