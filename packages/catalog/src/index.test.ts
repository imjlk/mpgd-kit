import { assertProductGrant, type ProductGrant } from './index';

const resourceGrant = Object.freeze({
  type: 'resource',
  resource: 'hint',
  amount: 5,
}) satisfies ProductGrant;

assertEqual(
  assertProductGrant(resourceGrant),
  resourceGrant,
  'catalog validation should preserve generic resource grants',
);
assertProductGrant({ type: 'currency', currency: 'coin', amount: 100 });
assertProductGrant({ type: 'entitlement', entitlement: 'theme.ember' });
assertThrows(
  () => assertProductGrant({ type: 'resource', resource: 'hint' } as never),
  'resource grants should require an amount',
);
assertThrows(
  () => assertProductGrant({ type: 'resource', resource: 5, amount: 5 } as never),
  'resource grant names should remain strings',
);

console.log('Catalog product grant validation test passed.');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(message);
  }
}

function assertThrows(callback: () => unknown, message: string): void {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error(message);
}
