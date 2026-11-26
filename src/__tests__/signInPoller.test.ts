import { describe, expect, it, vi } from 'vitest';
import type { PiAuthCheckResult } from '../types/ipc';
import {
  createSignInPoller,
  type SignInPollState,
  type SignInPollerDeps,
} from '../components/providerDialog/signInPoller';

const PROVIDER = 'opencode-go';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function checkResult(status: string, reason: string | null = null): PiAuthCheckResult {
  return { status, provider: PROVIDER, auth_type: null, reason };
}

/** Lets the poller's promise callbacks run without any real waiting. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface HarnessOptions {
  intervalMs?: number;
  timeoutMs?: number;
  maxConsecutiveErrors?: number;
}

function createHarness(options: HarnessOptions = {}) {
  let clock = 0;
  let nextId = 1;
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  const pending: Deferred<PiAuthCheckResult>[] = [];
  const states: SignInPollState[] = [];
  const check = vi.fn((_provider: string) => {
    const d = deferred<PiAuthCheckResult>();
    pending.push(d);
    return d.promise;
  });

  const deps: SignInPollerDeps<number> = {
    provider: PROVIDER,
    check,
    schedule: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, fn, ms });
      return id;
    },
    cancel: (id) => {
      const index = timers.findIndex((t) => t.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    now: () => clock,
    ...options,
    onState: (state) => states.push(state),
  };

  const poller = createSignInPoller(deps);

  const lastCheck = () => {
    const last = pending[pending.length - 1];
    if (!last) throw new Error('no pending check');
    return last;
  };

  return {
    poller,
    check,
    states,
    timers,
    pending,
    advance(ms: number) {
      clock += ms;
    },
    get timerDelays() {
      return timers.map((t) => t.ms);
    },
    runNextTimer() {
      const timer = timers.shift();
      if (!timer) throw new Error('no pending timer');
      timer.fn();
    },
    async settle(status: string, reason: string | null = null) {
      lastCheck().resolve(checkResult(status, reason));
      await flush();
    },
    async resolveWith(result: PiAuthCheckResult) {
      lastCheck().resolve(result);
      await flush();
    },
    async rejectWith(error: unknown) {
      lastCheck().reject(error);
      await flush();
    },
  };
}

describe('createSignInPoller', () => {
  it('schedules the first check 3 s after start instead of running it immediately', async () => {
    const h = createHarness();

    h.poller.start();
    await flush();

    expect(h.check).not.toHaveBeenCalled();
    expect(h.timerDelays).toEqual([3000]);

    h.runNextTimer();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.check).toHaveBeenCalledWith(PROVIDER);
  });

  it('honours a custom interval', () => {
    const h = createHarness({ intervalMs: 1000 });

    h.poller.start();
    expect(h.timerDelays).toEqual([1000]);
  });

  it('chains the next check only after the previous one settles (never overlapping)', async () => {
    const h = createHarness();

    h.poller.start();
    h.runNextTimer();
    await flush();

    // The check is in flight: no timer is armed yet and no second call happened.
    expect(h.timerDelays).toEqual([]);
    expect(h.check).toHaveBeenCalledTimes(1);

    await h.settle('not_ready');

    expect(h.timerDelays).toEqual([3000]);
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it('emits ready and stops when the check is ready', async () => {
    const h = createHarness();

    h.poller.start();
    h.runNextTimer();
    await flush();
    await h.settle('ready');

    expect(h.states).toEqual([{ kind: 'ready', check: checkResult('ready') }]);
    expect(h.timerDelays).toEqual([]);
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it('emits invalid with the reason and stops', async () => {
    const h = createHarness();

    h.poller.start();
    h.runNextTimer();
    await flush();
    await h.settle('invalid', 'no credentials');

    expect(h.states).toEqual([{ kind: 'invalid', reason: 'no credentials' }]);
    expect(h.timerDelays).toEqual([]);
  });

  it('keeps waiting on not_ready', async () => {
    const h = createHarness();

    h.poller.start();
    h.runNextTimer();
    await flush();
    await h.settle('not_ready');

    expect(h.states).toEqual([]);
    expect(h.timerDelays).toEqual([3000]);

    h.runNextTimer();
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it('emits error after 3 consecutive rejections', async () => {
    const h = createHarness();

    h.poller.start();
    h.runNextTimer();
    await flush();
    await h.rejectWith(new Error('boom 1'));
    expect(h.states).toEqual([]);
    expect(h.timerDelays).toEqual([3000]);

    h.runNextTimer();
    await flush();
    await h.rejectWith(new Error('boom 2'));
    expect(h.states).toEqual([]);

    h.runNextTimer();
    await flush();
    await h.rejectWith(new Error('boom 3'));

    expect(h.states).toEqual([{ kind: 'error', detail: 'boom 3' }]);
    expect(h.timerDelays).toEqual([]);
  });

  it('resets the rejection count after a successful check in between', async () => {
    const h = createHarness();

    h.poller.start();
    h.runNextTimer();
    await flush();
    await h.rejectWith(new Error('boom 1'));

    h.runNextTimer();
    await flush();
    await h.rejectWith(new Error('boom 2'));

    h.runNextTimer();
    await flush();
    await h.settle('not_ready');

    h.runNextTimer();
    await flush();
    await h.rejectWith(new Error('boom 3'));
    expect(h.states).toEqual([]);
    expect(h.timerDelays).toEqual([3000]);

    h.runNextTimer();
    await flush();
    await h.rejectWith(new Error('boom 4'));
    expect(h.states).toEqual([]);

    h.runNextTimer();
    await flush();
    await h.rejectWith(new Error('boom 5'));
    expect(h.states).toEqual([{ kind: 'error', detail: 'boom 5' }]);
  });

  it('emits timeout from the injected clock, not from tick counts', async () => {
    const h = createHarness();

    h.poller.start();
    h.runNextTimer();
    await flush();
    await h.settle('not_ready');

    h.advance(120_000);
    h.runNextTimer();
    await flush();

    expect(h.states).toEqual([{ kind: 'timeout' }]);
    expect(h.timerDelays).toEqual([]);

    // Nothing else fires after the timeout.
    h.advance(60_000);
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it('also times out when the clock passes the deadline while a check is in flight', async () => {
    const h = createHarness();

    h.poller.start();
    h.runNextTimer();
    await flush();

    h.advance(120_000);
    await h.settle('not_ready');

    expect(h.states).toEqual([{ kind: 'timeout' }]);
    expect(h.timerDelays).toEqual([]);
  });

  it('respects a custom timeout', async () => {
    const h = createHarness({ timeoutMs: 5000 });

    h.poller.start();
    h.runNextTimer();
    await flush();
    h.advance(5000);
    await h.settle('not_ready');

    expect(h.states).toEqual([{ kind: 'timeout' }]);
  });

  it('checkNow runs immediately and cancels the pending timer when nothing is in flight', async () => {
    const h = createHarness();

    h.poller.start();
    expect(h.timerDelays).toEqual([3000]);

    h.poller.checkNow();
    await flush();

    expect(h.timerDelays).toEqual([]);
    expect(h.check).toHaveBeenCalledTimes(1);

    await h.settle('not_ready');
    expect(h.timerDelays).toEqual([3000]);
  });

  it('checkNow is coalesced with a check that is already in flight', async () => {
    const h = createHarness();

    h.poller.start();
    h.runNextTimer();
    await flush();
    expect(h.check).toHaveBeenCalledTimes(1);

    h.poller.checkNow();
    h.poller.checkNow();
    await flush();

    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.timerDelays).toEqual([]);

    await h.settle('not_ready');
    expect(h.timerDelays).toEqual([3000]);
  });

  it('does nothing before start or after stop', async () => {
    const h = createHarness();

    h.poller.checkNow();
    await flush();
    expect(h.check).not.toHaveBeenCalled();

    h.poller.start();
    h.poller.stop();
    expect(h.timerDelays).toEqual([]);

    h.poller.checkNow();
    await flush();
    expect(h.check).not.toHaveBeenCalled();
  });

  it('stop cancels the pending timer and ignores a late result', async () => {
    const h = createHarness();

    h.poller.start();
    h.runNextTimer();
    await flush();

    h.poller.stop();
    await h.resolveWith(checkResult('ready'));

    expect(h.states).toEqual([]);
    expect(h.timerDelays).toEqual([]);

    // A rejection after stop is ignored too.
    const h2 = createHarness();
    h2.poller.start();
    h2.runNextTimer();
    await flush();
    h2.poller.stop();
    await h2.rejectWith(new Error('late'));
    expect(h2.states).toEqual([]);
  });

  it('is idempotent for start and stop', () => {
    const h = createHarness();

    h.poller.start();
    h.poller.start();
    expect(h.timerDelays).toEqual([3000]);

    h.poller.stop();
    h.poller.stop();
    expect(h.timerDelays).toEqual([]);
  });
});
