import { createPool } from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2/promise';

/**
 * Move one organization's `created_at` a number of days into the past — the e2e harness's way of
 * reaching a rule that counts a workspace's age (WTP: the pricing question waits 14 days) without
 * waiting the days. The same shape as `age-upload-session-cli.ts`: spawned from
 * `e2e/setup/stack.ts` through this package's own `mysql2`, because the e2e package holds no
 * database client and is meant not to.
 *
 * The new instant is a bound `Date` computed here, never the admin connection's
 * `current_timestamp` (that pool's clock is the server's, not UTC). Only `created_at` moves;
 * 0001's trigger guards `organizations.id`, which this never touches.
 *
 * Usage: `tsx test/age-organization-cli.ts <organizationId> <days>` with
 * `TMANAGE_SEED_DATABASE_URL` set. Test tooling only; nothing in any runtime path invokes it.
 */
const url = process.env['TMANAGE_SEED_DATABASE_URL'];
const [organizationId, daysText] = process.argv.slice(2);
const days = Number(daysText);
if (!url) {
  console.error('TMANAGE_SEED_DATABASE_URL is not set');
  process.exit(1);
}
if (!organizationId || !Number.isInteger(days) || days < 1) {
  console.error('usage: age-organization-cli <organizationId> <days>');
  process.exit(1);
}

const createdAt = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const pool = createPool({ uri: url, connectionLimit: 1, timezone: 'Z' });
try {
  const [result] = await pool.execute<ResultSetHeader>(
    'update organizations set created_at = ? where id = ?',
    [createdAt, organizationId],
  );
  // stdout is the contract: the caller parses exactly one JSON line.
  process.stdout.write(`${JSON.stringify({ organizationId, aged: result.affectedRows })}\n`);
  if (result.affectedRows !== 1) process.exitCode = 1;
} finally {
  await pool.end();
}
