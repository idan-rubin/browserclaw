/** Release one caller without cancelling work that still owns security or cleanup. */
export async function raceWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  canAbort: () => boolean = () => true,
): Promise<T> {
  if (!signal) return await operation;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      if (canAbort()) {
        // AbortSignal accepts arbitrary reasons; preserve the caller's identity.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal.reason);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([aborted, operation]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
