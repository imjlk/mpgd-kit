import { defineConfig, type AppsInTossWebConfig } from '@apps-in-toss/web-framework/config';

const config: AppsInTossWebConfig = {
  appName: 'mpgd-kit',
  brand: {
    displayName: 'MPGD Kit',
    primaryColor: '#101820',
    icon: 'icon.png',
  },
  permissions: [],
  web: {
    host: 'localhost',
    port: 5173,
    commands: {
      dev: 'pnpm dev',
      build: 'pnpm build',
    },
  },
  webViewProps: {
    bounces: false,
    pullToRefreshEnabled: false,
    overScrollMode: 'never',
    allowsBackForwardNavigationGestures: false,
    allowsInlineMediaPlayback: true,
  },
};

export default defineConfig(config) as AppsInTossWebConfig;
