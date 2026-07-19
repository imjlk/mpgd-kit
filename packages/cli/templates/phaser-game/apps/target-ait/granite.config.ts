import { defineConfig, type AppsInTossWebConfig } from '@apps-in-toss/web-framework/config';

const config: AppsInTossWebConfig = {
  appName: readEnvString(process.env.MPGD_AIT_APP_NAME) ?? '__GAME_NAME__',
  brand: {
    displayName: readEnvString(process.env.MPGD_AIT_DISPLAY_NAME) ?? '__GAME_TITLE__',
    primaryColor: readEnvString(process.env.MPGD_AIT_PRIMARY_COLOR) ?? '#101820',
    icon: readEnvString(process.env.MPGD_AIT_BRAND_ICON_URL) ?? 'generated/console-icon.png',
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

const definedConfig: AppsInTossWebConfig = defineConfig(config);

export default definedConfig;

function readEnvString(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
