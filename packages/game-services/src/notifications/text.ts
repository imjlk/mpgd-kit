/**
 * An error's message for another error's text; never the error's other
 * fields. Never throws: a getter or `toString` that throws, or a `Proxy`
 * whose traps throw, reads as a failure that cannot be read.
 */
export function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'a failure that cannot be read';
  }
}
