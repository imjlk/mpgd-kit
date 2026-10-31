import { createGooglePlayPublisherClient } from './google-play-publisher-client.js';

const assert = {
  equal(actual: unknown, expected: unknown, message = 'Values differ'): void {
    if (actual !== expected) {
      throw new Error(message);
    }
  },
  deepEqual(actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('Values differ');
    }
  },
  async rejects(action: Promise<unknown>, expected: RegExp | ((error: unknown) => boolean)) {
    try {
      await action;
    } catch (error) {
      const matched = expected instanceof RegExp
        ? error instanceof Error && expected.test(error.message)
        : expected(error);
      if (matched) {
        return;
      }
      throw error;
    }
    throw new Error('Expected rejection');
  },
};

const calls: Array<{ url: string; init: RequestInit }> = [];
const controller = new AbortController();
const client = createGooglePlayPublisherClient({
  getAccessToken: (signal) => {
    assert.equal(signal, controller.signal);
    return 'secret-access-token';
  },
  fetch: async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (calls.length === 1) {
      return Response.json({ purchaseStateContext: { purchaseState: 'PURCHASED' } });
    }
    return new Response(null, { status: 204 });
  },
});

const input = {
  packageName: 'dev.mpgd.game',
  productId: 'coins/100',
  purchaseToken: 'sensitive/token+value',
  signal: controller.signal,
};
assert.deepEqual(await client.getProductPurchaseV2(input), {
  purchaseStateContext: { purchaseState: 'PURCHASED' },
});
await client.acknowledgeProductPurchase(input);
await client.consumeProductPurchase(input);

assert.deepEqual(calls.map(({ url, init }) => [init.method, url]), [
  [
    'GET',
    'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/dev.mpgd.game/purchases/productsv2/tokens/sensitive%2Ftoken%2Bvalue',
  ],
  [
    'POST',
    'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/dev.mpgd.game/purchases/products/coins%2F100/tokens/sensitive%2Ftoken%2Bvalue:acknowledge',
  ],
  [
    'POST',
    'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/dev.mpgd.game/purchases/products/coins%2F100/tokens/sensitive%2Ftoken%2Bvalue:consume',
  ],
]);
for (const { init } of calls) {
  assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer secret-access-token');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.signal, controller.signal);
}

const failed = createGooglePlayPublisherClient({
  getAccessToken: () => 'secret-access-token',
  fetch: async () => new Response('sensitive/token+value', { status: 403 }),
});
await assert.rejects(
  failed.getProductPurchaseV2(input),
  (error: unknown) => error instanceof Error
    && error.message === 'Google Play Publisher request failed (HTTP 403).',
);

// Workers only support manual redirects; a 3xx with a plausible purchase body must still fail.
const redirectInits: RequestInit[] = [];
const redirected = createGooglePlayPublisherClient({
  getAccessToken: () => 'secret-access-token',
  fetch: async (_url, init) => {
    redirectInits.push(init ?? {});
    return Response.json(
      { purchaseStateContext: { purchaseState: 'PURCHASED' } },
      { status: 302, headers: { Location: 'https://attacker.example/purchase' } },
    );
  },
});
await assert.rejects(
  redirected.getProductPurchaseV2(input),
  (error: unknown) => error instanceof Error
    && error.message === 'Google Play Publisher request failed (HTTP 302).',
);
await assert.rejects(redirected.acknowledgeProductPurchase(input), /HTTP 302/u);
assert.equal(redirectInits.length, 2);
assert.equal(
  redirectInits.every((init) => init.redirect === 'manual'),
  true,
);

const followedResponse = Response.json({ purchaseStateContext: { purchaseState: 'PURCHASED' } });
Object.defineProperty(followedResponse, 'redirected', { value: true });
const followed = createGooglePlayPublisherClient({
  getAccessToken: () => 'secret-access-token',
  fetch: async () => followedResponse,
});
await assert.rejects(followed.getProductPurchaseV2(input), /request failed \(HTTP 200\)/u);

const fetchFailure = createGooglePlayPublisherClient({
  getAccessToken: () => 'secret-access-token',
  fetch: async () => {
    throw new Error('sensitive/token+value');
  },
});
await assert.rejects(
  fetchFailure.getProductPurchaseV2(input),
  (error: unknown) => error instanceof Error
    && error.message === 'Google Play Publisher request failed.',
);

await assert.rejects(
  client.getProductPurchaseV2({ ...input, packageName: 'app\nmalformed' }),
  /path parameter is invalid/u,
);
await assert.rejects(
  client.getProductPurchaseV2({ ...input, purchaseToken: '..' }),
  /path parameter is invalid/u,
);
assert.equal(calls.length, 3, 'invalid input must not call the network');

const aborted = new AbortController();
aborted.abort();
const abortedClient = createGooglePlayPublisherClient({
  getAccessToken: () => 'secret-access-token',
  fetch: async () => {
    throw new Error('purchase token in fetch error');
  },
});
await assert.rejects(
  abortedClient.getProductPurchaseV2({ ...input, signal: aborted.signal }),
  (error: unknown) => error instanceof Error && error.name === 'AbortError'
    && !error.message.includes('purchase token'),
);

let cancelled = false;
const oversizedBody = new ReadableStream<Uint8Array>({
  pull(stream) {
    stream.enqueue(new Uint8Array(1024 * 1024 + 1));
  },
  cancel() {
    cancelled = true;
  },
});
const oversizedClient = createGooglePlayPublisherClient({
  getAccessToken: () => 'secret-access-token',
  fetch: async () => new Response(oversizedBody),
});
await assert.rejects(
  oversizedClient.getProductPurchaseV2(input),
  /returned invalid purchase JSON/u,
);
assert.equal(cancelled, true, 'oversized response body should be cancelled');

// A token source that ignores the signal is bounded by it anyway.
const stuckClient = createGooglePlayPublisherClient({
  getAccessToken: () => new Promise<string>(() => undefined),
  fetch: async () => {
    throw new Error('fetch must not run without a token');
  },
});
// A ref'd timer: AbortSignal.timeout's does not keep Node's event loop alive.
const stuckDeadline = new AbortController();
setTimeout(() => stuckDeadline.abort(), 50);
const stuckStarted = Date.now();
await assert.rejects(
  stuckClient.listVoidedPurchases({
    packageName: input.packageName,
    startTimeMillis: 1_761_000_000_000,
    endTimeMillis: 1_761_300_000_000,
    signal: stuckDeadline.signal,
  }),
  (error) => error instanceof DOMException && error.name === 'AbortError',
);
assert.equal(
  Date.now() - stuckStarted < 5_000,
  true,
  'a stuck token source answers at the deadline',
);
const abortedBefore = new AbortController();
abortedBefore.abort();
await assert.rejects(
  stuckClient.getProductPurchaseV2({ ...input, signal: abortedBefore.signal }),
  (error) => error instanceof DOMException && error.name === 'AbortError',
);
