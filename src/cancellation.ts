/** Execution control is deliberately separate from serializable approved inputs. */
export type ExecutionOptions = { signal?: AbortSignal };

export class RunInterruptedError extends Error {
  constructor() {
    super('Run interrupted.');
    this.name = 'RunInterruptedError';
  }
}

export function throwIfInterrupted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RunInterruptedError();
}

/** Only use for boundaries that cannot edit the repository. Fence late continuations. */
export async function interruptible<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfInterrupted(signal);
  if (!signal) return start();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new RunInterruptedError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      throwIfInterrupted(signal);
      return start();
    }).then((value) => {
      throwIfInterrupted(signal);
      resolve(value);
    }).catch(reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
