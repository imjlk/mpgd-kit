/** An error's message for another error's text; never the error's other fields. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
