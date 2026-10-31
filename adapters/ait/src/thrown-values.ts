/**
 * Reads a thrown value defensively. A value thrown across a bridge or by a
 * platform SDK may be anything, including a hostile one: a getter or
 * `toString` that throws, or a `Proxy` whose traps throw. None of these
 * throws, so a catch block that reads a failure never fails itself.
 */

/** `value[key]`, or `undefined` when `value` has no fields or reading the field throws. */
export function readThrownField(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  try {
    return (value as Readonly<Record<string, unknown>>)[key];
  } catch {
    return undefined;
  }
}

/** `value instanceof type`, or `false` when the check throws (a `Proxy` whose `getPrototypeOf` trap throws). */
export function isThrownInstance<T>(value: unknown, type: abstract new (...args: never[]) => T): value is T {
  try {
    return value instanceof type;
  } catch {
    return false;
  }
}

/** A thrown value's `message`, else its text, else a fixed text when neither can be read. */
export function thrownMessage(value: unknown): string {
  const message = readThrownField(value, 'message');
  if (typeof message === 'string') {
    return message;
  }
  try {
    return String(value);
  } catch {
    return 'a failure that cannot be read';
  }
}
