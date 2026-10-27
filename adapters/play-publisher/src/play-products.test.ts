import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { createMockProductCatalog } from './index.js';

/**
 * The one-time product adapter against a local mock of the Android Publisher
 * REST surface: the paths, query parameters and bodies the generated SDK
 * sends for `monetization.onetimeproducts`. No Google endpoint is called.
 */

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: unknown;
}

const packageName = 'dev.mpgd.store';
const recorded: Recorded[] = [];
const base = `/androidpublisher/v3/applications/${packageName}`;

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text) as unknown;
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '', 'http://localhost');
    const entry: Recorded = {
      method: request.method ?? '',
      path: decodeURIComponent(url.pathname),
      query: Object.fromEntries(url.searchParams),
      body: await readBody(request),
    };
    recorded.push(entry);
    assert.equal(request.headers.authorization, 'Bearer mock-play-token');
    if (entry.method === 'GET' && entry.path === `${base}/oneTimeProducts`) {
      if (entry.query.pageToken === undefined) {
        reply(response, 200, {
          oneTimeProducts: [{ packageName, productId: 'coins_100' }],
          nextPageToken: 'page-2',
        });
      } else {
        reply(response, 200, { oneTimeProducts: [{ packageName, productId: 'remove_ads' }] });
      }
      return;
    }
    if (entry.method === 'POST' && entry.path === `${base}/pricing:convertRegionPrices`) {
      reply(response, 200, {
        convertedRegionPrices: {
          KR: {
            regionCode: 'KR',
            price: { currencyCode: 'KRW', units: '1500' },
            taxAmount: { currencyCode: 'KRW', units: '136' },
          },
        },
        convertedOtherRegionsPrice: {
          usdPrice: { currencyCode: 'USD', nanos: 990000000 },
          eurPrice: { currencyCode: 'EUR', nanos: 990000000 },
        },
        regionVersion: { version: '2025/03' },
      });
      return;
    }
    if (entry.method === 'PATCH' && entry.path === `${base}/onetimeproducts/coins_100`) {
      reply(response, 200, entry.body);
      return;
    }
    if (entry.method === 'POST'
      && entry.path === `${base}/oneTimeProducts/coins_100/purchaseOptions:batchUpdateStates`) {
      reply(response, 200, { oneTimeProducts: [] });
      return;
    }
    reply(response, 404, { error: { code: 404, message: `unexpected ${entry.method} ${entry.path}` } });
  })().catch((error: unknown) => {
    reply(response, 500, { error: { code: 500, message: String(error) } });
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');

try {
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const port = createMockProductCatalog('mock-play-token', `http://127.0.0.1:${address.port}/`);

  const products = await port.listOneTimeProducts(packageName);
  assert.deepEqual(
    products.map((product) => product.productId),
    ['coins_100', 'remove_ads'],
  );
  assert.equal(recorded[0]?.query.pageSize, '1000');
  assert.equal(recorded[1]?.query.pageToken, 'page-2', 'the adapter follows nextPageToken');

  const converted = await port.convertRegionPrices({
    packageName,
    price: { currencyCode: 'USD', units: '0', nanos: 990000000 },
    productTaxCategoryCode: 'game',
  });
  assert.equal(converted.regionVersion?.version, '2025/03');
  assert.deepEqual(recorded[2]?.body, {
    price: { currencyCode: 'USD', units: '0', nanos: 990000000 },
    productTaxCategoryCode: 'game',
  });

  const product = {
    packageName,
    productId: 'coins_100',
    listings: [{ languageCode: 'en-US', title: '100 coins', description: 'A pile.' }],
    purchaseOptions: [
      {
        purchaseOptionId: 'buy',
        buyOption: { legacyCompatible: true },
        regionalPricingAndAvailabilityConfigs: [
          {
            regionCode: 'KR',
            price: { currencyCode: 'KRW', units: '1500', nanos: 0 },
            availability: 'AVAILABLE',
          },
        ],
      },
    ],
  };
  await port.patchOneTimeProduct({
    packageName,
    productId: 'coins_100',
    product,
    updateMask: 'listings,purchaseOptions',
    allowMissing: true,
    regionsVersion: '2025/03',
  });
  const patch = recorded[3];
  assert.equal(patch?.method, 'PATCH');
  assert.deepEqual(patch?.query, {
    allowMissing: 'true',
    updateMask: 'listings,purchaseOptions',
    'regionsVersion.version': '2025/03',
  });
  assert.deepEqual(patch?.body, product);

  await port.activatePurchaseOption({
    packageName,
    productId: 'coins_100',
    purchaseOptionId: 'buy',
  });
  assert.deepEqual(recorded[4]?.body, {
    requests: [
      {
        activatePurchaseOptionRequest: {
          packageName,
          productId: 'coins_100',
          purchaseOptionId: 'buy',
        },
      },
    ],
  });
  assert.equal(recorded.length, 5);
} finally {
  server.close();
}

console.info('Google Play one-time product adapter tests passed.');
