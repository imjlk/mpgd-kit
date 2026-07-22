import { defineConfig, type AppsInTossConfig } from '@apps-in-toss/web-framework/config';

const config: AppsInTossConfig = {
  appName: readEnvString(process.env.MPGD_AIT_APP_NAME) ?? 'mpgd-kit',
  brand: {
    primaryColor: readEnvString(process.env.MPGD_AIT_PRIMARY_COLOR) ?? '#101820',
  },
  permissions: [],
  webView: {
    bounces: false,
    pullToRefreshEnabled: false,
    overScrollMode: 'never',
    allowsBackForwardNavigationGestures: false,
    allowsInlineMediaPlayback: true,
  },
  webBundleDir: 'dist',
};

const definedConfig: AppsInTossConfig = defineConfig(config);

export default definedConfig;

function readEnvString(input: string | undefined): string | undefined {
  const trimmed = input?.trim();

  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
