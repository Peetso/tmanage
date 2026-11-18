import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { bootHttpHarness, reseed, signIn, stopHarness } from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * X165 — the Automations app directory over a real database, signed in the way the web app is.
 *
 * The Integrations page showed "Could not load the app directory" (a 500) for the owner. This
 * suite reads the directory with a browser session, records a connection, and reads it again.
 */

let app: NestFastifyApplication;
let db: TestDatabase;
let world: SeedWorld;
let owner: Session;

const DIRECTORY = '/v1/organizations/northstar-studio/automations/apps';

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'x165_app_directory_suite' }));
  world = await reseed(db);
  owner = await signIn(app, world.northstar.owner.id);
}, 300_000);

afterAll(async () => {
  await stopHarness({ app, db });
});

async function list(): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'GET',
    url: DIRECTORY,
    headers: { cookie: owner.cookie },
  })) as unknown as InjectedResponse;
}

describe('X165 app directory over a real database', () => {
  it('lists the catalog for the owner signed in with a session', async () => {
    const response = await list();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ apps: unknown[] }>().apps.length).toBeGreaterThan(0);
  });

  it('lists a recorded connection with its settings as an object', async () => {
    const created = (await app.inject({
      method: 'POST',
      url: `${DIRECTORY}/github/connections`,
      headers: {
        cookie: owner.cookie,
        'x-csrf-token': owner.csrfToken,
        'content-type': 'application/json',
      },
      payload: { label: 'Studio GitHub', config: { channel: 'general' } },
    })) as unknown as InjectedResponse;
    expect(created.statusCode, created.body).toBe(201);

    const response = await list();
    expect(response.statusCode, response.body).toBe(200);
    // FIX5 (8c1eb895) took Slack out of the catalog; GitHub is a catalog app.
    const github = response
      .json<{ apps: { id: string; connections: { config: unknown }[] }[] }>()
      .apps.find((a) => a.id === 'github');
    expect(github?.connections[0]?.config).toEqual({ channel: 'general' });
  });
});
