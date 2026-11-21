// 62-A0 test child: takes the job and allocates until its V8 heap cap stops it (the memory cap).
import process from 'node:process';
const held = [];
process.on('message', () => {
  for (;;) held.push(new Array(1_000_000).fill(held.length));
});
