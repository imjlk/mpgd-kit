export type CurrencyCode = 'coin' | 'gem';

export type Wallet = Readonly<Record<CurrencyCode, number>>;

export interface CurrencyGrant {
  readonly currency: CurrencyCode;
  readonly amount: number;
}

export function createEmptyWallet(): Wallet {
  return {
    coin: 0,
    gem: 0,
  };
}

export function applyGrant(wallet: Wallet, grant: CurrencyGrant): Wallet {
  if (!Number.isInteger(grant.amount) || grant.amount < 0) {
    throw new RangeError('grant.amount must be a non-negative integer.');
  }

  return {
    ...wallet,
    [grant.currency]: wallet[grant.currency] + grant.amount,
  };
}

export function canSpend(wallet: Wallet, cost: CurrencyGrant): boolean {
  return wallet[cost.currency] >= cost.amount;
}
