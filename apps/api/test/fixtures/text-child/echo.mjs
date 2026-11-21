// 62-A0 test child: answers with what it was started with and what it was sent.
import process from 'node:process';
process.on('message', (job) => {
  const seen = {
    execArgv: process.execArgv,
    parentPid: process.env.TMANAGE_PARENT_PID ?? null,
    bytes: job.bytes.byteLength,
    mimeType: job.mimeType,
  };
  process.send(
    {
      outcome: {
        status: 'ready',
        text: JSON.stringify(seen),
        pages: null,
        truncated: false,
        extractor: 'plain',
      },
    },
    () => process.exit(0),
  );
});
