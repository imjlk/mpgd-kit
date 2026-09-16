/** Failure codes shared by the bounded ZIP decoder core, worker and client. */
export type ZipDecodeFailureCode =
  | 'archive-mismatch'
  | 'unsupported-zip'
  | 'invalid-structure'
  | 'entry-mismatch'
  | 'limit'
  | 'deadline'
  | 'cancelled'
  | 'decode'
  | 'integrity'
  | 'worker-error'
  | 'worker-busy'
  | 'unsupported';
/** Error thrown by the pure decoder core and the client for failed jobs. */
export class ZipDecodeError extends Error {
  constructor(
    readonly code: ZipDecodeFailureCode,
    message: string,
  ) {
    super(message);
  }
}
