import { createPool } from 'mysql2/promise';
import { seedTwoTenants } from './seed-two-tenants.js';

/**
 * Seed the two-tenant world into an existing, migrated database and print it as JSON —
 * the e2e harness's way of reusing the exact fixtures every database suite runs on,
 * without importing this package's TypeScript across a workspace boundary.
 *
 * Usage: `tsx test/seed-cli.ts` with `TMANAGE_SEED_DATABASE_URL` set. Test tooling only;
 * nothing in any runtime path invokes it.
 */
const url = process.env['TMANAGE_SEED_DATABASE_URL'];
if (!url) {
  console.error('TMANAGE_SEED_DATABASE_URL is not set');
  process.exit(1);
}

const pool = createPool({ uri: url, connectionLimit: 2, timezone: 'Z' });
try {
  const world = await seedTwoTenants(pool);
  // stdout is the contract: the caller parses exactly one JSON line.
  process.stdout.write(`${JSON.stringify(world)}\n`);
} finally {
  await pool.end();
}
