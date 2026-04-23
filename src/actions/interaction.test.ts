import { describe, it, expect } from 'vitest';

import { awaitActionWithAbort } from './interaction.js';

// ─────────────────────────────────────────────────────────────────────────────
// awaitActionWithAbort
// ─────────────────────────────────────────────────────────────────────────────

describe('awaitActionWithAbort', () => {
  it('resolves with action result when no abort promise provided', async () => {
    const result = await awaitActionWithAbort(Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('resolves with action result when abort promise is pending', async () => {
    const abortPromise = new Promise<never>(() => {
      /* never rejects */
    });
    abortPromise.catch(() => {
      /* suppress */
    });
    const result = await awaitActionWithAbort(Promise.resolve('ok'), abortPromise);
    expect(result).toBe('ok');
  });

  it('throws action error when action rejects before abort', async () => {
    const actionError = new Error('action failed');
    let abortReject!: (r: unknown) => void;
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    abortPromise.catch(() => {
      /* suppress */
    });
    await expect(awaitActionWithAbort(Promise.reject(actionError), abortPromise)).rejects.toThrow('action failed');
    abortReject(new Error('cleanup'));
  });

  it('throws abort error when abort promise rejects before action resolves', async () => {
    const abortError = new Error('aborted');
    let abortReject!: (r: unknown) => void;
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    abortPromise.catch(() => {
      /* suppress */
    });

    const slowAction = new Promise<string>((resolve) =>
      setTimeout(() => {
        resolve('done');
      }, 100),
    );
    const racePromise = awaitActionWithAbort(slowAction, abortPromise);
    abortReject(abortError);

    await expect(racePromise).rejects.toThrow('aborted');
  });

  it('swallows losing action rejection after abort wins — no unhandled rejection', async () => {
    let abortReject!: (r: unknown) => void;
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    abortPromise.catch(() => {
      /* suppress */
    });

    let actionReject!: (r: unknown) => void;
    const actionPromise = new Promise<never>((_, reject) => {
      actionReject = reject;
    });

    const racePromise = awaitActionWithAbort(actionPromise, abortPromise);
    abortReject(new Error('aborted'));
    await expect(racePromise).rejects.toThrow('aborted');
    // Rejecting the action after abort has won must not cause unhandled rejection
    actionReject(new Error('late action error'));
    // Give microtasks a tick to flush
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
