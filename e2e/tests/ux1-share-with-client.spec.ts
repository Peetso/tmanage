import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

/**
 * UX-1 (live UX test 69836a13, C-P0-1 / O-P0-2) — "Share with client" really puts a deliverable in
 * the portal, and a portal user sees it only after that explicit share, never before. Real API,
 * real MariaDB: the team member and the client contact sign in separately.
 */
interface World {
  readonly northstar: {
    readonly projectId: string;
    readonly owner: { readonly id: string };
  };
  readonly atlas: { readonly admin: { readonly id: string } };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

const ORG = 'northstar-studio';
const BASE = `${API_URL}/v1/organizations/${ORG}`;

async function signedIn(
  browser: Browser,
  userId: string,
): Promise<{
  request: APIRequestContext;
  headers: Record<string, string>;
  close: () => Promise<void>;
}> {
  const context = await browser.newContext();
  const session = await context.request.post(`${API_URL}/v1/dev/sessions`, { data: { userId } });
  expect(session.ok(), await session.text()).toBe(true);
  const csrf = (await context.cookies(API_URL)).find(
    (cookie) => cookie.name === 'tmanage_session_csrf',
  )?.value;
  expect(csrf).toBeTruthy();
  return {
    request: context.request,
    headers: { 'x-csrf-token': csrf as string, origin: WEB_URL },
    close: () => context.close(),
  };
}

async function portalTitles(client: APIRequestContext, projectId: string): Promise<string[]> {
  const response = await client.get(`${BASE}/portal/projects/${projectId}/deliverables`);
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { deliverables: readonly { title: string }[] };
  return body.deliverables.map((deliverable) => deliverable.title);
}

test('a deliverable reaches the portal only after "Share with client"', async ({ browser }) => {
  const { projectId, owner } = world().northstar;
  const team = await signedIn(browser, owner.id);
  const client = await signedIn(browser, world().atlas.admin.id);
  try {
    const title = `UX-1 share ${Date.now()}`;
    const created = await team.request.post(`${BASE}/deliverables`, {
      headers: team.headers,
      data: { projectId, title, description: null },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const deliverableId = ((await created.json()) as { id: string }).id;
    const version = await team.request.post(`${BASE}/deliverables/${deliverableId}/versions`, {
      headers: team.headers,
      data: { fileAssetId: null, note: 'First look at the homepage' },
    });
    expect(version.ok(), await version.text()).toBe(true);
    const versionId = ((await version.json()) as { id: string }).id;

    // Before the share: the client cannot see it, and the team page says only the team sees it.
    expect((await portalTitles(client.request, projectId)).some((t) => t.startsWith(title))).toBe(
      false,
    );
    const before = await team.request.get(`${BASE}/deliverables/${deliverableId}`);
    expect(((await before.json()) as { sharedWithClient: boolean }).sharedWithClient).toBe(false);

    // A client cannot share it themselves.
    const byClient = await client.request.post(
      `${BASE}/deliverables/${deliverableId}/versions/${versionId}/share`,
      { headers: client.headers },
    );
    expect(byClient.status()).toBeGreaterThanOrEqual(403);
    expect((await portalTitles(client.request, projectId)).some((t) => t.startsWith(title))).toBe(
      false,
    );

    const shared = await team.request.post(
      `${BASE}/deliverables/${deliverableId}/versions/${versionId}/share`,
      { headers: team.headers },
    );
    expect(shared.ok(), await shared.text()).toBe(true);

    // After: the portal lists it, and the team page reads the same fact.
    expect((await portalTitles(client.request, projectId)).some((t) => t.startsWith(title))).toBe(
      true,
    );
    const after = await team.request.get(`${BASE}/deliverables/${deliverableId}`);
    const detail = (await after.json()) as {
      sharedWithClient: boolean;
      versions: readonly { id: string; sharedWithClientAt: string | null }[];
    };
    expect(detail.sharedWithClient).toBe(true);
    expect(detail.versions.find((v) => v.id === versionId)?.sharedWithClientAt).toBeTruthy();
  } finally {
    await team.close();
    await client.close();
  }
});

test('a deleted deliverable leaves the portal, and Undo brings it back (FIX6 item 8)', async ({
  browser,
}) => {
  const { projectId, owner } = world().northstar;
  const team = await signedIn(browser, owner.id);
  const client = await signedIn(browser, world().atlas.admin.id);
  try {
    const title = `FIX6 delete ${Date.now()}`;
    const created = await team.request.post(`${BASE}/deliverables`, {
      headers: team.headers,
      data: { projectId, title, description: null },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const deliverableId = ((await created.json()) as { id: string }).id;
    const version = await team.request.post(`${BASE}/deliverables/${deliverableId}/versions`, {
      headers: team.headers,
      data: { fileAssetId: null, note: 'Made by mistake' },
    });
    expect(version.ok(), await version.text()).toBe(true);
    const versionId = ((await version.json()) as { id: string }).id;
    const shared = await team.request.post(
      `${BASE}/deliverables/${deliverableId}/versions/${versionId}/share`,
      { headers: team.headers },
    );
    expect(shared.ok(), await shared.text()).toBe(true);
    const inPortal = async () =>
      (await portalTitles(client.request, projectId)).some((t) => t.startsWith(title));
    expect(await inPortal()).toBe(true);

    // A client contact cannot delete it.
    const byClient = await client.request.post(`${BASE}/deliverables/${deliverableId}/delete`, {
      headers: client.headers,
    });
    expect(byClient.status()).toBeGreaterThanOrEqual(403);
    expect(await inPortal()).toBe(true);

    const deleted = await team.request.post(`${BASE}/deliverables/${deliverableId}/delete`, {
      headers: team.headers,
    });
    expect(deleted.status(), await deleted.text()).toBe(204);
    expect(await inPortal()).toBe(false);
    const gone = await team.request.get(`${BASE}/deliverables/${deliverableId}`);
    expect(gone.status()).toBe(404);

    const restored = await team.request.post(`${BASE}/deliverables/${deliverableId}/restore`, {
      headers: team.headers,
    });
    expect(restored.status(), await restored.text()).toBe(204);
    expect(await inPortal()).toBe(true);
  } finally {
    await team.close();
    await client.close();
  }
});
