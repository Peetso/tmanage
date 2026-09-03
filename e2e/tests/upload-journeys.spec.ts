import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

/**
 * The upload, end to end, through the real API and the real filesystem driver (FILE-001b).
 *
 * - **E2E-12a** — a studio member opens an upload session for a file one part and sixteen
 *   bytes long at the *real* part size (8 MiB), PUTs both parts to the URLs the session
 *   answered **with no cookie at all**, completes with the etags the PUTs returned, and the
 *   asset is `uploaded` at the declared size — and exactly one object of that size sits under
 *   the run's storage root. This is the one place the 8 MiB part crosses HTTP: the database
 *   suite drives the same route at sixteen bytes a part, which proves the protocol and not
 *   the body limit. Leaving Fastify's 1 MiB default in place would pass every other test.
 *
 * Not E2E-12 itself: no interrupt, no resume, no scan, no download. Those are FILE-002's and
 * FILE-003's, and the catalog row stays unclaimed until they exist.
 *
 * No browser page is opened: the upload screen is not built yet (a later UI ticket), and
 * the journey is about the transport. Playwright's request contexts are the two clients a
 * real upload has — the signed-in one that opens and completes, and the anonymous one that
 * carries the bytes.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly manager: SeededUser;
  };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

/** The dev sign-in route the API registers outside production — a session, not a mock. */
async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, {
    data: { userId },
  });
  expect(response.ok()).toBe(true);
}

async function csrfToken(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies(API_URL)).find((c) => c.name === 'tmanage_session_csrf');
  expect(cookie?.value).toBeTruthy();
  return cookie?.value as string;
}

function filesUnder(directory: string): { path: string; size: number }[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path: path.replace(/\\/g, '/'), size: statSync(path).size };
    });
}

const PART_SIZE = 8 * 1024 * 1024;
const DECLARED = PART_SIZE + 16;

interface UploadSession {
  readonly id: string;
  readonly status: string;
  readonly partCount: number;
  readonly uploadUrls: readonly { readonly partNumber: number; readonly url: string }[];
}

test.describe('the upload journey', () => {
  test('E2E-12a: two real parts, no cookie, one object of the declared size on disk', async ({
    browser,
    playwright,
  }) => {
    const root = process.env['TMANAGE_E2E_STORAGE_ROOT'] as string;
    expect(root).toBeTruthy();
    const objectsBefore = filesUnder(join(root, 'objects'));

    // The signed-in client opens the session — the browser's shape: cookie, CSRF, origin.
    const studio = await browser.newContext();
    await signIn(studio, world().northstar.manager.id);
    const headers = { 'x-csrf-token': await csrfToken(studio), origin: WEB_URL };
    const created = await studio.request.post(
      `${API_URL}/v1/organizations/northstar-studio/upload-sessions`,
      {
        headers: { ...headers, 'idempotency-key': `e2e-12a-${Date.now()}` },
        data: {
          projectId: world().northstar.projectId,
          fileName: 'autumn-hero.psd',
          mimeType: 'image/vnd.adobe.photoshop',
          sizeBytes: DECLARED,
          purpose: 'deliverable',
        },
      },
    );
    expect(created.status()).toBe(201);
    const session = (await created.json()) as UploadSession;
    expect(session.status).toBe('reserved');
    expect(session.partCount).toBe(2);
    expect(session.uploadUrls.map((u) => u.partNumber)).toEqual([1, 2]);
    for (const target of session.uploadUrls) {
      expect(target.url.startsWith(`${API_URL}/v1/uploads/`)).toBe(true);
      expect(target.url).not.toContain(world().northstar.organizationId);
    }

    // The anonymous client carries the bytes: a fresh request context holds no cookie.
    const anonymous = await playwright.request.newContext();
    const parts: { partNumber: number; etag: string }[] = [];
    for (const target of session.uploadUrls) {
      const size = target.partNumber === 1 ? PART_SIZE : DECLARED - PART_SIZE;
      const put = await anonymous.put(target.url, {
        headers: { 'content-type': 'application/octet-stream' },
        data: Buffer.alloc(size, target.partNumber === 1 ? 'a' : 'b'),
        timeout: 60_000,
      });
      expect(put.status(), `part ${target.partNumber}: ${await put.text()}`).toBe(200);
      const etag = put.headers()['etag'];
      expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
      parts.push({ partNumber: target.partNumber, etag: etag as string });
    }
    await anonymous.dispose();

    // The signed-in client completes on the etags the PUTs answered.
    const completed = await studio.request.post(
      `${API_URL}/v1/organizations/northstar-studio/upload-sessions/${session.id}/complete`,
      { headers, data: { parts } },
    );
    expect(completed.status(), await completed.text()).toBe(202);
    const asset = (await completed.json()) as { status: string; sizeBytes: number };
    expect(asset.status).toBe('uploaded');
    expect(asset.sizeBytes).toBe(DECLARED);

    // On disk, once: one new object, of the declared size, under the tenant's own prefix,
    // and the staging directory gone.
    const objectsAfter = filesUnder(join(root, 'objects'));
    const fresh = objectsAfter.filter((f) => !objectsBefore.some((b) => b.path === f.path));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.path.endsWith('/object')).toBe(true);
    expect(fresh[0]?.path).toContain(
      `/objects/quarantine/tenant/${world().northstar.organizationId}/project/${world().northstar.projectId}/`,
    );
    expect(fresh[0]?.size).toBe(DECLARED);
    expect(filesUnder(join(root, 'uploads'))).toHaveLength(0);

    await studio.close();
  });
});
