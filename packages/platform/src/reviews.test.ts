import { describe, expect, it, vi } from 'vitest';
import { createReviewProvider, createUnsupportedReviewProvider } from './reviews.js';
import { createReviewController } from './reviews-runtime.js';
import type { StorageAdapter } from './index.js';

function fixture() {
  let data: unknown;
  let clock = 10_000;
  const request = vi.fn(async () => {});
  const observations: string[] = [];
  const storage: StorageAdapter = {
    load: vi.fn(async () => data === undefined ? null : { value: data }),
    save: vi.fn(async ({ value }) => {
      data = value;
    }),
  };
  const provider = createReviewProvider({ providerId: 'test-store', requestNative: request });
  const make = () => createReviewController({
    provider,
    storage,
    scope: 'test:android',
    policy: {
      minimumVisits: 2,
      minimumCompletedPlays: 3,
      cooldownMs: 1000,
    },
    now: () => clock,
    onObservation: (event) => observations.push(event),
  });
  return {
    make,
    storage,
    provider,
    request,
    observations,
    setData: (value: unknown) => {
      data = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
async function eligible(f: ReturnType<typeof fixture>) {
  const first = f.make();
  await first.ready;
  await Promise.all(['a','b','c','c'].map((id) => first.completedPlay(id)));
  expect(await first.consider(() => true)).toEqual({ status: 'skipped' });
  first.dispose();
  const second = f.make();
  await second.ready;
  return second;
}
describe('review provider and local courtesy policy', () => {
  it('supports an unknown future provider without changing the platform roster', async () => {
    const p = createReviewProvider({ providerId: 'future.store', openPage: async () => true });
    expect(p.getCapabilities()).toEqual({
      providerId:'future.store',
      nativePrompt:false,
      reviewPage:true,
    });
    expect(await p.requestNative()).toEqual({ status:'unavailable' });
    expect(await p.openPage()).toEqual({ status:'opened' });
  });
  it('never interprets a resolved native API as a shown or submitted review', async () => {
    const p = createReviewProvider({ providerId:'toss', requestNative:async()=>{} });
    expect(await p.requestNative()).toEqual({ status:'requested' });
    expect(await p.openPage()).toEqual({ status:'unavailable' });
  });
  it('isolates host and diagnostics errors', async () => {
    const p = createReviewProvider({
      providerId:'future',
      isAvailable:()=>{
        throw new Error('secret');
      },
    });
    expect(p.getCapabilities().nativePrompt).toBe(false);
    const fail = createReviewProvider({
      providerId:'future',
      requestNative:async()=>{
        throw new Error('secret');
      },
    });
    expect(await fail.requestNative()).toEqual({ status:'failed' });
  });
  it('makes no storage calls on an unsupported host', async () => {
    const f=fixture();
    const c=createReviewController({
      provider:createUnsupportedReviewProvider('reddit'),
      storage:f.storage,
      scope:'test',
      policy:{ minimumVisits:1, minimumCompletedPlays:1, cooldownMs:1000 },
    });
    await c.ready;
    await c.completedPlay('a');
    await c.consider(()=>true);
    expect(f.storage.load).not.toHaveBeenCalled();
    expect(f.storage.save).not.toHaveBeenCalled();
  });
  it('does not overwrite unloaded state when availability changes after construction', async () => {
    const f = fixture();
    let supported = false;
    const provider = createReviewProvider({
      providerId: 'late-store',
      isAvailable: () => supported,
      requestNative: f.request,
    });
    const controller = createReviewController({
      provider,
      storage: f.storage,
      scope: 'late',
      policy: { minimumVisits: 1, minimumCompletedPlays: 1, cooldownMs: 1000 },
    });
    await controller.ready;
    supported = true;
    await controller.completedPlay('a');
    expect(await controller.consider(() => true)).toEqual({ status: 'skipped' });
    expect(f.storage.save).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('counts one result once and requests once per runtime after enough separate visits', async () => {
    const f=fixture();
    const c=await eligible(f);
    expect(await Promise.all([c.consider(()=>true),c.consider(()=>true)])).toEqual([
      { status:'requested' },
      { status:'skipped' },
    ]);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.observations).toEqual(['request', 'requested']);
    const third=f.make();
    await third.ready;
    expect(await third.consider(()=>true)).toEqual({ status:'skipped' });
    f.advance(1001);
    expect(await third.consider(()=>true)).toEqual({ status:'requested' });
  });
  it('fails closed for unavailable or corrupt persistent state', async () => {
    for (const value of [{ version:2 }, { version:1,visits:100,plays:100,lastRequestAt:'bad' }]) {
      const f=fixture();
      f.setData(value);
      const c=f.make();
      await c.ready;
      await c.completedPlay('a');
      expect(await c.consider(()=>true)).toEqual({ status:'skipped' });
      expect(f.request).not.toHaveBeenCalled();
    }
    const f=fixture();
    const c=await eligible(f);
    vi.mocked(f.storage.save).mockRejectedValueOnce(new Error('disk'));
    expect(await c.consider(()=>true)).toEqual({ status:'skipped' });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('rechecks route safety after persistence and suppresses a disposed runtime', async () => {
    const f=fixture();
    const c=await eligible(f);
    let safe=true;
    vi.mocked(f.storage.save).mockImplementationOnce(async()=>{
      safe=false;
    });
    expect(await c.consider(()=>safe)).toEqual({ status:'skipped' });
    expect(f.request).not.toHaveBeenCalled();
    const other=fixture();
    const disposed=await eligible(other);
    disposed.dispose();
    expect(await disposed.consider(()=>true)).toEqual({ status:'skipped' });
  });
  it('keeps recording plays if the native host never resolves its request', async () => {
    const f=fixture();
    const c=await eligible(f);
    let release=()=>{};
    f.request.mockImplementationOnce(
      ()=>new Promise<void>((resolve)=>{
        release=resolve;
      }),
    );
    const pending=c.consider(()=>true);
    await vi.waitFor(()=>expect(f.request).toHaveBeenCalledOnce());
    await c.completedPlay('fourth');
    expect(vi.mocked(f.storage.save).mock.lastCall?.[0].value).toMatchObject({ plays:4 });
    release();
    expect(await pending).toEqual({ status:'requested' });
  });
  it('does not reopen the prompt after clock rollback', async () => {
    const f=fixture();
    const c=await eligible(f);
    await c.consider(()=>true);
    f.advance(-5000);
    const next=f.make();
    await next.ready;
    expect(await next.consider(()=>true)).toEqual({ status:'skipped' });
  });
});
