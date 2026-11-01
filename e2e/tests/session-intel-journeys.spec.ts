import { expect, test } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * R12 / R1 — an owner opens a session's detail drawer: the Location and Signal cards and the
 * honest-limits note are there, and the trail CSV starts with its header row. Same world and dev
 * sign-in as `session-journeys.spec.ts`.
 */

const ORG = 'northstar-studio';

function ownerId(): string {
  const world = JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as {
    northstar: { owner: { id: string } };
  };
  return world.northstar.owner.id;
}

test('an owner sees where a session came from and can export its trail', async ({
  page,
  context,
}) => {
  const signIn = await context.request.post(`${API_URL}/v1/dev/sessions`, {
    data: { userId: ownerId() },
  });
  expect(signIn.ok()).toBe(true);

  await page.goto(`/${ORG}/admin/sessions`);
  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader', { name: 'Signal' })).toBeVisible();
  await table.getByRole('row').nth(1).getByRole('button').first().click();

  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: 'Location' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Signal' })).toBeVisible();
  await expect(drawer.getByText(/A MAC address never travels over the internet/)).toBeVisible();

  const list = await context.request.get(`${API_URL}/v1/organizations/${ORG}/admin/sessions`);
  const { sessions } = (await list.json()) as { sessions: { sessionId: string }[] };
  const csv = await context.request.get(
    `${API_URL}/v1/organizations/${ORG}/admin/sessions/${sessions[0]?.sessionId}/trail.csv`,
  );
  expect(csv.headers()['content-type']).toContain('text/csv');
  expect((await csv.text()).replace(String.fromCharCode(0xfeff), '')).toMatch(
    /^occurredAtUtc,action,outcome,ip,/,
  );
});
