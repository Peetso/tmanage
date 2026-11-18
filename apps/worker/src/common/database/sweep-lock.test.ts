import { describe, expect, it } from 'vitest';

import { createSweepLock } from './sweep-lock.js';

/** A fake lock connection: one server-wide lock table shared by every "process". */
function fakeServer() {
  const owners = new Map<string, string>();
  const statements: string[] = [];
  const session = (id: string) => async (sql: string, params: readonly unknown[]) => {
    const name = String(params[0]);
    statements.push(`${id}:${sql.includes('GET_LOCK') ? 'get' : 'release'}:${name}`);
    if (sql.includes('GET_LOCK')) {
      const owner = owners.get(name);
      if (owner !== undefined && owner !== id) return [{ acquired: 0 }];
      owners.set(name, id);
      return [{ acquired: 1 }];
    }
    owners.delete(name);
    return [{ released: 1 }];
  };
  return { session, statements };
}

const end = () => Promise.resolve();

/** A pass that stays running until `release()`; `started` resolves once it is inside the lock. */
function heldPass() {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const work = () =>
    new Promise<void>((resolve) => {
      release = resolve;
      entered();
    });
  return { work, started, release: () => release() };
}

describe('createSweepLock', () => {
  it('runs the pass under the lock and releases it after', async () => {
    const server = fakeServer();
    const lock = createSweepLock(server.session('a'), end);
    await expect(lock.run('invitations', () => Promise.resolve(3))).resolves.toEqual({
      ran: true,
      result: 3,
    });
    expect(server.statements).toEqual(['a:get:invitations', 'a:release:invitations']);
  });

  it('skips silently while another process holds the same sweep, and runs other sweeps', async () => {
    const server = fakeServer();
    const first = createSweepLock(server.session('a'), end);
    const second = createSweepLock(server.session('b'), end);
    const pass = heldPass();
    const running = first.run('budget-burn', pass.work);
    await pass.started;
    let ran = false;
    await expect(second.run('budget-burn', async () => void (ran = true))).resolves.toEqual({
      ran: false,
    });
    expect(ran).toBe(false);
    await expect(second.run('retainer-roll', () => Promise.resolve('ok'))).resolves.toEqual({
      ran: true,
      result: 'ok',
    });
    pass.release();
    await running;
    await expect(second.run('budget-burn', () => Promise.resolve(1))).resolves.toEqual({
      ran: true,
      result: 1,
    });
  });

  it('releases the lock when the pass throws, and skips a pass of the same name in flight', async () => {
    const server = fakeServer();
    const lock = createSweepLock(server.session('a'), end);
    const pass = heldPass();
    const running = lock.run('webhooks', pass.work);
    await pass.started;
    await expect(lock.run('webhooks', () => Promise.resolve(1))).resolves.toEqual({ ran: false });
    pass.release();
    await running;
    await expect(lock.run('webhooks', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(server.statements.at(-1)).toBe('a:release:webhooks');
  });
});
