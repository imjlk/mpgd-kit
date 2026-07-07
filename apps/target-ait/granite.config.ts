import { defineConfig, type AppsInTossWebConfig } from '@apps-in-toss/web-framework/config';

const config: AppsInTossWebConfig = {
  appName: readEnvString(process.env.MPGD_AIT_APP_NAME) ?? 'mpgd-kit',
  brand: {
    displayName: readEnvString(process.env.MPGD_AIT_DISPLAY_NAME) ?? 'MPGD Kit',
    primaryColor: readEnvString(process.env.MPGD_AIT_PRIMARY_COLOR) ?? '#101820',
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

function readEnvString(input: string | undefined): string | undefined {
  const trimmed = input?.trim();

  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
