import { expect, it, vi } from 'vitest';
vi.mock('@apps-in-toss/web-framework', ()=>({
  Review:{ request:Object.assign(async()=>{}, { isSupported:()=>false }) },
}));
import { createAitReviewProvider } from './reviews.js';
it('uses the current Review.request API and preserves opaque completion', async()=>{
  const request=vi.fn(async()=>{});
  let supported=true;
  const p=createAitReviewProvider({ request, isSupported:()=>supported });
  expect(await p.requestNative()).toEqual({ status:'requested' });
  supported=false;
  expect(p.getCapabilities().nativePrompt).toBe(false);
  expect(await p.requestNative()).toEqual({ status:'unavailable' });
  expect(request).toHaveBeenCalledOnce();
  expect(await p.openPage()).toEqual({ status:'unavailable' });
});
