import { createPool } from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2/promise';

/**
 * Move one upload session's `expires_at` into the past — the e2e harness's way of making a
 * reservation "abandoned" without waiting `STORAGE_UPLOAD_URL_TTL_SECONDS` for it
 * (E2E-12b). The same shape as `seed-cli.ts`: spawned from `e2e/setup/stack.ts` through
 * this package's own `mysql2`, because the e2e package holds no database client and is
 * meant not to.
 *
 * Only `expires_at` moves. 0016's immutability trigger on `upload_sessions` names the
 * columns a row may never change and this is deliberately not one of them: a lifetime is a
 * fact about the reservation, not its identity. The session is aged by a full day, which
 * clears any grace the sweeper applies.
 *
 * Usage: `tsx test/age-upload-session-cli.ts <uploadSessionId>` with
 * `TMANAGE_SEED_DATABASE_URL` set. Test tooling only; nothing in any runtime path invokes it.
 */
const url = process.env['TMANAGE_SEED_DATABASE_URL'];
const uploadSessionId = process.argv[2];
if (!url) {
  console.error('TMANAGE_SEED_DATABASE_URL is not set');
  process.exit(1);
}
if (!uploadSessionId) {
  console.error('usage: age-upload-session-cli <uploadSessionId>');
  process.exit(1);
}

const pool = createPool({ uri: url, connectionLimit: 1, timezone: 'Z' });
try {
  const [result] = await pool.execute<ResultSetHeader>(
    'update upload_sessions set expires_at = date_sub(expires_at, interval 1 day) where id = ?',
    [uploadSessionId],
  );
  // stdout is the contract: the caller parses exactly one JSON line.
  process.stdout.write(`${JSON.stringify({ uploadSessionId, aged: result.affectedRows })}\n`);
  if (result.affectedRows !== 1) process.exitCode = 1;
} finally {
  await pool.end();
}
