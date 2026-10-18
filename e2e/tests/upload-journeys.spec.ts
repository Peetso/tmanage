import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import {
  API_URL,
  WEB_URL,
  ageUploadSession,
  drainOutbox,
  reconcileUsage,
  sweepUploads,
  verifyUploads,
} from '../setup/stack.js';

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
 * - **E2E-12b** (USAGE-001) — a BrightOps owner reserves the tenant's whole quota in one
 *   session and never sends a byte; the next reservation is refused
 *   (`storage_quota_exhausted`). The session is aged past its lifetime, the sweep runs as a
 *   deployment's tick would (`sweep:once`), and the same reservation is now accepted; the
 *   abandoned session reads `expired`, and the relay consumes the release without a failure.
 *   BrightOps rather than Northstar so the quota arithmetic owes nothing to E2E-12a's
 *   committed bytes.
 *
 * E2E-12a continues through verification, scan, private promotion and byte-exact download.
 * E2E-12c proves malware rejection, denied download and retained quarantine bytes.
 * Not full E2E-12: interrupt/resume and the file UI remain unclaimed.
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
  readonly brightops: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly owner: SeededUser;
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

/** A PDF by its signature (`%PDF-` at byte zero), the rest filler: what the verifier admits. */
function pdfPart(partNumber: number, size: number): Buffer {
  if (partNumber !== 1) return Buffer.alloc(size, 'b');
  const head = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1');
  return Buffer.concat([head, Buffer.alloc(size - head.length, 'a')]);
}
/** `27` SEC-06's test file inside otherwise admissible text: the stub scanner finds it. */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
function malwarePart(partNumber: number, size: number): Buffer {
  if (partNumber !== 1) return Buffer.alloc(size, ' ');
  const head = Buffer.from(`notes: ${EICAR}\n`, 'latin1');
  return Buffer.concat([head, Buffer.alloc(size - head.length, ' ')]);
}

interface UploadSession {
  readonly id: string;
  readonly status: string;
  readonly partCount: number;
  readonly uploadUrls: readonly { readonly partNumber: number; readonly url: string }[];
  readonly fileAssetId: string;
}

test.describe('the upload journey', () => {
  test('E2E-12a: two real parts, no cookie, one object on disk; verified, scanned, promoted and downloaded', async ({
    browser,
    playwright,
  }) => {
    const root = process.env['TMANAGE_E2E_STORAGE_ROOT'] as string;
    const databaseUrl = process.env['TMANAGE_E2E_DATABASE_URL'] as string;
    expect(root).toBeTruthy();
    expect(databaseUrl).toBeTruthy();
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
          // A PDF, not the `.psd` this journey once declared: the verifier admits the seven
          // families of decision F5, and Photoshop is not one of them.
          fileName: 'autumn-hero.pdf',
          mimeType: 'application/pdf',
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
      // The path and every other parameter stay tenant-free. The part token (`t`) is the one
      // place the tenant appears, by design since `pu2` (packages/storage/src/part-token.ts):
      // signed, so it cannot be swapped, and bound to this upload's own tenant by the store.
      const partUrl = new URL(target.url);
      const token = partUrl.searchParams.get('t') ?? '';
      partUrl.searchParams.delete('t');
      expect(partUrl.toString()).not.toContain(world().northstar.organizationId);
      expect(token.split('.').slice(0, 2)).toEqual(['pu2', world().northstar.organizationId]);
    }

    // The anonymous client carries the bytes: a fresh request context holds no cookie.
    const anonymous = await playwright.request.newContext();
    const parts: { partNumber: number; etag: string }[] = [];
    for (const target of session.uploadUrls) {
      const size = target.partNumber === 1 ? PART_SIZE : DECLARED - PART_SIZE;
      const put = await anonymous.put(target.url, {
        headers: { 'content-type': 'application/octet-stream' },
        data: pdfPart(target.partNumber, size),
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
    const quarantinePath = fresh[0]?.path as string;

    // Not yet downloadable: the file is `uploaded`, and the gate answers one 404.
    const fileAssetId = session.fileAssetId;
    const early = await studio.request.get(
      `${API_URL}/v1/organizations/northstar-studio/files/${fileAssetId}/content`,
    );
    expect(early.status()).toBe(404);

    // The deployment's tick: verify (hash, signature) then scan (stub) and promote.
    const passes = await verifyUploads(databaseUrl, root);
    expect(passes.verifier).toMatch(/verified [1-9]/);
    expect(passes.scanner).toMatch(/ready [1-9]/);
    const privatePath = quarantinePath.replace('/objects/quarantine/', '/objects/private/');
    expect(existsSync(privatePath)).toBe(true);
    expect(statSync(privatePath).size).toBe(DECLARED);
    // The quarantine copy stays until FILE-003 deletes it (ADR-0006).
    expect(existsSync(quarantinePath)).toBe(true);

    // The download: the bytes the anonymous client sent, the detected type, an attachment.
    const download = await studio.request.get(
      `${API_URL}/v1/organizations/northstar-studio/files/${fileAssetId}/content`,
      { timeout: 60_000 },
    );
    const body = await download.body();
    expect(download.status(), body.length < 4_096 ? body.toString() : '').toBe(200);
    expect(body.length).toBe(DECLARED);
    expect(download.headers()['content-length']).toBe(String(DECLARED));
    expect(
      Buffer.compare(
        body,
        Buffer.concat([pdfPart(1, PART_SIZE), pdfPart(2, DECLARED - PART_SIZE)]),
      ),
    ).toBe(0);
    expect(download.headers()['content-type']).toBe('application/pdf');
    expect(download.headers()['content-disposition']).toContain(
      'attachment; filename="autumn-hero.pdf"',
    );
    expect(download.headers()['x-content-type-options']).toBe('nosniff');
    expect(download.headers()['cache-control']).toBe('private, no-store');
    expect(JSON.stringify(download.headers())).not.toContain(world().northstar.organizationId);

    // Drain the outbox without consumer failure (event emission is covered by DB tests).
    await drainOutbox(databaseUrl, root);

    await studio.close();
  });

  test('E2E-12c: a file the scanner rejects is never downloadable, and its bytes stay in quarantine', async ({
    browser,
    playwright,
  }) => {
    const root = process.env['TMANAGE_E2E_STORAGE_ROOT'] as string;
    const databaseUrl = process.env['TMANAGE_E2E_DATABASE_URL'] as string;
    const objectsBefore = filesUnder(join(root, 'objects'));

    const studio = await browser.newContext();
    await signIn(studio, world().northstar.manager.id);
    const headers = { 'x-csrf-token': await csrfToken(studio), origin: WEB_URL };
    const created = await studio.request.post(
      `${API_URL}/v1/organizations/northstar-studio/upload-sessions`,
      {
        headers: { ...headers, 'idempotency-key': `e2e-12c-${Date.now()}` },
        data: {
          projectId: world().northstar.projectId,
          fileName: 'notes.txt',
          mimeType: 'text/plain',
          sizeBytes: DECLARED,
          purpose: 'deliverable',
        },
      },
    );
    expect(created.status(), await created.text()).toBe(201);
    const session = (await created.json()) as UploadSession;

    const anonymous = await playwright.request.newContext();
    const parts: { partNumber: number; etag: string }[] = [];
    for (const target of session.uploadUrls) {
      const size = target.partNumber === 1 ? PART_SIZE : DECLARED - PART_SIZE;
      const put = await anonymous.put(target.url, {
        headers: { 'content-type': 'application/octet-stream' },
        data: malwarePart(target.partNumber, size),
        timeout: 60_000,
      });
      expect(put.status(), `part ${target.partNumber}: ${await put.text()}`).toBe(200);
      parts.push({ partNumber: target.partNumber, etag: put.headers()['etag'] as string });
    }
    await anonymous.dispose();
    const completed = await studio.request.post(
      `${API_URL}/v1/organizations/northstar-studio/upload-sessions/${session.id}/complete`,
      { headers, data: { parts } },
    );
    expect(completed.status(), await completed.text()).toBe(202);

    const passes = await verifyUploads(databaseUrl, root);
    expect(passes.verifier).toMatch(/verified [1-9]/);
    expect(passes.scanner).toMatch(/rejected [1-9]/);

    // The studio's replayed view says why — the code, never the engine's detection name.
    const replay = await studio.request.post(
      `${API_URL}/v1/organizations/northstar-studio/upload-sessions/${session.id}/complete`,
      { headers, data: { parts } },
    );
    expect(replay.status()).toBe(202);
    const view = (await replay.json()) as { status: string; rejectionCode: string | null };
    expect(view).toMatchObject({ status: 'rejected', rejectionCode: 'malware_detected' });
    expect(await replay.text()).not.toMatch(/eicar/i);

    // Never downloadable; nothing promoted; the quarantine object stays.
    const download = await studio.request.get(
      `${API_URL}/v1/organizations/northstar-studio/files/${session.fileAssetId}/content`,
    );
    expect(download.status()).toBe(404);
    const objectsAfter = filesUnder(join(root, 'objects'));
    const fresh = objectsAfter.filter((f) => !objectsBefore.some((b) => b.path === f.path));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.path).toContain('/objects/quarantine/');

    // Drain the outbox without consumer failure (event emission is covered by DB tests).
    await drainOutbox(databaseUrl, root);

    await studio.close();
  });

  test('E2E-12b: an abandoned upload is released by the sweep, and the quota is free again', async ({
    browser,
  }) => {
    const databaseUrl = process.env['TMANAGE_E2E_DATABASE_URL'] as string;
    const root = process.env['TMANAGE_E2E_STORAGE_ROOT'] as string;
    expect(databaseUrl).toBeTruthy();
    // `stack.ts` sets the organization quota to two of E2E-12a's uploads.
    const QUOTA = 2 * DECLARED;

    const studio = await browser.newContext();
    await signIn(studio, world().brightops.owner.id);
    const headers = { 'x-csrf-token': await csrfToken(studio), origin: WEB_URL };
    const open = (sizeBytes: number, key: string) =>
      studio.request.post(`${API_URL}/v1/organizations/brightops-consulting/upload-sessions`, {
        headers: { ...headers, 'idempotency-key': `e2e-12b-${key}-${Date.now()}` },
        data: {
          projectId: world().brightops.projectId,
          fileName: 'finance-review.pdf',
          mimeType: 'application/pdf',
          sizeBytes,
          purpose: 'deliverable',
        },
      });

    // The whole quota, reserved by one session nobody will finish.
    const abandoned = await open(QUOTA, 'abandoned');
    expect(abandoned.status(), await abandoned.text()).toBe(201);
    const session = (await abandoned.json()) as UploadSession;
    expect(session.status).toBe('reserved');

    // The next byte is refused — the reservation is counted whether or not bytes follow.
    const refused = await open(16, 'refused');
    expect(refused.status()).toBe(422);
    const refusal = (await refused.json()) as { error: { code: string } };
    expect(refusal.error.code).toBe('validation_failed');
    expect(await refused.text()).toContain('exceeds the storage available');

    // Time passes. The sweep runs as the deployment's tick would.
    await ageUploadSession(databaseUrl, session.id);
    const report = await sweepUploads(databaseUrl, root);
    expect(report).toMatch(/released [1-9]/);

    // The same reservation is now accepted, and the abandoned session reads expired.
    const accepted = await open(16, 'accepted');
    expect(accepted.status(), await accepted.text()).toBe(201);
    const read = await studio.request.get(
      `${API_URL}/v1/organizations/brightops-consulting/upload-sessions/${session.id}`,
    );
    expect(read.status()).toBe(200);
    expect(((await read.json()) as UploadSession).status).toBe('expired');

    // The release is an event; the relay consumes it without a failure.
    await drainOutbox(databaseUrl, root);

    // USAGE-001 slice 3 (x56): the reconcile pass runs as the deployment's tick would, after
    // sweep and relay. The sweep wrote the release through the counter and the ledger together,
    // so this tenant's counter agrees with its ledger: the pass stamps `reconciled_at` and
    // corrects nothing. Running it here proves `reconcile:once` is wired into the same tick the
    // sweeper is, and that a healthy tenant drifts by zero.
    const reconciled = await reconcileUsage(databaseUrl, root);
    expect(reconciled).toMatch(/drifted 0/);

    // Leave the tenant as found.
    const fresh = (await accepted.json()) as UploadSession;
    const cancelled = await studio.request.post(
      `${API_URL}/v1/organizations/brightops-consulting/upload-sessions/${fresh.id}/cancel`,
      { headers },
    );
    expect(cancelled.status(), await cancelled.text()).toBe(200);

    await studio.close();
  });
});
