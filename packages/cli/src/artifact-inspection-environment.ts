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

/** Artifact inspectors need tool locations, never release-state or signing credentials. */
export function artifactInspectionEnvironment(
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
