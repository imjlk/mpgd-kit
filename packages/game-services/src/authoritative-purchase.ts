import type { CommerceCapabilities, PlatformGateway, PurchaseResult } from '@mpgd/platform';

type CommerceProvider = NonNullable<PlatformGateway['commerceV2']>;

export interface AdapterSettledGrant {
  readonly ledgerEntryId: string;
  readonly alreadyProcessed?: boolean;
}

/**
 * Internal: the ledger grant a checkout result already carries, or undefined
 * when the backend must verify. A gateway with a commerce v2 provider decides
 * from the provider's capability block (RFC "Capabilities":
 * `authority.evidence: 'adapter-settled'`) plus the result's
 * `authoritativeGrant`; a provider whose capabilities cannot be read, or that
 * declares any other evidence, answers undefined so the client verifies. A
 * gateway without a v2 provider keeps the deprecated target-name rule until
 * C4 removes it.
 */
export async function findAdapterSettledGrant(input: {
  readonly gateway: Pick<PlatformGateway, 'commerceV2'>;
  readonly target: string;
  readonly purchase: PurchaseResult;
}): Promise<AdapterSettledGrant | undefined> {
  const { purchase } = input;
  const grant = purchase.authoritativeGrant;
  if (purchase.status !== 'completed' || purchase.transactionId === undefined || grant === undefined) {
    return undefined;
  }
  const provider = input.gateway.commerceV2;
  const settled = provider === undefined
    ? isAuthoritativeMicrosoftStoreCompletion(input.target, purchase)
    : (await readEvidenceAuthority(provider)) === 'adapter-settled';
  if (!settled) {
    return undefined;
  }
  return {
    ledgerEntryId: grant.ledgerEntryId,
    ...(grant.alreadyProcessed === undefined ? {} : { alreadyProcessed: grant.alreadyProcessed }),
  };
}

/**
 * A provider's `authority.evidence` declaration is fixed for its lifetime, so
 * one successful read serves every later checkout; a failed read is not
 * cached, and the next checkout probes again.
 */
const evidenceAuthorityByProvider = new WeakMap<
  CommerceProvider,
  CommerceCapabilities['authority']['evidence']
>();

async function readEvidenceAuthority(
  provider: CommerceProvider,
): Promise<CommerceCapabilities['authority']['evidence'] | undefined> {
  const cached = evidenceAuthorityByProvider.get(provider);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const { evidence } = (await provider.getCapabilities()).authority;
    evidenceAuthorityByProvider.set(provider, evidence);
    return evidence;
  } catch {
    return undefined;
  }
}

/**
 * Internal: the Microsoft Store adapter completes the ledger grant before it returns this
 * checkout result, so no further backend verification is requested for it.
 *
 * @deprecated Settlement is declared by the commerce v2 capability block; use
 * `findAdapterSettledGrant`, which reads it on gateways that expose `commerceV2`. Kept for
 * gateways that still install only the v1 `createMicrosoftStoreCommerceAdapter`; C4 removes it.
 */
export function isAuthoritativeMicrosoftStoreCompletion(
  target: string,
  purchase: PurchaseResult,
): purchase is PurchaseResult & { readonly status: 'completed'; readonly transactionId: string } {
  return target === 'microsoft-store'
    && purchase.status === 'completed'
    && purchase.transactionId !== undefined
    && purchase.authoritativeGrant?.ledgerEntryId === purchase.transactionId;
}
