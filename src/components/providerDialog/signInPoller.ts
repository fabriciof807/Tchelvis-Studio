import type { PiAuthCheckResult } from '../../types/ipc';

/**
 * Outcome reported by the sign-in poller (`docs/specs/s3-provider-dialog.md` §4.4).
 * `waiting` is part of the contract but the poller does not emit it: the panel's
 * phase and the `m:ss` elapsed ticker live in the store/component, so the poller
 * owns no UI timer.
 */
export type SignInPollState =
  | { kind: 'waiting'; elapsedMs: number }
  | { kind: 'ready'; check: PiAuthCheckResult }
  | { kind: 'timeout' }
  | { kind: 'invalid'; reason: string | null }
  | { kind: 'error'; detail: string };

export interface SignInPollerDeps<H> {
  provider: string;
  check: (provider: string) => Promise<PiAuthCheckResult>;
  schedule: (fn: () => void, ms: number) => H;
  cancel: (handle: H) => void;
  now: () => number;
  /** Delay before the first check and between chained checks. Default 3000 ms. */
  intervalMs?: number;
  /** Deadline measured with `now()`. Default 120000 ms. */
  timeoutMs?: number;
  /** Consecutive rejected checks tolerated before reporting `error`. Default 3. */
  maxConsecutiveErrors?: number;
  onState: (state: SignInPollState) => void;
}

export interface SignInPoller {
  start(): void;
  checkNow(): void;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/**
 * Polls `pi auth check` while the user signs in, with every side effect injected
 * so tests can drive a hand-rolled scheduler and clock. Checks are chained
 * (`setTimeout`-style), never overlapping.
 */
export function createSignInPoller<H>(deps: SignInPollerDeps<H>): SignInPoller {
  const { provider, check, schedule, cancel, now, onState } = deps;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxConsecutiveErrors = deps.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;

  let started = false;
  let stopped = false;
  let startedAt = 0;
  let timer: H | null = null;
  let inFlight = false;
  let consecutiveErrors = 0;

  function clearTimer(): void {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  }

  function finish(state: SignInPollState): void {
    stopped = true;
    clearTimer();
    onState(state);
  }

  function timedOut(): boolean {
    return now() - startedAt >= timeoutMs;
  }

  function arm(): void {
    if (stopped) return;
    timer = schedule(tick, intervalMs);
  }

  function tick(): void {
    timer = null;
    if (stopped) return;
    if (timedOut()) {
      finish({ kind: 'timeout' });
      return;
    }
    runCheck();
  }

  function runCheck(): Promise<void> {
    if (stopped || inFlight) return Promise.resolve();
    inFlight = true;

    let pending: Promise<PiAuthCheckResult>;
    try {
      pending = check(provider);
    } catch (error) {
      pending = Promise.reject(error);
    }

    return pending.then(
      (result) => {
        inFlight = false;
        if (stopped) return;
        consecutiveErrors = 0;
        if (result.status === 'ready') {
          finish({ kind: 'ready', check: result });
          return;
        }
        if (result.status === 'invalid') {
          finish({ kind: 'invalid', reason: result.reason ?? null });
          return;
        }
        // `not_ready` (or any unknown status): keep waiting unless out of time.
        if (timedOut()) {
          finish({ kind: 'timeout' });
          return;
        }
        arm();
      },
      (error: unknown) => {
        inFlight = false;
        if (stopped) return;
        consecutiveErrors += 1;
        if (timedOut()) {
          finish({ kind: 'timeout' });
          return;
        }
        if (consecutiveErrors >= maxConsecutiveErrors) {
          finish({ kind: 'error', detail: describeError(error) });
          return;
        }
        arm();
      },
    );
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      startedAt = now();
      arm();
    },
    checkNow() {
      if (!started || stopped || inFlight) return;
      clearTimer();
      runCheck();
    },
    stop() {
      stopped = true;
      clearTimer();
    },
  };
}
