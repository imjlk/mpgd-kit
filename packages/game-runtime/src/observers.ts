/** Observation must never change the outcome of the operation being observed. */
export type ObserverErrorHandler = (error: unknown) => void | Promise<void>;

export function observe(
  callback: () => void | Promise<void>,
  onError?: ObserverErrorHandler,
): void {
  const report = (error: unknown): void => {
    try {
      const result = onError?.(error);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
      }
    } catch {
      // An error observer has no authority to fail a business operation.
    }
  };
  try {
    const result = callback();
    if (result !== undefined) {
      void Promise.resolve(result).catch(report);
    }
  } catch (error) {
    report(error);
  }
}
