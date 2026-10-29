/**
 * A native support probe: asks the plugin once whether its build declares a
 * feature, and answers every later caller from that answer. The rule matches
 * the sheet-facts probe of `@mpgd/adapter-capacitor`
 * (`createNativePurchasePresentation().supported()`), kept here so this
 * package does not depend on that adapter's version for it:
 *
 * - `read` runs inside the promise chain, so a plugin proxy that throws on
 *   access is answered like a call that failed.
 * - Any answer is passed to `declared` and remembered (a build without the
 *   method answers `undefined`).
 * - `UNIMPLEMENTED` (a native build from before the method) is remembered as
 *   "not supported".
 * - Any other failure answers "not supported" for this caller and is asked
 *   again by the next one.
 */
export function probeNativeSupport(
  read: () => unknown,
  declared: (answer: unknown) => boolean,
): () => Promise<boolean> {
  let support: Promise<boolean> | undefined;
  return () => {
    if (support !== undefined) {
      return support;
    }
    const attempt = Promise.resolve()
      .then(read)
      .then(declared, (error: unknown) => {
        if (!isRecord(error) || error.code !== 'UNIMPLEMENTED') {
          support = undefined;
        }
        return false;
      });
    support = attempt;
    return attempt;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
