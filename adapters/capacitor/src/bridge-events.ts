// How the adapter's event channels filter envelopes. Internal: the package
// entry does not export this module.

/**
 * Whether `envelope` names a protocol other than `protocol`. A channel may
 * carry several protocols, and another protocol is not this consumer's to
 * judge, so it is skipped. An envelope without a protocol string is
 * malformed and is not skipped: it must reach the consumer's validator.
 */
export function namesOtherProtocol(envelope: unknown, protocol: string): boolean {
  const named: unknown = typeof envelope === 'object' && envelope !== null
    ? (envelope as { readonly protocol?: unknown }).protocol
    : undefined;
  return typeof named === 'string' && named !== protocol;
}
