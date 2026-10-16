import { createPool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';

/**
 * Read the `marketing_leads` rows that carry a given email — the e2e harness's way of
 * seeing the lead record a public contact submission produced, without granting the
 * public door a read endpoint it is designed never to have (x161: the runtime grant on
 * `marketing_leads` is INSERT only, and there is no HTTP read/list route for it).
 *
 * The same shape as `age-upload-session-cli.ts` and `seed-cli.ts`: spawned from
 * `e2e/public-lead-journeys.spec.ts` through this package's own `mysql2`, because the e2e
 * package holds no database client and is meant not to. The journey filters by an email it
 * minted for the run, so the specs' shared database never crosses one lead with another.
 *
 * Usage: `tsx test/marketing-lead-read-cli.ts <email>` with `TMANAGE_SEED_DATABASE_URL`
 * set. Test tooling only; nothing in any runtime path invokes it.
 */
const url = process.env['TMANAGE_SEED_DATABASE_URL'];
const email = process.argv[2];
if (!url) {
  console.error('TMANAGE_SEED_DATABASE_URL is not set');
  process.exit(1);
}
if (!email) {
  console.error('usage: marketing-lead-read-cli <email>');
  process.exit(1);
}

interface LeadRow extends RowDataPacket {
  id: string;
  name: string;
  email: string;
  message: string;
  source: string;
  created_at: Date;
}

const pool = createPool({ uri: url, connectionLimit: 1, timezone: 'Z' });
try {
  const [rows] = await pool.execute<LeadRow[]>(
    'select id, name, email, message, source, created_at from marketing_leads where email = ? order by created_at, id',
    [email],
  );
  const leads = rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    message: String(row.message),
    source: String(row.source),
    createdAt: new Date(row.created_at).toISOString(),
  }));
  // stdout is the contract: the caller parses exactly one JSON line.
  process.stdout.write(`${JSON.stringify({ email, count: leads.length, rows: leads })}\n`);
} finally {
  await pool.end();
}
