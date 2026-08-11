import { defineConfig, type AppsInTossConfig } from '@apps-in-toss/web-framework/config';

const navigationBar = readNavigationBar(process.env.MPGD_AIT_NAVIGATION_BAR);

const config: AppsInTossConfig = {
  appName: readEnvString(process.env.MPGD_AIT_APP_NAME) ?? '__GAME_NAME__',
  brand: {
    primaryColor: readEnvString(process.env.MPGD_AIT_PRIMARY_COLOR) ?? '#101820',
  },
  permissions: [],
  ...(navigationBar === undefined ? {} : { navigationBar }),
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

function readNavigationBar(
  input: string | undefined,
): AppsInTossConfig['navigationBar'] | undefined {
  const encoded = readEnvString(input);
  return encoded === undefined
    ? undefined
    : JSON.parse(encoded) as AppsInTossConfig['navigationBar'];
}
