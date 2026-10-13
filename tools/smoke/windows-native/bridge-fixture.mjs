import {
  createMicrosoftStoreNativeBridgeClient,
  MicrosoftStoreNativeBridgeError,
} from '@mpgd/adapter-browser/microsoft-store-native';

// Bundled against the installed CLI consumer's adapter, exercising the public
// TS client and C# host together rather than duplicating response validation.
export async function startBridgeProbe(itemId) {
  const probe = { itemId, complete: false, passed: false, beforeDocumentLoad: document.readyState !== 'complete' };
  globalThis.__mpgdBridgeProbe = probe;
  const client = createMicrosoftStoreNativeBridgeClient({
    webView: globalThis.chrome.webview,
    timeoutMs: 10_000, signInTimeoutMs: 10_000, purchaseTimeoutMs: 10_000,
  });
  try {
    probe.stage = 'catalog';
    const catalog = await client.getDetails([itemId]);
    probe.stage = 'signIn';
    const session = await client.signIn();
    probe.stage = 'purchase.list';
    const list = await client.listPurchases();
    probe.stage = 'purchase.request';
    const buy = await client.requestPurchase(itemId);
    let rejected = false;
    try { await client.requestPurchase('other.coins'); }
    catch (error) {
      rejected = error instanceof MicrosoftStoreNativeBridgeError
        && error.code === 'NATIVE_OPERATION_FAILED' && error.message === 'PRODUCT_NOT_ALLOWED';
    }
    probe.catalog = catalog.length === 1 && catalog[0].itemId === itemId;
    probe.signIn = session.playerId === 'ci-fixture-player';
    probe.listPurchases = list.length === 1 && list[0].itemId === itemId;
    probe.requestPurchase = buy.status === 'succeeded' && buy.purchaseToken === itemId;
    probe.allowlist = rejected;
    probe.stage = 'load-complete';
    // Startup requests ran before load completion. Finish the slow image first
    // so the blocked-navigation check does not cancel unrelated image loading.
    if (document.readyState !== 'complete') {
      await new Promise(resolve => addEventListener('load', resolve, { once: true }));
    }
    location.href = 'https://blocked.example.invalid/';
    probe.stage = 'blocked-navigation';
    await new Promise(resolve => setTimeout(resolve, 200));
    const afterBlockedNavigation = await client.getDetails([itemId]);
    probe.blockedNavigationPreserved = location.origin === 'https://starter.mpgd.invalid'
      && afterBlockedNavigation[0]?.itemId === itemId;
    probe.passed = probe.catalog && probe.signIn && probe.listPurchases && probe.requestPurchase
      && probe.allowlist && probe.blockedNavigationPreserved;
    probe.stage = 'complete';
  } catch (error) {
    probe.errorCode = error?.code ?? error?.name ?? 'unknown';
  } finally {
    probe.complete = true;
    client.dispose();
  }
}
