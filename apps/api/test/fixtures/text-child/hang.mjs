// 62-A0 test child: takes the job and never answers (the timeout kill).
import process from 'node:process';
import { setInterval } from 'node:timers';
process.on('message', () => {
  setInterval(() => undefined, 1_000);
});
