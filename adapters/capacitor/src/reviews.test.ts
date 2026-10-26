import { expect,it,vi } from 'vitest';
import { createCapacitorReviewProvider } from './reviews.js';
it('requires the distribution store, matching native OS and installed plugin', async()=>{
  let native=true, installed=true, os='android';
  const host={ isNativePlatform:()=>native, isPluginAvailable:()=>installed, getPlatform:()=>os };
  const plugin={ requestReview:vi.fn(async()=>{}), openAppStore:vi.fn(async()=>{}) };
  const google=createCapacitorReviewProvider({ store:'google-play' }, host, plugin);
  expect(await google.requestNative()).toEqual({ status:'requested' });
  expect(await google.openPage()).toEqual({ status:'opened' });
  os='ios';
  expect(await google.requestNative()).toEqual({ status:'unavailable' });
  const apple=createCapacitorReviewProvider({ store:'apple-app-store' }, host, plugin);
  expect(apple.getCapabilities()).toMatchObject({ nativePrompt:true, reviewPage:false });
  const listing=createCapacitorReviewProvider(
    { store:'apple-app-store', appId:'123456789' },
    host,
    plugin,
  );
  expect(await listing.openPage()).toEqual({ status:'opened' });
  expect(plugin.openAppStore).toHaveBeenLastCalledWith({ appId:'123456789' });
  installed=false;
  expect(await apple.requestNative()).toEqual({ status:'unavailable' });
  installed=true;
  native=false;
  expect(await apple.requestNative()).toEqual({ status:'unavailable' });
});
