/** Hard limits applied to untrusted client requests before they reach ledger keys. */
export const gameServicesRequestLimits = {
  /** Maximum length of any identifier or timestamp string in a client request. */
  maxStringLength: 256,
  /** Maximum number of entries accepted inside a platform evidence payload. */
  maxEvidencePayloadEntries: 64,
  /** Maximum request body size accepted by the HTTP and oRPC fetch handlers. */
  maxBodyBytes: 64 * 1024,
} as const;

/**
 * A client-supplied request failed validation. Handlers map this error to a 400 response
 * with the stable `INVALID_REQUEST` code; every other error is treated as internal.
 */
export class GameServicesRequestValidationError extends Error {
  readonly code = 'INVALID_REQUEST';

  constructor(message: string) {
    super(message);
    this.name = 'GameServicesRequestValidationError';
  }
}

export function toGameServicesRequestValidationError(
  error: unknown,
): GameServicesRequestValidationError {
  if (error instanceof GameServicesRequestValidationError) {
    return error;
  }

  return new GameServicesRequestValidationError(
    error instanceof Error ? error.message : 'Request validation failed.',
  );
}

export function assertOwnEnumerablePropertyLimit(
  input: Record<string, unknown>,
  maximum: number,
  label: string,
): void {
  let propertyCount = 0;

  for (const key in input) {
    if (Object.hasOwn(input, key)) {
      propertyCount += 1;

      if (propertyCount > maximum) {
        throw new Error(`${label} must not contain more than ${String(maximum)} entries.`);
      }
    }
  }
}
