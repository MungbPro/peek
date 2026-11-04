/** Bound waits even when a native operation cannot itself be cancelled. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(signal.reason ?? new DOMException('Stopped', 'AbortError')); };
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    // Observe both outcomes of the underlying operation, including late ones.
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
