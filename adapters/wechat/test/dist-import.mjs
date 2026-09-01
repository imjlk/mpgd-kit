import {
  createWechatMiniGameHost,
  createWechatPlatformGateway,
} from '@mpgd/adapter-wechat';

if (typeof createWechatMiniGameHost !== 'function' || typeof createWechatPlatformGateway !== 'function') {
  throw new Error('WeChat adapter dist exports are unavailable.');
}
