import {
  createMpgdCloudflarePagesHostFetchHandler,
  type MpgdCloudflarePagesHostEnv,
} from '@mpgd/bridge/cloudflare-pages';

const fetchHandler = createMpgdCloudflarePagesHostFetchHandler();

export default {
  fetch(request, env, ctx) {
    return fetchHandler(request, env, ctx);
  },
} satisfies ExportedHandler<MpgdCloudflarePagesHostEnv>;
