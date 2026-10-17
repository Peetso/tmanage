// Imported FIRST by server.mjs, before reflect-metadata, Nest or @tmanage/config: the bundle
// runs as production or not at all (pre-launch security review 2026-10-17, HIGH). A missing
// NODE_ENV is set to `production`; any other value stops the process with a plain message.
import { resolveNodeEnv } from './boot-guards.mjs';

const decision = resolveNodeEnv(process.env['NODE_ENV']);
if ('error' in decision) {
  process.stderr.write(`[server] refusing to start: ${decision.error}\n`);
  process.exit(1);
}
process.env['NODE_ENV'] = decision.nodeEnv;
if (decision.note) process.stderr.write(`[server] ${decision.note}\n`);
