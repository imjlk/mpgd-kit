import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  commerceBridgeMethods,
  createUnsupportedCommerceCapabilities,
} from '@mpgd/platform/commerce';
import { createCreditCommerceCapabilities } from '@mpgd/platform/commerce-wallet';

import {
  checkBridgeMethodLists,
  compareCapabilityBlockToRfcRow,
  parseRfcCapabilityProfiles,
  type BridgeMethodListInput,
} from './alignment-checks';

const methods = [...commerceBridgeMethods];
const schemaTitles = methods.flatMap((method) => {
  const base = `CommerceBridge${method.slice('commerce.v2.'.length).replace(/^./u, (c) => c.toUpperCase())}`;
  return [`${base}Payload`, `${base}Result`];
});
const union = methods.map((method) => `  | '${method}'`).join('\n');

function input(overrides: Partial<BridgeMethodListInput> = {}): BridgeMethodListInput {
  return {
    platformMethods: methods,
    bridgeMethods: methods,
    bridgeIndexSource: { path: 'bridge/index.ts', text: `type BridgeMethod =\n${union};` },
    rfcBridgeSection: { path: 'rfc.md', text: methods.join('\n') },
    schemaTitles,
    sources: [
      { path: 'host/serve.ts', text: methods.map((method) => `case '${method}':`).join('\n') },
    ],
    ...overrides,
  };
}

// A consistent set passes.
assert.deepEqual(checkBridgeMethodLists(input()), []);

// The bridge list drifting from the platform list fails.
assert.match(
  checkBridgeMethodLists(input({ bridgeMethods: methods.slice(1) })).join('\n'),
  /bridgeCommerceV2Methods .* must equal/u,
);

// The BridgeMethod union missing a method, or still naming a removed one, fails.
assert.match(
  checkBridgeMethodLists(input({
    bridgeIndexSource: { path: 'bridge/index.ts', text: methods.slice(1).map((m) => `'${m}'`).join('|') },
  })).join('\n'),
  /BridgeMethod does not name commerce\.v2\.getCapabilities/u,
);
assert.match(
  checkBridgeMethodLists(input({
    bridgeIndexSource: { path: 'bridge/index.ts', text: `${union}\n  | 'commerce.purchase'` },
  })).join('\n'),
  /still names removed commerce\.purchase/u,
);

// A schema index without a method's payload or result fails.
assert.match(
  checkBridgeMethodLists(input({ schemaTitles: schemaTitles.slice(1) })).join('\n'),
  /no CommerceBridgeGetCapabilitiesPayload/u,
);

// The RFC bridge section must name every method.
assert.match(
  checkBridgeMethodLists(input({ rfcBridgeSection: { path: 'rfc.md', text: 'none' } })).join('\n'),
  /bridge section does not name commerce\.v2\.fetchProducts/u,
);

// A transport that serves only some of the methods fails; one name alone is fine.
assert.match(
  checkBridgeMethodLists(input({
    sources: [{ path: 'host/partial.ts', text: "case 'commerce.v2.getCapabilities': case 'commerce.v2.fetchProducts':" }],
  })).join('\n'),
  /host\/partial\.ts: serves 2 commerce\.v2 methods but not commerce\.v2\.requestPurchase/u,
);
assert.deepEqual(
  checkBridgeMethodLists(
    input({
      sources: [{ path: 'host/one.ts', text: "if (method === 'commerce.v2.requestPurchase') {}" }],
    }),
  ),
  [],
);

// A method the platform does not define, and a removed v1 method in a host, fail.
assert.match(
  checkBridgeMethodLists(input({
    sources: [{ path: 'host/unknown.ts', text: "'commerce.v2.getEntitlements'" }],
  })).join('\n'),
  /names commerce\.v2\.getEntitlements/u,
);
for (const removed of [
  'commerce.getProducts',
  'commerce.purchase',
  'commerce.restore',
  'commerce.getEntitlements',
]) {
  assert.match(
    checkBridgeMethodLists(input({
      sources: [{ path: 'host/v1.ts', text: `case "${removed}":` }],
    })).join('\n'),
    new RegExp(`host/v1\\.ts: names removed v1 commerce method ${removed.replace('.', '\\.')}`, 'u'),
  );
}

// The real RFC profile table parses, row by row.
const rfc = readFileSync('docs/specs/commerce/commerce-v2-rfc.md', 'utf8');
const parsed = parseRfcCapabilityProfiles(rfc);
assert.deepEqual(parsed.failures, []);
assert.deepEqual(
  parsed.rows.map((row) => row.store),
  [
    'google-play',
    'app-store',
    'microsoft-store',
    'apps-in-toss',
    'devvit',
    'verse8',
    'oneplay',
    'wallet',
  ],
);
const playRow = parsed.rows.find((row) => row.store === 'google-play');
assert.ok(playRow);
assert.deepEqual(
  { ...playRow },
  {
    store: 'google-play',
    consumable: true,
    durable: true,
    subscription: false,
    availablePurchases: true,
    pending: true,
    finish: 'server',
    evidence: 'client-token',
    accountBinding: 'required',
  },
);

// A table that does not parse is a failure, not a skipped store.
assert.match(
  parseRfcCapabilityProfiles('| Store id | a |\n| --- | --- |\n| `x` | maybe |').failures.join('\n'),
  /expected 9/u,
);
assert.match(parseRfcCapabilityProfiles('no table').failures.join('\n'), /no "Store id"/u);

// A declared block that drifts from its RFC row names the field.
const unsupported = createUnsupportedCommerceCapabilities();
const row = { ...playRow, finish: 'client' } as const;
const drift = compareCapabilityBlockToRfcRow('probe', row, {
  ...unsupported,
  purchase: { ...unsupported.purchase, consumable: true, durable: true },
  lifecycle: {
    ...unsupported.lifecycle,
    availablePurchases: true,
    pending: true,
    finish: 'server',
  },
  authority: { evidence: 'client-token', accountBinding: 'required' },
});
assert.equal(drift.length, 1);
assert.match(
  drift[0] ?? '',
  /probe: capability lifecycle\.finish is server but the RFC profile row for google-play says client/u,
);

// The "available source" column is checked too: `none` means the store lists nothing.
const noListRow = parsed.rows.find((candidate) => candidate.store === 'verse8');
assert.ok(noListRow);
assert.equal(noListRow.availablePurchases, false);
const listing = compareCapabilityBlockToRfcRow('verse8-probe', noListRow, {
  ...unsupported,
  purchase: { ...unsupported.purchase, consumable: true, durable: true },
  lifecycle: {
    ...unsupported.lifecycle,
    availablePurchases: true,
    pending: true,
    finish: 'none',
  },
  authority: { evidence: 'server-push', accountBinding: 'host' },
});
assert.match(
  listing.join('\n'),
  /verse8-probe: capability lifecycle\.availablePurchases is true but the RFC profile row for verse8 says false/u,
);

// The wallet row sells subscriptions only conditionally, so either authority matches it.
const walletRow = parsed.rows.find((candidate) => candidate.store === 'wallet');
assert.ok(walletRow);
assert.deepEqual(
  compareCapabilityBlockToRfcRow(
    'wallet-host',
    walletRow,
    createCreditCommerceCapabilities('host', {}, { subscriptions: true }),
  ),
  [],
);
assert.deepEqual(
  compareCapabilityBlockToRfcRow(
    'wallet-store',
    walletRow,
    createCreditCommerceCapabilities('store'),
  ),
  [],
);

console.info('Commerce alignment checks passed.');
