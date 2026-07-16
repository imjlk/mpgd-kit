import { assertProductCatalog, assertProductGrant, type ProductGrant } from './index';

const resourceGrant = Object.freeze({
  type: 'resource',
  resource: 'hint',
  amount: 5,
}) satisfies ProductGrant;

assertProductGrant(resourceGrant);
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
assertThrows(
  () => assertProductGrant({ type: 'resource', resource: '', amount: 5 } as never),
  'resource grant names should be non-empty',
);
assertThrows(
  () => assertProductGrant({ type: 'resource', resource: 'hint', amount: 0 } as never),
  'resource grant amounts should be positive',
);
assertThrows(
  () => assertProductGrant({
    type: 'resource',
    resource: 'hint',
    amount: Number.POSITIVE_INFINITY,
  } as never),
  'resource grant amounts should be finite',
);
assertThrows(
  () => assertProductCatalog({
    version: 'test',
    products: [{
      id: 'INVALID_RESOURCE',
      type: 'consumable',
      grant: { type: 'resource', resource: '', amount: 0 },
      platformProductIds: { reddit: 'invalid-resource' },
    }],
  } as never),
  'catalog validation should enforce resource grant constraints',
);

console.log('Catalog product grant validation test passed.');

function assertThrows(callback: () => unknown, message: string): void {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error(message);
}
