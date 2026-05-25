/**
 * Unit tests for `src/durable-objects/thread-lock.ts`.
 *
 * Drives the DO via the `ThreadLockStub` returned by `getThreadLock`,
 * with `env.MAKOTO_THREAD_LOCK` set to an in-memory fake namespace.
 */

import { describe, it, expect } from 'vitest';
import { getThreadLock } from '../src/durable-objects/thread-lock';
import { makeFakeThreadLockNamespace } from './makoto-helpers';

function envWith(): Env {
  return {
    MAKOTO_THREAD_LOCK: makeFakeThreadLockNamespace(),
  } as unknown as Env;
}

describe('ThreadLock', () => {
  it('first acquire succeeds', async () => {
    const env = envWith();
    const lock = getThreadLock(env, 'thread-A');
    const r = await lock.acquire('key1', 60_000);
    expect(r.acquired).toBe(true);
  });

  it('second acquire while held returns acquired=false with retry_after_ms', async () => {
    const env = envWith();
    const lock = getThreadLock(env, 'thread-A');
    await lock.acquire('key1', 60_000);
    const r = await lock.acquire('key1', 60_000);
    expect(r.acquired).toBe(false);
    expect(r.retry_after_ms ?? 0).toBeGreaterThan(0);
  });

  it('after release a second acquire succeeds', async () => {
    const env = envWith();
    const lock = getThreadLock(env, 'thread-A');
    await lock.acquire('key1', 60_000);
    await lock.release('key1');
    const r = await lock.acquire('key1', 60_000);
    expect(r.acquired).toBe(true);
  });

  it('different keys on the same instance do not collide', async () => {
    const env = envWith();
    const lock = getThreadLock(env, 'thread-A');
    expect((await lock.acquire('k1')).acquired).toBe(true);
    expect((await lock.acquire('k2')).acquired).toBe(true);
  });

  it('different thread keys land on different DO instances', async () => {
    const env = envWith();
    const lockA = getThreadLock(env, 'thread-A');
    const lockB = getThreadLock(env, 'thread-B');
    expect((await lockA.acquire('k')).acquired).toBe(true);
    expect((await lockB.acquire('k')).acquired).toBe(true);
  });

  it('extend refreshes the deadline without ownership check', async () => {
    const env = envWith();
    const lock = getThreadLock(env, 'thread-A');
    await lock.acquire('k', 60_000);
    const r = await lock.extend('k', 60_000);
    expect(r.extended).toBe(true);
  });
});
