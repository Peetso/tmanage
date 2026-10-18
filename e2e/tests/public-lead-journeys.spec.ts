import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * The public-site lead-capture journey, through a real browser and the raw public door,
 * against the real stack.
 *
 * x161 — `POST /public/site/contact` is the public site's only unauthenticated *write*: a
 * member of the public with no session, no organization, no CSRF token leaves a name, an
 * email and a message, and the API persists one `marketing_leads` row. The unit and db
 * suites (`contact.controller.test.ts`, `public-001-site.db.test.ts`) prove the boundary in
 * isolation; this journey proves the whole chain stands up as deployed — the Next `/contact`
 * screen, the `@Public()` route, and the lead that lands in the database — and that the raw
 * door keeps the same discipline the screen does.
 *
 * The properties under test are the ones a public write door owns:
 *
 *  - **Form to lead record.** A valid demo request in the browser records exactly one lead,
 *    attributed to `contact_form`, carrying what was typed (trimmed, the demo fields as
 *    labelled lines of the message), and the page acknowledges receipt without echoing it.
 *  - **A malformed email never leaves the form**, and no lead is written on that path.
 *  - **The door needs no session and no CSRF token** — unlike every other write — and still
 *    refuses malformed and over-length input with a 400 that writes nothing.
 *
 * Not serial: every case mints its own email, so the database the specs share never crosses
 * one lead with another, and the cases do not depend on each other's order.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');

interface LeadRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly message: string;
  readonly source: string;
  readonly createdAt: string;
}

interface LeadReadResult {
  readonly email: string;
  readonly count: number;
  readonly rows: readonly LeadRecord[];
}

/**
 * Read the `marketing_leads` rows for one email, through the API package's own CLI
 * (`test/marketing-lead-read-cli.ts`) — the way the seed and the upload-ageing helpers are:
 * this package holds no database client, and the public door exposes no read route to stand
 * in for one. The run's database is named by the env var `global-setup.ts` exported.
 */
async function readLeads(email: string): Promise<LeadReadResult> {
  const databaseUrl = process.env['TMANAGE_E2E_DATABASE_URL'];
  if (!databaseUrl) throw new Error('TMANAGE_E2E_DATABASE_URL is not set — stack did not boot');

  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(
      'pnpm',
      ['--filter', '@tmanage/api', 'exec', 'tsx', 'test/marketing-lead-read-cli.ts', email],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, TMANAGE_SEED_DATABASE_URL: databaseUrl },
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('close', (code) => {
      if (code === 0) resolvePromise(out);
      else reject(new Error(`marketing-lead-read-cli exited ${code}\n${err}\n${out}`));
    });
  });

  const line = stdout.trim().split('\n').pop() as string;
  return JSON.parse(line) as LeadReadResult;
}

/** A fresh, unique email per case, so the shared database never crosses two leads. */
function uniqueEmail(): string {
  return `lead-${randomUUID()}@example.com`;
}

test.describe('the public-site lead-capture journeys', () => {
  test('E2E-public-lead-a: the demo form records exactly one lead, and the URL carries no PII', async ({
    page,
  }) => {
    const email = uniqueEmail();
    const name = 'Ada Lovelace';

    await page.goto('/contact');
    // The form ships disabled until React hydrates (the standing barrier the request
    // journey documents): an enabled field is the app saying it will keep what is typed.
    await expect(page.getByLabel('Full name')).toBeEnabled();

    await page.getByLabel('Full name').fill(name);
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Company').fill('Northwind Studio');
    await page.getByLabel('Team size').selectOption('1–10');
    await page.getByLabel('What would you like to see?').fill('A demo for our studio of six.');
    await page.getByRole('button', { name: 'Book my demo' }).click();

    await expect(
      page.getByText("Thanks — we'll be in touch within one business day."),
    ).toBeVisible();
    // No PII in the URL: the submission is a POST, so the page stays on /contact with no
    // query string carrying the name or email.
    const url = new URL(page.url());
    expect(url.pathname).toBe('/contact');
    expect(url.search).toBe('');

    // The demo fields travel inside the one message the public door takes, as labelled lines.
    const leads = await readLeads(email);
    expect(leads.count).toBe(1);
    expect(leads.rows[0]).toMatchObject({ name, email, source: 'contact_form' });
    expect(leads.rows[0]!.message).toContain('Company: Northwind Studio');
    expect(leads.rows[0]!.message).toContain('Team size: 1–10');
    expect(leads.rows[0]!.message).toContain('A demo for our studio of six.');
  });

  test('E2E-public-lead-b: the form trims each field and stores the trimmed value', async ({
    page,
  }) => {
    const email = uniqueEmail();

    await page.goto('/contact');
    await expect(page.getByLabel('Full name')).toBeEnabled();

    await page.getByLabel('Full name').fill('  Grace Hopper  ');
    await page.getByLabel('Work email').fill(`  ${email}  `);
    await page.getByLabel('Company').fill('  Harbour Partners  ');
    await page.getByLabel('Team size').selectOption('11–50');
    await page.getByLabel('What would you like to see?').fill('  Onboarding, please.  ');
    await page.getByRole('button', { name: 'Book my demo' }).click();

    await expect(
      page.getByText("Thanks — we'll be in touch within one business day."),
    ).toBeVisible();

    const leads = await readLeads(email);
    expect(leads.count).toBe(1);
    expect(leads.rows[0]).toMatchObject({ name: 'Grace Hopper', email, source: 'contact_form' });
    expect(leads.rows[0]!.message).toContain('Company: Harbour Partners\nTeam size: 11–50');
    expect(leads.rows[0]!.message).toMatch(/Onboarding, please\.$/);
  });

  test('E2E-public-lead-c: the form refuses a malformed email before sending and writes nothing', async ({
    page,
  }) => {
    // The demo form checks the email shape itself; the server stays the authority on the raw
    // door (cases d and e). The address has no `@`, so nothing is sent.
    const malformed = `not-an-email-${randomUUID()}`;

    await page.goto('/contact');
    await expect(page.getByLabel('Full name')).toBeEnabled();

    await page.getByLabel('Full name').fill('Katherine Johnson');
    await page.getByLabel('Work email').fill(malformed);
    await page.getByLabel('Company').fill('Langley Analytics');
    await page.getByLabel('Team size').selectOption('51–200');
    await page.getByRole('button', { name: 'Book my demo' }).click();

    await expect(page.getByText('Could not send your request')).toBeVisible();
    await expect(page.getByText('Enter a work email like name@company.com.')).toBeVisible();
    await expect(page.getByText("Thanks — we'll be in touch within one business day.")).toHaveCount(
      0,
    );

    const leads = await readLeads(malformed);
    expect(leads.count).toBe(0);
  });

  test('E2E-public-lead-d: the raw public door records a lead with no session and no CSRF token', async ({
    request,
  }) => {
    const email = uniqueEmail();
    const name = 'Dorothy Vaughan';
    const message = 'A direct submission, carrying no cookie and no CSRF header.';

    // Playwright's APIRequestContext here carries no session cookie and sends no CSRF
    // token; every other write in the application would be a 401/403. The public door is
    // the one that must accept it.
    const response = await request.post(`${API_URL}/public/site/contact`, {
      data: { name, email, message },
    });
    expect(response.status()).toBe(201);
    expect(await response.json()).toEqual({ status: 'received' });

    const leads = await readLeads(email);
    expect(leads.count).toBe(1);
    expect(leads.rows[0]).toMatchObject({ name, email, message, source: 'contact_form' });
  });

  test('E2E-public-lead-e: the raw public door rejects a malformed email with a 400 and writes nothing', async ({
    request,
  }) => {
    const email = `nope-${randomUUID()}`;

    const response = await request.post(`${API_URL}/public/site/contact`, {
      data: { name: 'Mary Jackson', email, message: 'This should never be stored.' },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('validation_failed');

    const leads = await readLeads(email);
    expect(leads.count).toBe(0);
  });

  test('E2E-public-lead-f: the raw public door rejects an over-length message with a 400 and writes nothing', async ({
    request,
  }) => {
    const email = uniqueEmail();

    // 4001 characters, one past the column bound the controller enforces (MAX_MESSAGE).
    const response = await request.post(`${API_URL}/public/site/contact`, {
      data: { name: 'Annie Easley', email, message: 'a'.repeat(4001) },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('validation_failed');

    const leads = await readLeads(email);
    expect(leads.count).toBe(0);
  });
});
