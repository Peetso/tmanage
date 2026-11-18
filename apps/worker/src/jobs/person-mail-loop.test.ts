import { describe, expect, it } from 'vitest';

import { runPersonMailLoop, type PersonMailStore } from './person-mail-sweep.js';

/** A store that must not be read: the run is skipped before the sweep starts. */
const untouchedStore = new Proxy({} as PersonMailStore, {
  get: () => () => Promise.reject(new Error('the skipped run read the store')),
});

describe('runPersonMailLoop (LOGQUIET-a)', () => {
  it('skips the run silently while another process holds the person-mail lock', async () => {
    const controller = new AbortController();
    const asked: string[] = [];
    const errors: unknown[] = [];
    await runPersonMailLoop(
      {
        store: untouchedStore,
        mailer: null,
        webOrigin: 'https://tmanageapp.com',
        lock: {
          run: (name) => {
            asked.push(name);
            controller.abort();
            return Promise.resolve({ ran: false });
          },
        },
      },
      controller.signal,
      (error) => errors.push(error),
    );
    expect(asked).toEqual(['person-mail']);
    expect(errors).toEqual([]);
  });
});
