import { describe, expect, it } from 'vitest';

import { createCapacitorPlatformGateway } from './index.js';

const loadProtocol = 'mpgd.credentials.load.v1';

describe('Capacitor secure credential boundary', () => {
  it('uses dedicated credential methods without reading ordinary game storage', async () => {
    const values = new Map<string, string>();
    const calls: string[] = [];
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1.0.0', buildId: 'credentials-test',
      bridge: {
        async request(input) {
          calls.push(input.method);
          const payload = input.payload as { key: string; value?: string };
          if (input.method === 'credentials.load') {
            const value = values.get(payload.key);
            return { id: input.id, ok: true, data: value === undefined
              ? { __mpgdBridgeProtocol: loadProtocol, found: false }
              : { __mpgdBridgeProtocol: loadProtocol, found: true, value } };
          }
          if (input.method === 'credentials.save' && payload.value !== undefined) {
            values.set(payload.key, payload.value);
            return { id: input.id, ok: true, data: { saved: true } };
          }
          if (input.method === 'credentials.remove') {
            values.delete(payload.key);
            return { id: input.id, ok: true, data: { removed: true } };
          }
          throw new Error(`Unexpected bridge method: ${input.method}`);
        },
      },
    });
    const credentials = gateway.secureCredentials;
    expect(credentials).toBeDefined();
    if (credentials === undefined) {
      throw new Error('Missing secure credential adapter.');
    }
    await expect(credentials.load({ key: 'session.refresh' })).resolves.toBeNull();
    await credentials.save({ key: 'session.refresh', value: 'opaque-refresh-token' });
    await expect(credentials.load({ key: 'session.refresh' }))
      .resolves.toBe('opaque-refresh-token');
    await credentials.remove({ key: 'session.refresh' });
    await expect(credentials.load({ key: 'session.refresh' })).resolves.toBeNull();
    expect(calls).toEqual([
      'credentials.load', 'credentials.save', 'credentials.load',
      'credentials.remove', 'credentials.load',
    ]);
  });

  it('rejects malformed values and native failure without plaintext fallback', async () => {
    const calls: string[] = [];
    let malformed = true;
    const gateway = createCapacitorPlatformGateway({
      target: 'ios', appVersion: '1.0.0', buildId: 'credentials-test',
      bridge: {
        async request(input) {
          calls.push(input.method);
          if (malformed) {
            return { id: input.id, ok: true, data: {
              __mpgdBridgeProtocol: loadProtocol, found: true, value: 42,
            } };
          }
          return { id: input.id, ok: false, error: {
            code: 'NATIVE_CREDENTIAL_LOAD_FAILED', message: 'Secure store unavailable.',
            retryable: false,
          } };
        },
      },
    });
    const credentials = gateway.secureCredentials;
    expect(credentials).toBeDefined();
    if (credentials === undefined) {
      throw new Error('Missing secure credential adapter.');
    }
    await expect(credentials.load({ key: 'session.refresh' }))
      .rejects.toMatchObject({ code: 'NATIVE_CREDENTIAL_INVALID_RESPONSE' });
    malformed = false;
    await expect(credentials.load({ key: 'session.refresh' }))
      .rejects.toMatchObject({ code: 'NATIVE_CREDENTIAL_LOAD_FAILED' });
    await expect(credentials.save({ key: '../unsafe', value: 'secret' }))
      .rejects.toMatchObject({ code: 'NATIVE_CREDENTIAL_INVALID_KEY' });
    await expect(credentials.save({ key: 'session.refresh', value: '' }))
      .rejects.toMatchObject({ code: 'NATIVE_CREDENTIAL_INVALID_VALUE' });
    expect(calls).toEqual(['credentials.load', 'credentials.load']);
  });
});
