import { describe, expect, it, vi } from 'vitest';

import type { StorageAdapter } from './index.js';
import {
  runStorageAdapterConformance,
  storageAdapterConformanceScenarios,
  type StorageAdapterConformanceFixture,
} from './storage-conformance.js';

describe('storage adapter conformance', () => {
  it('passes every scenario for an isolated fail-closed JSON provider', async () => {
    const createdScenarios: string[] = [];

    const report = await runStorageAdapterConformance({
      createFixture({ scenario }) {
        createdScenarios.push(scenario);
        return createFixture();
      },
    });

    expect(report.passedScenarios).toEqual(storageAdapterConformanceScenarios);
    expect(createdScenarios).toEqual(storageAdapterConformanceScenarios);
  });

  it('identifies adapters that retain the saved input reference', async () => {
    await expect(
      runStorageAdapterConformance({
        createFixture: () => createFixture({ cloneOnSave: false }),
      }),
    ).rejects.toThrow('Storage adapter conformance failed: mutation-isolation.');
  });

  it('identifies providers that report load failures as missing values', async () => {
    await expect(
      runStorageAdapterConformance({
        createFixture: () => createFixture({ swallowLoadFailure: true }),
      }),
    ).rejects.toThrow('Storage adapter conformance failed: load-failure-is-fail-closed.');
  });

  it('runs fixture cleanup after success and failure', async () => {
    const disposeAfterSuccess = vi.fn();
    await runStorageAdapterConformance({
      createFixture: () => ({ ...createFixture(), dispose: disposeAfterSuccess }),
    });
    expect(disposeAfterSuccess).toHaveBeenCalledTimes(storageAdapterConformanceScenarios.length);

    const disposeAfterFailure = vi.fn();
    await expect(
      runStorageAdapterConformance({
        createFixture: () => ({
          ...createFixture({ swallowLoadFailure: true }),
          dispose: disposeAfterFailure,
        }),
      }),
    ).rejects.toThrow('load-failure-is-fail-closed');
    expect(disposeAfterFailure).toHaveBeenCalledTimes(storageAdapterConformanceScenarios.length);
  });
});

function createFixture(options: {
  readonly cloneOnSave?: boolean;
  readonly swallowLoadFailure?: boolean;
} = {}): StorageAdapterConformanceFixture {
  const primary = createStorageArea(options);
  const isolated = createStorageArea(options);

  return {
    storage: primary.storage,
    isolatedStorage: isolated.storage,
    oversizedValue: 'x'.repeat(512),
    armNextSaveFailure: primary.armNextSaveFailure,
    armNextLoadFailure: primary.armNextLoadFailure,
  };
}

function createStorageArea(options: {
  readonly cloneOnSave?: boolean;
  readonly swallowLoadFailure?: boolean;
}): {
  readonly storage: StorageAdapter;
  readonly armNextSaveFailure: () => void;
  readonly armNextLoadFailure: () => void;
} {
  const values = new Map<string, unknown>();
  let failNextSave = false;
  let failNextLoad = false;

  return {
    storage: {
      async load({ key }) {
        if (failNextLoad) {
          failNextLoad = false;

          if (options.swallowLoadFailure === true) {
            return null;
          }

          throw new Error('simulated load failure');
        }

        const value = values.get(key);
        return value === undefined ? null : { value: clone(value) };
      },
      async save({ key, value }) {
        if (failNextSave) {
          failNextSave = false;
          throw new Error('simulated save failure');
        }

        if (JSON.stringify(value).length > 256) {
          throw new Error('simulated quota rejection');
        }

        values.set(key, options.cloneOnSave === false ? value : clone(value));
      },
    },
    armNextSaveFailure() {
      failNextSave = true;
    },
    armNextLoadFailure() {
      failNextLoad = true;
    },
  };
}

function clone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
