import { expect,it,vi } from 'vitest';
import {
  createMicrosoftReviewProvider,
  createOneStoreReviewProvider,
  createReviewPageProvider,
  createVerse8ReviewProvider,
} from './reviews.js';
it('leaves ONE store and Verse8 unsupported without an approved game listing', async()=>{
  for(const p of [createOneStoreReviewProvider(),createVerse8ReviewProvider()]){
    expect(p.getCapabilities()).toMatchObject({ nativePrompt:false, reviewPage:false });
    expect(await p.requestNative()).toEqual({ status:'unavailable' });
  }
});
it('only opens explicit trusted HTTPS destinations, never auto-falling back', async()=>{
  const open=vi.fn(()=>true);
  const p=createReviewPageProvider({
    providerId:'custom',
    url:'https://games.example/game/reviews',
    allowedOrigins:['https://games.example'],
    open,
  });
  await p.requestNative();
  expect(open).not.toHaveBeenCalled();
  expect(await p.openPage()).toEqual({ status:'opened' });
  for(const url of ['javascript:alert(1)','https://games.example.evil.test/a','https://user:pass@games.example/a']){
    expect(()=>createReviewPageProvider({ providerId:'custom',url,allowedOrigins:['https://games.example'],open })).toThrow();
  }
});
it('builds only a registered Microsoft product review protocol link', async()=>{
  const open=vi.fn(()=>true);
  const p=createMicrosoftReviewProvider({ productId:'9MV9WWSBMB0P', open, isAvailable:()=>true });
  expect(p.getCapabilities()).toMatchObject({ nativePrompt:false, reviewPage:true });
  await p.openPage();
  expect(open).toHaveBeenCalledWith('ms-windows-store://review/?ProductId=9MV9WWSBMB0P');
  expect(()=>createMicrosoftReviewProvider({ productId:'bad?url=1',open,isAvailable:()=>true })).toThrow();
});
