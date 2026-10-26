// Child process for migration-shutdown.test.mjs: a slow fake migration (two files of 600 ms) run
// through the gate, with a SIGTERM handler wired the way server.mjs wires its shutdown.
import { createMigrationGate } from './migration-shutdown.mjs';

const say = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const gate = createMigrationGate();
process.on('SIGTERM', () => {
  say('signal');
  gate.requestStop();
  void (async () => {
    try {
      await gate.settle();
    } finally {
      say('exit');
      process.exit(0);
    }
  })();
});
// Windows: the test cannot deliver a catchable SIGTERM from outside, so it asks over IPC.
process.on('message', (message) => {
  if (message === 'SIGTERM') process.emit('SIGTERM', 'SIGTERM');
});

await gate.run(async (shouldStop) => {
  for (let n = 1; n <= 2; n += 1) {
    if (shouldStop()) {
      say('stopped');
      return;
    }
    say(`start ${n}`);
    await sleep(600);
    say(`done ${n}`);
  }
});
// Not reached when a stop was requested: the handler above owns the exit.
if (!gate.stopping) {
  say('completed');
  process.exit(0);
}
