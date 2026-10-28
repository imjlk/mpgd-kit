import { describe, expect, it } from 'vitest';

import { createNativePurchasePresentation } from './purchase-presentation.js';

function nativePlugin(support: 'supported' | 'unimplemented' | 'failing' = 'supported') {
  const listeners = new Set<(event: unknown) => void>();
  let checks = 0;
  return {
    listeners,
    get checks() {
      return checks;
    },
    plugin: {
      async addListener(_eventName: 'purchasePresentation', listener: (event: unknown) => void) {
        listeners.add(listener);
        return {
          async remove() {
            listeners.delete(listener);
          },
        };
      },
      async getPresentationSupport() {
        checks += 1;
        if (support === 'supported') {
          return { purchasePresentation: 1 };
        }
        throw Object.assign(new Error(support), {
          code: support === 'unimplemented' ? 'UNIMPLEMENTED' : 'BRIDGE_BUSY',
        });
      },
    },
    emit(event: unknown) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

describe('createNativePurchasePresentation', () => {
  it('reports native facts once per call, with answers and events in any order', () => {
    const native = nativePlugin();
    const presentation = createNativePurchasePresentation(native.plugin);
    const facts: string[] = [];
    expect(presentation.followed()).toBe(false);
    presentation.purchasePresentation.subscribe((event) => {
      facts.push(`${event.presentationId}:${event.state}${event.reason === undefined ? '' : `:${event.reason}`}`);
    });
    expect(presentation.followed()).toBe(true);
    presentation.begin('a');
    native.emit({ presentationId: 'a', state: 'open' });
    presentation.answered('a', { status: 'pending', presentation: 'open' });
    native.emit({ presentationId: 'a', state: 'closed', reason: 'timeout' });
    native.emit({ presentationId: 'a', state: 'closed' });
    // `requested`: not an invented `open`, a pending verdict.
    presentation.begin('b');
    presentation.answered('b', { code: 'PLAY_BILLING_TIMEOUT', data: { presentation: 'requested' } });
    presentation.answered('b', { data: { presentation: 'requested' } });
    native.emit({ presentationId: 'b', state: 'open' });
    native.emit({ presentationId: 'b', state: 'closed', reason: 'disposed' });
    // An answer without the field: nothing observed, read as not-started.
    presentation.begin('c');
    presentation.answered('c', { status: 'cancelled' });
    native.emit({ presentationId: 'c', state: 'open' });
    native.emit({ presentationId: 'unknown-id', state: 'open' });
    expect(facts).toEqual(['a:open', 'a:closed:timeout', 'b:unknown', 'b:open', 'b:closed']);
  });

  it('remembers an UNIMPLEMENTED support check and asks again after another failure', async () => {
    const old = nativePlugin('unimplemented');
    const presentation = createNativePurchasePresentation(old.plugin);
    await expect(presentation.supported()).resolves.toBe(false);
    await expect(presentation.supported()).resolves.toBe(false);
    expect(old.checks).toBe(1);
    const flaky = nativePlugin('failing');
    const retried = createNativePurchasePresentation(flaky.plugin);
    await expect(retried.supported()).resolves.toBe(false);
    await expect(retried.supported()).resolves.toBe(false);
    expect(flaky.checks).toBe(2);
    await expect(createNativePurchasePresentation(nativePlugin().plugin).supported()).resolves.toBe(true);
  });
});
