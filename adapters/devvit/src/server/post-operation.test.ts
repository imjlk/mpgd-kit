import { describe, expect, it, vi } from 'vitest';

import {
  createDevvitPostOperationCoordinator,
  createDevvitPostOperationKey,
  defineDevvitPostOperation,
  DevvitPostOperationStateError,
  DevvitPostOperationValidationError,
  type DevvitCanonicalPostData,
  type DevvitDurableOperationStore,
  type DevvitJsonObject,
  type DevvitPostOperationDescriptorInput,
  type DevvitPostPublishInput,
} from './post-operation';

type TestPayload = DevvitJsonObject & {
  readonly alpha: string;
  readonly zeta: number;
};

type TestLaunchParams = DevvitJsonObject & {
  readonly alpha: string;
  readonly zeta: string;
};

const definition = defineDevvitPostOperation<TestPayload, TestLaunchParams>({
  operationType: 'scheduled-content',
  parsePayload: (input) => parseExactStringNumberObject(input, 'payload'),
  parseLaunchParams: (input) => parseExactStringObject(input, 'launch params'),
});

describe('durable Devvit post operation coordinator', () => {
  it('publishes the canonical envelope once and returns the durable result on retry', async () => {
    const fixture = createFixture();
    const publish = vi.fn(async (
      input: DevvitPostPublishInput<TestPayload, TestLaunchParams>,
    ) => ({ postId: 't3_first' }));

    const first = await fixture.coordinator.execute({ ...baseDescriptor(), publish });
    const retry = await fixture.coordinator.execute({ ...baseDescriptor(), publish });

    expect(first).toMatchObject({
      status: 'created',
      operationId: 'operation-20260712',
      postId: 't3_first',
    });
    expect(retry).toMatchObject({ status: 'existing', postId: 't3_first' });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toEqual({
      scope: { appScope: 'app-alpha', subredditId: 't5_alpha' },
      operationId: 'operation-20260712',
      postData: expectedPostData(),
    });
    expect(fixture.store.recordPhases()).toEqual(['published']);
  });

  it('can create and publish a new operation with a one-attempt store budget', async () => {
    const fixture = createFixture({ storeAttempts: 1 });

    await expect(fixture.coordinator.execute({
      ...baseDescriptor(),
      publish: async () => ({ postId: 't3_singlebudget' }),
    })).resolves.toMatchObject({ status: 'created', postId: 't3_singlebudget' });
  });

  it('allows only one submitter for concurrent executions', async () => {
    const fixture = createFixture();
    const publish = vi.fn(async () => ({ postId: 't3_concurrent' }));

    const results = await Promise.all([
      fixture.coordinator.execute({ ...baseDescriptor(), publish }),
      fixture.coordinator.execute({ ...baseDescriptor(), publish }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'created',
      'reconciliation-required',
    ]);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('rejects operation reuse with a different descriptor without publishing again', async () => {
    const fixture = createFixture();
    const publish = vi.fn(async () => ({ postId: 't3_original' }));

    await fixture.coordinator.execute({ ...baseDescriptor(), publish });
    const conflict = await fixture.coordinator.execute({
      ...baseDescriptor(),
      payload: { alpha: 'changed', zeta: 7 },
      publish,
    });

    expect(conflict).toMatchObject({
      status: 'conflict',
      reason: 'descriptor-mismatch',
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it('recovers a prepared record after the process exits before claiming an attempt', async () => {
    const fixture = createFixture();
    const publish = vi.fn(async () => ({ postId: 't3_prepared' }));
    fixture.store.throwAfterCreate = true;

    await expect(
      fixture.coordinator.execute({ ...baseDescriptor(), publish }),
    ).rejects.toThrow('process exited after prepared write');
    expect(fixture.store.recordPhases()).toEqual(['prepared']);
    expect(publish).not.toHaveBeenCalled();

    await expect(
      fixture.coordinator.execute({ ...baseDescriptor(), publish }),
    ).resolves.toMatchObject({ status: 'created', postId: 't3_prepared' });
    expect(publish).toHaveBeenCalledOnce();
  });

  it('fails closed when the attempted CAS commits but its response is lost', async () => {
    const fixture = createFixture();
    const publish = vi.fn(async () => ({ postId: 't3_must_not_publish' }));
    fixture.store.throwAfterAttemptedCas = true;

    await expect(
      fixture.coordinator.execute({ ...baseDescriptor(), publish }),
    ).rejects.toThrow('process exited after attempted write');
    expect(fixture.store.recordPhases()).toEqual(['attempted']);
    expect(publish).not.toHaveBeenCalled();

    await expect(
      fixture.coordinator.execute({ ...baseDescriptor(), publish }),
    ).resolves.toMatchObject({
      status: 'reconciliation-required',
      reason: 'submission-attempted',
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('never resubmits a thrown submission attempt', async () => {
    const fixture = createFixture();
    const publish = vi.fn(async () => {
      throw new Error('submission outcome is unknown');
    });

    await expect(
      fixture.coordinator.execute({ ...baseDescriptor(), publish }),
    ).resolves.toMatchObject({
      status: 'reconciliation-required',
      reason: 'submit-outcome-unknown',
    });
    await expect(
      fixture.coordinator.execute({ ...baseDescriptor(), publish }),
    ).resolves.toMatchObject({
      status: 'reconciliation-required',
      reason: 'submission-attempted',
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it('recovers an accepted post whose submission response was lost', async () => {
    const fixture = createFixture();
    let accepted: DevvitCanonicalPostData<TestPayload, TestLaunchParams> | undefined;
    const publish = vi.fn(async (
      input: DevvitPostPublishInput<TestPayload, TestLaunchParams>,
    ) => {
      accepted = input.postData;
      throw new Error('response lost after acceptance');
    });

    await fixture.coordinator.execute({ ...baseDescriptor(), publish });
    const recovered = await fixture.coordinator.reconcile({
      ...baseDescriptor(),
      findCandidates: async () => [
        { postId: 't3_legacy', postData: { legacy: true } },
        { postId: 't3_recovered', postData: accepted },
      ],
    });
    const retry = await fixture.coordinator.execute({ ...baseDescriptor(), publish });

    expect(recovered).toMatchObject({ status: 'recovered', postId: 't3_recovered' });
    expect(retry).toMatchObject({ status: 'existing', postId: 't3_recovered' });
    expect(publish).toHaveBeenCalledOnce();
  });

  it('does not let a publish callback mutate canonical durable post data', async () => {
    const fixture = createFixture();

    await expect(fixture.coordinator.execute({
      ...baseDescriptor(),
      publish: async (input) => {
        const mutable = input.postData as unknown as { payload: { alpha: string } };
        expect(Object.isFrozen(input.postData)).toBe(true);
        expect(Object.isFrozen(input.postData.payload)).toBe(true);
        expect(() => {
          mutable.payload.alpha = 'tampered';
        }).toThrow(TypeError);
        return { postId: 't3_immutable' };
      },
    })).resolves.toMatchObject({ status: 'created', postId: 't3_immutable' });
    await expect(fixture.coordinator.read(baseDescriptor())).resolves.toMatchObject({
      status: 'existing',
      postData: expectedPostData(),
    });
  });

  it('survives a published-state write whose acknowledgement is lost', async () => {
    const fixture = createFixture();
    const publish = vi.fn(async () => ({ postId: 't3_receipt' }));
    fixture.store.throwAfterPublishedCas = true;

    await expect(
      fixture.coordinator.execute({ ...baseDescriptor(), publish }),
    ).resolves.toMatchObject({
      status: 'reconciliation-required',
      reason: 'receipt-write-failed',
    });
    expect(fixture.store.recordPhases()).toEqual(['published']);

    await expect(fixture.coordinator.read(baseDescriptor())).resolves.toMatchObject({
      status: 'existing',
      postId: 't3_receipt',
    });
    await fixture.coordinator.execute({ ...baseDescriptor(), publish });
    expect(publish).toHaveBeenCalledOnce();
  });

  it('keeps zero matches pending and makes multiple exact matches terminal', async () => {
    const fixture = createFixture();
    let attemptedPostData: DevvitCanonicalPostData<TestPayload, TestLaunchParams> | undefined;

    await fixture.coordinator.execute({
      ...baseDescriptor(),
      publish: async (input) => {
        attemptedPostData = input.postData;
        throw new Error('unknown');
      },
    });

    await expect(fixture.coordinator.reconcile({
      ...baseDescriptor(),
      findCandidates: async () => [],
    })).resolves.toMatchObject({
      status: 'reconciliation-required',
      reason: 'match-not-found',
    });

    const terminal = await fixture.coordinator.reconcile({
      ...baseDescriptor(),
      findCandidates: async () => [
        { postId: 't3_zeta', postData: attemptedPostData },
        { postId: 't3_alpha', postData: attemptedPostData },
      ],
    });

    expect(terminal).toMatchObject({
      status: 'terminal-unresolved',
      reason: 'multiple-exact-matches',
      postIds: ['t3_alpha', 't3_zeta'],
    });
    await expect(fixture.coordinator.reconcile({
      ...baseDescriptor(),
      findCandidates: vi.fn(),
    })).resolves.toEqual(terminal);
  });

  it('serializes reconciliation with an expiring owned lease and CAS convergence', async () => {
    const fixture = createFixture({ leaseTtlMs: 10 });
    let attemptedPostData: DevvitCanonicalPostData<TestPayload, TestLaunchParams> | undefined;

    await fixture.coordinator.execute({
      ...baseDescriptor(),
      publish: async (input) => {
        attemptedPostData = input.postData;
        throw new Error('unknown');
      },
    });

    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const candidate = { postId: 't3_converged', postData: attemptedPostData };
    const first = fixture.coordinator.reconcile({
      ...baseDescriptor(),
      findCandidates: async () => {
        firstStarted.resolve(undefined);
        await firstGate.promise;
        return [candidate];
      },
    });

    await firstStarted.promise;
    await expect(fixture.coordinator.reconcile({
      ...baseDescriptor(),
      findCandidates: vi.fn(),
    })).resolves.toMatchObject({
      status: 'busy',
      reason: 'reconciliation-lease-held',
    });

    fixture.clock.advance(11);
    const second = fixture.coordinator.reconcile({
      ...baseDescriptor(),
      findCandidates: async () => {
        secondStarted.resolve(undefined);
        await secondGate.promise;
        return [candidate];
      },
    });
    await secondStarted.promise;

    firstGate.resolve(undefined);
    await expect(first).resolves.toMatchObject({ status: 'recovered', postId: 't3_converged' });
    expect(fixture.store.activeLeaseTokens()).toEqual(['token-4']);

    secondGate.resolve(undefined);
    await expect(second).resolves.toMatchObject({ status: 'recovered', postId: 't3_converged' });
    expect(fixture.store.activeLeaseTokens()).toEqual([]);
    expect(fixture.store.recordPhases()).toEqual(['published']);
  });

  it('keeps multiple observed matches terminal when a submit receipt wins the first CAS', async () => {
    const fixture = createFixture({ storeAttempts: 1 });
    const publishStarted = deferred<void>();
    const releasePublish = deferred<void>();
    let postData: DevvitCanonicalPostData<TestPayload, TestLaunchParams> | undefined;
    const executing = fixture.coordinator.execute({
      ...baseDescriptor(),
      publish: async (input) => {
        postData = input.postData;
        publishStarted.resolve(undefined);
        await releasePublish.promise;
        return { postId: 't3_receiptwinner' };
      },
    });
    await publishStarted.promise;

    const terminalCas = fixture.store.blockNextTerminalCas();
    const reconciling = fixture.coordinator.reconcile({
      ...baseDescriptor(),
      findCandidates: async () => [
        { postId: 't3_matcha', postData },
        { postId: 't3_matchb', postData },
      ],
    });
    await terminalCas.started.promise;

    releasePublish.resolve(undefined);
    await expect(executing).resolves.toMatchObject({
      status: 'created',
      postId: 't3_receiptwinner',
    });
    terminalCas.release.resolve(undefined);
    await expect(reconciling).resolves.toMatchObject({
      status: 'terminal-unresolved',
      reason: 'multiple-exact-matches',
      postIds: ['t3_matcha', 't3_matchb', 't3_receiptwinner'],
    });
    await expect(fixture.coordinator.read(baseDescriptor())).resolves.toMatchObject({
      status: 'terminal-unresolved',
    });
  });

  it('rejects invalid stored state without invoking external callbacks', async () => {
    const fixture = createFixture();
    const key = operationKey();
    fixture.store.values.set(key, '{not-json');
    const publish = vi.fn();
    const findCandidates = vi.fn();

    await expect(fixture.coordinator.read(baseDescriptor())).rejects.toBeInstanceOf(
      DevvitPostOperationStateError,
    );
    await expect(
      fixture.coordinator.execute({ ...baseDescriptor(), publish }),
    ).rejects.toBeInstanceOf(DevvitPostOperationStateError);
    await expect(
      fixture.coordinator.reconcile({ ...baseDescriptor(), findCandidates }),
    ).rejects.toBeInstanceOf(DevvitPostOperationStateError);
    expect(publish).not.toHaveBeenCalled();
    expect(findCandidates).not.toHaveBeenCalled();
  });

  it('rejects invalid inputs and malformed launch metadata before durable or API effects', async () => {
    const fixture = createFixture();
    const publish = vi.fn();

    await expect(fixture.coordinator.execute({
      ...baseDescriptor(),
      launch: { entry: '../unsafe', params: { alpha: 'a', zeta: 'z' } },
      publish,
    })).rejects.toBeInstanceOf(DevvitPostOperationValidationError);
    await expect(fixture.coordinator.execute({
      ...baseDescriptor(),
      launch: { entry: 'play/../../admin', params: { alpha: 'a', zeta: 'z' } },
      publish,
    })).rejects.toBeInstanceOf(DevvitPostOperationValidationError);
    await expect(fixture.coordinator.execute({
      ...baseDescriptor({ appScope: 'app-alpha', subredditId: 'alpha' }),
      publish,
    })).rejects.toBeInstanceOf(DevvitPostOperationValidationError);
    await expect(fixture.coordinator.execute({
      ...baseDescriptor(),
      launch: {
        entry: 'challenge',
        params: { alpha: 'a', zeta: 7 } as unknown as TestLaunchParams,
      },
      publish,
    })).rejects.toBeInstanceOf(DevvitPostOperationValidationError);
    await expect(fixture.coordinator.execute({
      ...baseDescriptor(),
      payload: { alpha: 'a', zeta: Number.NaN },
      publish,
    })).rejects.toBeInstanceOf(DevvitPostOperationValidationError);

    expect(fixture.store.values.size).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects definition parsers that return arrays or primitives', async () => {
    for (const parsed of [[], 'not-an-object'] as const) {
      const store = new MemoryDurableOperationStore(() => 1);
      const unsafeDefinition = defineDevvitPostOperation<TestPayload, TestLaunchParams>({
        operationType: 'unsafe-parser',
        parsePayload: () => parsed as unknown as TestPayload,
        parseLaunchParams: definition.parseLaunchParams,
      });
      const coordinator = createDevvitPostOperationCoordinator({
        definition: unsafeDefinition,
        store,
        now: () => 1,
        createToken: () => 'token',
      });

      await expect(coordinator.execute({
        ...baseDescriptor(),
        publish: vi.fn(),
      })).rejects.toBeInstanceOf(DevvitPostOperationValidationError);
      expect(store.values.size).toBe(0);
    }
  });

  it('rejects malformed candidate launch metadata and preserves the attempt fence', async () => {
    const fixture = createFixture();
    let attemptedPostData: DevvitCanonicalPostData<TestPayload, TestLaunchParams> | undefined;

    await fixture.coordinator.execute({
      ...baseDescriptor(),
      publish: async (input) => {
        attemptedPostData = input.postData;
        throw new Error('unknown');
      },
    });
    const malformed = structuredClone(attemptedPostData) as unknown as {
      launch: { schemaVersion: number };
    };
    malformed.launch.schemaVersion = 2;

    await expect(fixture.coordinator.reconcile({
      ...baseDescriptor(),
      findCandidates: async () => [{ postId: 't3_invalid', postData: malformed }],
    })).resolves.toMatchObject({
      status: 'reconciliation-required',
      reason: 'invalid-reconciliation-candidate',
    });
    expect(fixture.store.recordPhases()).toEqual(['attempted']);
  });

  it('uses canonical JSON regardless of input key order', async () => {
    const fixture = createFixture();
    const publish = vi.fn(async () => ({ postId: 't3_canonical' }));
    await fixture.coordinator.execute({ ...baseDescriptor(), publish });

    const reordered = {
      ...baseDescriptor(),
      payload: { zeta: 7, alpha: 'payload-alpha' },
      launch: {
        entry: 'challenge',
        params: { zeta: 'launch-zeta', alpha: 'launch-alpha' },
      },
    } satisfies DevvitPostOperationDescriptorInput<TestPayload, TestLaunchParams>;
    await expect(fixture.coordinator.execute({ ...reordered, publish })).resolves.toMatchObject({
      status: 'existing',
      postId: 't3_canonical',
    });

    const raw = fixture.store.values.get(operationKey());
    expect(raw).toBeDefined();
    expect(raw?.indexOf('"alpha":"payload-alpha"')).toBeLessThan(
      raw?.indexOf('"zeta":7') ?? -1,
    );
    expect(publish).toHaveBeenCalledOnce();
  });

  it('isolates collision-prone operation identities by app and subreddit scope', async () => {
    const fixture = createFixture();
    const publish = vi.fn(async () => ({ postId: `t3_scope${publish.mock.calls.length}` }));
    const descriptors = [
      baseDescriptor({ appScope: 'a:b', subredditId: 't5_c' }),
      baseDescriptor({ appScope: 'a', subredditId: 't5_bc' }),
      baseDescriptor({ appScope: 'a:b', subredditId: 't5_d' }),
    ];

    const keys = descriptors.map((descriptor) => createDevvitPostOperationKey({
      scope: descriptor.scope,
      operationType: definition.operationType,
      operationId: descriptor.operationId,
    }));
    expect(new Set(keys).size).toBe(keys.length);

    for (const descriptor of descriptors) {
      await fixture.coordinator.execute({ ...descriptor, publish });
    }

    expect(publish).toHaveBeenCalledTimes(3);
    expect(fixture.store.recordPhases()).toEqual(['published', 'published', 'published']);
  });
});

function baseDescriptor(
  scope: { readonly appScope: string; readonly subredditId: string } = {
    appScope: 'app-alpha',
    subredditId: 't5_alpha',
  },
): DevvitPostOperationDescriptorInput<TestPayload, TestLaunchParams> {
  return {
    scope,
    operationId: 'operation-20260712',
    payload: { alpha: 'payload-alpha', zeta: 7 },
    launch: {
      entry: 'challenge',
      params: { alpha: 'launch-alpha', zeta: 'launch-zeta' },
    },
  };
}

function expectedPostData(): DevvitCanonicalPostData<TestPayload, TestLaunchParams> {
  return {
    mpgd: {
      schemaVersion: 1,
      appScope: 'app-alpha',
      subredditId: 't5_alpha',
      operationType: 'scheduled-content',
      operationId: 'operation-20260712',
    },
    launch: {
      schemaVersion: 1,
      entry: 'challenge',
      params: { alpha: 'launch-alpha', zeta: 'launch-zeta' },
    },
    payload: { alpha: 'payload-alpha', zeta: 7 },
  };
}

function operationKey(): string {
  const descriptor = baseDescriptor();
  return createDevvitPostOperationKey({
    scope: descriptor.scope,
    operationType: definition.operationType,
    operationId: descriptor.operationId,
  });
}

function parseExactStringNumberObject(input: unknown, label: string): TestPayload {
  const record = requireExactRecord(input, ['alpha', 'zeta'], label);
  if (typeof record.alpha !== 'string' || typeof record.zeta !== 'number') {
    throw new TypeError(`${label} is invalid`);
  }
  return { ...record } as TestPayload;
}

function parseExactStringObject(input: unknown, label: string): TestLaunchParams {
  const record = requireExactRecord(input, ['alpha', 'zeta'], label);
  if (typeof record.alpha !== 'string' || typeof record.zeta !== 'string') {
    throw new TypeError(`${label} is invalid`);
  }
  return { ...record } as TestLaunchParams;
}

function requireExactRecord(
  input: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object`);
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) {
    throw new TypeError(`${label} has unexpected fields`);
  }
  return record;
}

function createFixture(options: {
  readonly leaseTtlMs?: number;
  readonly storeAttempts?: number;
} = {}): {
  readonly clock: TestClock;
  readonly store: MemoryDurableOperationStore;
  readonly coordinator: ReturnType<typeof createDevvitPostOperationCoordinator<
    TestPayload,
    TestLaunchParams
  >>;
} {
  const clock = new TestClock();
  const store = new MemoryDurableOperationStore(() => clock.now);
  let token = 0;
  const coordinator = createDevvitPostOperationCoordinator({
    definition,
    store,
    now: () => clock.now,
    createToken: () => `token-${String(token += 1)}`,
    leaseTtlMs: options.leaseTtlMs ?? 1_000,
    ...(options.storeAttempts === undefined ? {} : { storeAttempts: options.storeAttempts }),
  });
  return { clock, store, coordinator };
}

class TestClock {
  now = Date.parse('2026-07-12T00:00:00.000Z');

  advance(milliseconds: number): void {
    this.now += milliseconds;
  }
}

class MemoryDurableOperationStore implements DevvitDurableOperationStore {
  readonly values = new Map<string, string>();
  readonly leases = new Map<string, { readonly token: string; readonly expiresAt: number }>();
  throwAfterCreate = false;
  throwAfterAttemptedCas = false;
  throwAfterPublishedCas = false;
  private terminalCasGate: {
    readonly started: ReturnType<typeof deferred<void>>;
    readonly release: ReturnType<typeof deferred<void>>;
  } | undefined;

  constructor(private readonly now: () => number) {}

  read(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  create(key: string, value: string): Promise<boolean> {
    if (this.values.has(key)) {
      return Promise.resolve(false);
    }
    this.values.set(key, value);
    if (this.throwAfterCreate) {
      this.throwAfterCreate = false;
      return Promise.reject(new Error('process exited after prepared write'));
    }
    return Promise.resolve(true);
  }

  async compareAndSet(key: string, expectedValue: string, nextValue: string): Promise<boolean> {
    const phase = storedPhase(nextValue);
    const gate = phase === 'terminal-unresolved' ? this.terminalCasGate : undefined;
    if (gate !== undefined) {
      this.terminalCasGate = undefined;
      gate.started.resolve(undefined);
      await gate.release.promise;
    }
    if (this.values.get(key) !== expectedValue) {
      return false;
    }
    this.values.set(key, nextValue);
    if (phase === 'attempted' && this.throwAfterAttemptedCas) {
      this.throwAfterAttemptedCas = false;
      throw new Error('process exited after attempted write');
    }
    if (phase === 'published' && this.throwAfterPublishedCas) {
      this.throwAfterPublishedCas = false;
      throw new Error('published write acknowledgement was lost');
    }
    return true;
  }

  createLease(key: string, token: string, expiresAt: Date): Promise<boolean> {
    const current = this.leases.get(key);
    if (current !== undefined && current.expiresAt > this.now()) {
      return Promise.resolve(false);
    }
    this.leases.set(key, { token, expiresAt: expiresAt.getTime() });
    return Promise.resolve(true);
  }

  releaseLease(key: string, token: string): Promise<void> {
    if (this.leases.get(key)?.token === token) {
      this.leases.delete(key);
    }
    return Promise.resolve();
  }

  recordPhases(): string[] {
    return [...this.values.values()].map(storedPhase).sort();
  }

  activeLeaseTokens(): string[] {
    return [...this.leases.values()]
      .filter((lease) => lease.expiresAt > this.now())
      .map((lease) => lease.token)
      .sort();
  }

  blockNextTerminalCas(): {
    readonly started: ReturnType<typeof deferred<void>>;
    readonly release: ReturnType<typeof deferred<void>>;
  } {
    const started = deferred<void>();
    const release = deferred<void>();
    this.terminalCasGate = { started, release };
    return { started, release };
  }
}

function storedPhase(value: string): string {
  return (JSON.parse(value) as { readonly phase: string }).phase;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
