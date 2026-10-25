import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readIosReleaseInfoPlist } from '../../packages/cli/src/native-shell-identity.js';
import {
  inspectIosInfoPlistStorePolicy,
  type NativeShellPolicyIssue,
} from '../../packages/cli/src/native-shell-store-policy.js';

/**
 * Reads the store-facing settings of the game-owned shell (never the stage)
 * before packaging. Warnings are printed for every profile; errors fail a
 * production build, where the shell would ship a binary the store rejects or
 * that crashes at launch.
 */
export function inspectNativeStorePolicy(input: {
  readonly platform: 'android' | 'ios';
  readonly shellApp: string;
}): readonly NativeShellPolicyIssue[] {
  if (input.platform === 'ios') {
    const project = join(input.shellApp, 'ios/App/App.xcodeproj/project.pbxproj');
    if (!existsSync(project)) {
      return [];
    }
    const plist = join(
      dirname(dirname(project)),
      readIosReleaseInfoPlist(readFileSync(project, 'utf8')),
    );
    if (!existsSync(plist)) {
      return [];
    }
    return inspectIosInfoPlistStorePolicy(readFileSync(plist, 'utf8'));
  }
  return [];
}

export function reportNativeStorePolicy(
  issues: readonly NativeShellPolicyIssue[],
  production: boolean,
  log: (message: string) => void = (message) => console.warn(message),
): void {
  for (const issue of issues) {
    log(`[native-store-policy] ${issue.level}: ${issue.message}`);
  }
  const errors = issues.filter((issue) => issue.level === 'error');
  if (production && errors.length > 0) {
    throw new Error(`Native shell is not ready for store release:\n${errors
      .map((issue) => `- ${issue.message}`).join('\n')}`);
  }
}
