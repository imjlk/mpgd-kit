const allowedInspectionEnvironmentNames = [
  'PATH',
  'Path',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'JAVA_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'DEVELOPER_DIR',
  'SDKROOT',
  'SystemRoot',
  'windir',
  'PATHEXT',
  'USERPROFILE',
] as const;

/** Keep signing and publishing secrets out of native artifact inspection tools. */
export function nativeInspectionEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowedInspectionEnvironmentNames) {
    const value = source[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}
