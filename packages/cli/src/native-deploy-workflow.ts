import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  planNativeDeployment,
  readNativeDeployTargetProfile,
  type NativeDeployTarget,
} from './deploy-planning.js';
import { pinnedAscVersion } from './testflight-submission.js';

export interface InitializeNativeDeployWorkflowInput {
  readonly game: string;
  readonly profile: string;
  readonly releaseBranch: string;
  readonly targets?: readonly NativeDeployTarget[];
  readonly gameId?: string;
  readonly approvalEnvironment?: string;
}

const reservedWorkflowEnvironmentNames = new Set([
  'PATH',
  'HOME',
  'NPM_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'RUNNER_TEMP',
  'GITHUB_ENV',
  'SIGNING_B64',
  'SUBMISSION_B64',
  'PROFILE_B64',
  'GAME_PATH',
  'GAME_ID',
  'PROFILE',
  'TARGET',
  'RELEASE_ID',
  'RELEASE_KEY',
  'GAME_VERSION',
  'INITIAL_LEDGER',
  'ARTIFACT_RUN_ID',
  'MPGD_ASC_BINARY',
  'MPGD_IOS_PROVISIONING_PROFILE',
  'MPGD_ANDROID_UPLOAD_STORE_PASSWORD',
  'MPGD_ANDROID_UPLOAD_KEY_ALIAS',
  'MPGD_ANDROID_UPLOAD_KEY_PASSWORD',
  'MPGD_ANDROID_UPLOAD_CERT_SHA256',
  'MPGD_IOS_SIGNING_P12_PASSWORD',
  'MPGD_IOS_TEAM_ID',
  'MPGD_ASC_APP_ID',
  'MPGD_ASC_KEY_ID',
  'MPGD_ASC_ISSUER_ID',
  'MPGD_DEPENDENCY_INSTALL_ENV_NAMES',
  'MPGD_VERIFY_RELEASE_MANIFEST',
  'ASC_TELEMETRY_DISABLED',
]);

/** Write a game-owned, non-overwriting workflow that calls the installed CLI. */
export function initializeNativeDeployWorkflow(
  input: InitializeNativeDeployWorkflowInput,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(input.releaseBranch)
    || input.releaseBranch.includes('..') || input.releaseBranch.includes('//')
    || input.releaseBranch.endsWith('/')) {
    throw new Error('The native deployment release branch is invalid.');
  }
  const plan = planNativeDeployment({
    game: input.game,
    profile: input.profile,
    ...(input.targets === undefined ? {} : { targets: input.targets }),
  });
  const gameRoot = realpathSync(plan.gameRoot);
  let repositoryRoot: string;
  try {
    repositoryRoot = realpathSync(execFileSync('git', [
      '-C', gameRoot, 'rev-parse', '--show-toplevel',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    throw new Error(`The game must live inside a Git repository: ${gameRoot}`);
  }
  const relativeGame = relative(repositoryRoot, gameRoot).split(sep).join('/');
  if (relativeGame === '..' || relativeGame.startsWith('../')
    || isAbsolute(relativeGame) || !/^[A-Za-z0-9._/-]*$/u.test(relativeGame)) {
    throw new Error('The game must use a simple path inside its Git repository.');
  }
  const readableName = relativeGame === '' ? 'root' : relativeGame.replaceAll('/', '-');
  const digest = createHash('sha256').update(relativeGame).digest('hex').slice(0, 8);
  const slug = `${readableName.slice(0, 40)}-${digest}`.toLowerCase();
  const gameId = input.gameId ?? slug;
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(gameId)) {
    const reason = input.gameId === undefined
      ? 'The game directory must start with a letter or digit, or pass --game-id.'
      : 'The native deployment game ID is invalid.';
    throw new Error(reason);
  }
  const approvalEnvironment = input.approvalEnvironment ?? `native-${input.profile}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(approvalEnvironment)) {
    const reason = input.approvalEnvironment === undefined
      ? 'The profile name cannot form a CI environment; pass --approval-environment.'
      : 'The native deployment approval environment is invalid.';
    throw new Error(reason);
  }
  const workflowName = `mpgd-native-${slug}.yml`;
  const githubDirectory = join(repositoryRoot, '.github');
  const workflowDirectory = join(githubDirectory, 'workflows');
  for (const directory of [githubDirectory, workflowDirectory]) {
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
      throw new Error('Native deployment workflow directories must not be symlinks.');
    }
  }
  mkdirSync(workflowDirectory, { recursive: true });
  const file = join(workflowDirectory, workflowName);
  const secretPrefix = `MPGD_${slug.toUpperCase().replaceAll(/[^A-Z0-9]/gu, '_')}`;
  const signingNames: Record<string, string> = {};
  const submissionNames: Record<string, string> = {};
  for (const entry of plan.targets) {
    const profile = readNativeDeployTargetProfile(plan, entry.target);
    for (const name of [profile.signingCredential.env, profile.submissionCredential.env]) {
      if (name.startsWith('GIT_') || reservedWorkflowEnvironmentNames.has(name)) {
        throw new Error(`Deployment credential environment name ${name} is reserved by CI.`);
      }
    }
    signingNames[entry.target] = profile.signingCredential.env;
    submissionNames[entry.target] = profile.submissionCredential.env;
  }
  const renderInput: WorkflowRenderInput = {
    gamePath: relativeGame === '' ? '.' : relativeGame,
    gameId,
    profile: plan.profile,
    releaseBranch: input.releaseBranch,
    approvalEnvironment,
    targets: plan.targets.map((entry) => entry.target),
    appIds: Object.fromEntries(plan.targets.map((entry) => [entry.target, entry.appId])),
    secretPrefix,
    signingNames,
    submissionNames,
  };
  const content = renderNativeDeployWorkflow(renderInput);
  writeFileSync(file, content, { flag: 'wx', mode: 0o644 });
  return file;
}

interface WorkflowRenderInput {
  readonly gamePath: string;
  readonly gameId: string;
  readonly profile: string;
  readonly releaseBranch: string;
  readonly approvalEnvironment: string;
  readonly targets: readonly NativeDeployTarget[];
  readonly appIds: Readonly<Partial<Record<NativeDeployTarget, string>>>;
  readonly secretPrefix: string;
  readonly signingNames: Readonly<Record<string, string>>;
  readonly submissionNames: Readonly<Record<string, string>>;
}

function expression(value: string): string {
  return '$' + `{{ ${value} }}`;
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function renderNativeDeployWorkflow(input: WorkflowRenderInput): string {
  const options = input.targets.map((target) => `          - ${target}`);
  const lines = [
    '# Generated by mpgd deploy workflow init. Configure the protected environment first.',
    `name: mpgd-native-${input.gameId}`,
    '',
    'on:',
    '  pull_request:',
    '  workflow_dispatch:',
    '    inputs:',
    '      target:',
    '        description: Native target to deploy',
    '        type: choice',
    '        required: true',
    '        options:',
    ...options,
    '      release:',
    '        description: Unique release label; the target suffix is added automatically',
    '        type: string',
    '        required: true',
    '      game_version:',
    '        description: Game SemVer version',
    '        type: string',
    '        required: true',
    '      initial_ledger:',
    '        description: Committed initial ledger path for a first release only',
    '        type: string',
    '        required: false',
    '      artifact_run_id:',
    '        description: Earlier workflow run ID to restore an identical recorded binary',
    '        type: string',
    '        required: false',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  validate:',
    "    if: github.event_name == 'pull_request'",
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v5',
    '        with:',
    '          persist-credentials: false',
    '      - uses: pnpm/action-setup@v6',
    '        with:',
    '          version: 11.7.0',
    '      - uses: actions/setup-node@v5',
    '        with:',
    '          node-version: 24',
    '          cache: pnpm',
    '      - run: pnpm install --frozen-lockfile',
    '      - name: Validate deployment plan without secrets',
    '        env:',
    `          GAME_PATH: ${quoted(input.gamePath)}`,
    `          PROFILE: ${quoted(input.profile)}`,
    `          TARGETS: ${quoted(input.targets.join(','))}`,
    '        run: |',
    '          pnpm --dir "$GAME_PATH" exec mpgd deploy plan --game . --profile "$PROFILE" \\',
    '            --targets "$TARGETS" --out "$RUNNER_TEMP/mpgd-pr-plan.json"',
    '      - run: pnpm --dir ' + quoted(input.gamePath)
      + ' run --if-present test:deploy-mock',
  ];
  for (const target of input.targets) {
    lines.push(...renderDeployJob(input, target));
  }
  return `${lines.join('\n')}\n`;
}

function renderDeployJob(
  input: WorkflowRenderInput,
  target: NativeDeployTarget,
): string[] {
  const appId = input.appIds[target];
  if (appId === undefined) {
    throw new Error(`Missing ${target} app ID in the deployment plan.`);
  }
  const secret = (suffix: string): string => expression(`secrets.${input.secretPrefix}_${suffix}`);
  const lines = [
    `  deploy_${target}:`,
    `    if: github.event_name == 'workflow_dispatch' && github.ref == `
      + `'refs/heads/${input.releaseBranch}' && inputs.target == '${target}'`,
    `    runs-on: ${target === 'android' ? 'ubuntu-latest' : 'macos-26'}`,
    `    environment: ${quoted(input.approvalEnvironment)}`,
    '    permissions:',
    '      contents: write',
    '      actions: read',
    '    concurrency:',
    `      group: mpgd-${appId}-${target}-${expression('github.repository')}`,
    '      cancel-in-progress: false',
    '    env:',
    `      GAME_PATH: ${quoted(input.gamePath)}`,
    `      GAME_ID: ${quoted(input.gameId)}`,
    `      PROFILE: ${quoted(input.profile)}`,
    `      TARGET: ${target}`,
    `      RELEASE_ID: ${expression('inputs.release')}`,
    `      GAME_VERSION: ${expression('inputs.game_version')}`,
    `      INITIAL_LEDGER: ${expression('inputs.initial_ledger')}`,
    `      ARTIFACT_RUN_ID: ${expression('inputs.artifact_run_id')}`,
    '    steps:',
    '      - uses: actions/checkout@v5',
    '        with:',
    '          fetch-depth: 0',
    '          persist-credentials: false',
    '      - uses: pnpm/action-setup@v6',
    '        with:',
    '          version: 11.7.0',
    '      - uses: actions/setup-node@v5',
    '        with:',
    '          node-version: 24',
    '          cache: pnpm',
  ];
  if (target === 'android') {
    lines.push(
      '      - uses: actions/setup-java@v5',
      '        with:',
      '          distribution: temurin',
      '          java-version: 21',
      '      - uses: android-actions/setup-android@v4',
      '        with:',
      "          packages: ''",
      '      - run: sdkmanager "platforms;android-36" "build-tools;36.0.0"',
    );
  }
  lines.push(
    '      - name: Install committed game dependencies',
    '        env:',
    `          NPM_TOKEN: ${secret('NPM_READ_TOKEN')}`,
    '        run: pnpm install --frozen-lockfile',
    '      - name: Prepare explicit release and read-only plan',
    '        shell: bash',
    '        run: |',
    '          set -euo pipefail',
    '          [[ "$RELEASE_ID" =~ ^[a-z0-9][a-z0-9._-]{0,100}$ ]]',
    '          if [[ -n "$ARTIFACT_RUN_ID" ]]; then',
    '            [[ "$ARTIFACT_RUN_ID" =~ ^[0-9]+$ ]]',
    '          fi',
    '          echo "RELEASE_KEY=$RELEASE_ID-$TARGET" >> "$GITHUB_ENV"',
    '          pnpm --dir "$GAME_PATH" exec mpgd deploy plan --game . --profile "$PROFILE" \\',
    '            --targets "$TARGET" --out "$RUNNER_TEMP/mpgd-$TARGET-plan.json"',
    '      - name: Keep release artifacts out of the Git index',
    '        shell: bash',
    '        run: |',
    '          set -euo pipefail',
    '          if [[ -n "$(git ls-files -- "$GAME_PATH/.mpgd")" ]]; then',
    '            echo "Tracked .mpgd files would be overwritten by artifact restore" >&2',
    '            exit 1',
    '          fi',
    '          game_prefix="$(git -C "$GAME_PATH" rev-parse --show-prefix)"',
    '          printf "/%s.mpgd/\\n" "$game_prefix" >> "$(git rev-parse --git-path info/exclude)"',
    '          git check-ignore -q -- "$GAME_PATH/.mpgd/releases/ignore-probe"',
    '      - name: Restore the exact recorded binary',
    "        if: inputs.artifact_run_id != ''",
    '        uses: actions/download-artifact@v7',
    '        with:',
    `          name: ${input.gameId}-${target}-${expression('env.RELEASE_KEY')}-binary`,
    `          run-id: ${expression('inputs.artifact_run_id')}`,
    `          github-token: ${expression('github.token')}`,
    `          path: ${input.gamePath}/.mpgd/releases/${expression('env.RELEASE_KEY')}`,
    '      - name: Restore the recorded manifest',
    "        if: inputs.artifact_run_id != ''",
    '        uses: actions/download-artifact@v7',
    '        with:',
    `          name: ${input.gameId}-${target}-${expression('env.RELEASE_KEY')}-evidence`,
    `          run-id: ${expression('inputs.artifact_run_id')}`,
    `          github-token: ${expression('github.token')}`,
    `          path: ${input.gamePath}/.mpgd/releases/${expression('env.RELEASE_KEY')}`,
    '      - name: Deploy verified internal-test binary',
    '        shell: bash',
    '        env:',
    `          NPM_TOKEN: ${secret('NPM_READ_TOKEN')}`,
    `          GITHUB_TOKEN: ${expression('github.token')}`,
    '          MPGD_VERIFY_RELEASE_MANIFEST: "1"',
  );
  lines.push(...renderCredentialEnvironment(target, secret));
  lines.push(
    '        run: |',
    '          set -euo pipefail',
    '          umask 077',
    '          secret_dir="$(mktemp -d)"',
    '          trap \'rm -rf -- "$secret_dir"\' EXIT',
    '          git_auth="$(node -e \'process.stdout.write(',
    '            Buffer.from("x-access-token:"+process.env.GITHUB_TOKEN).toString("base64"))\')"',
    '          [[ "$GITHUB_SERVER_URL" == https://* ]]',
    '          export GIT_CONFIG_COUNT=1',
    '          export GIT_CONFIG_KEY_0="http.${GITHUB_SERVER_URL%/}/.extraheader"',
    '          export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $git_auth"',
    '          write_secret() {',
    '            node -e \'const fs=require("node:fs"); const name=process.argv[1];',
    '              const value=process.env[name]; if (!value) throw Error(`Missing ${name}`);',
    '              const decoded=Buffer.from(value,"base64");',
    '              if (!decoded.length || decoded.toString("base64") !== value.trim())',
    '                throw Error(`Invalid ${name}`);',
    '              fs.writeFileSync(process.argv[2], decoded, {mode:0o600});\' "$1" "$2"',
    '          }',
  );
  lines.push(...renderCredentialSetup(input, target));
  lines.push(
    '          if [[ -n "$NPM_TOKEN" ]]; then',
    '            export MPGD_DEPENDENCY_INSTALL_ENV_NAMES=NPM_TOKEN',
    '          fi',
    '          args=(deploy run --plan "$RUNNER_TEMP/mpgd-$TARGET-plan.json"',
    '            --game . --game-id "$GAME_ID" --game-version "$GAME_VERSION"',
    '            --release "$RELEASE_KEY" --approve)',
    '          if [[ -n "$INITIAL_LEDGER" ]]; then',
    '            [[ "$INITIAL_LEDGER" =~ ^[A-Za-z0-9._/-]+$ ]]',
    '            [[ "$INITIAL_LEDGER" != /* && "$INITIAL_LEDGER" != *..* ]]',
    '            git ls-files --error-unmatch -- "$INITIAL_LEDGER" >/dev/null',
    '            args+=(--initial-ledger "$GITHUB_WORKSPACE/$INITIAL_LEDGER")',
    '          fi',
    '          pnpm --dir "$GAME_PATH" exec mpgd "${args[@]}"',
    '      - name: Retain verified native binary',
    "        if: always() && env.RELEASE_KEY != '' && inputs.artifact_run_id == ''",
    '        uses: actions/upload-artifact@v6',
    '        with:',
    `          name: ${input.gameId}-${target}-${expression('env.RELEASE_KEY')}-binary`,
    `          path: ${input.gamePath}/.mpgd/releases/${expression('env.RELEASE_KEY')}`
      + `/*.${target === 'android' ? 'aab' : 'ipa'}`,
    '          if-no-files-found: warn',
    '          include-hidden-files: true',
    '          retention-days: 30',
    '      - name: Retain release manifest',
    "        if: always() && env.RELEASE_KEY != '' && inputs.artifact_run_id == ''",
    '        uses: actions/upload-artifact@v6',
    '        with:',
    `          name: ${input.gameId}-${target}-${expression('env.RELEASE_KEY')}-evidence`,
    `          path: ${input.gamePath}/.mpgd/releases/${expression('env.RELEASE_KEY')}/*.json`,
    '          if-no-files-found: warn',
    '          include-hidden-files: true',
    '          retention-days: 90',
  );
  return lines;
}

function renderCredentialEnvironment(
  target: NativeDeployTarget,
  secret: (suffix: string) => string,
): string[] {
  if (target === 'android') {
    return [
      `          SIGNING_B64: ${secret('ANDROID_KEYSTORE_B64')}`,
      `          SUBMISSION_B64: ${secret('PLAY_SERVICE_ACCOUNT_B64')}`,
      `          MPGD_ANDROID_UPLOAD_STORE_PASSWORD: ${secret('ANDROID_STORE_PASSWORD')}`,
      `          MPGD_ANDROID_UPLOAD_KEY_ALIAS: ${secret('ANDROID_KEY_ALIAS')}`,
      `          MPGD_ANDROID_UPLOAD_KEY_PASSWORD: ${secret('ANDROID_KEY_PASSWORD')}`,
      `          MPGD_ANDROID_UPLOAD_CERT_SHA256: ${secret('ANDROID_CERT_SHA256')}`,
    ];
  }
  return [
    `          SIGNING_B64: ${secret('IOS_P12_B64')}`,
    `          PROFILE_B64: ${secret('IOS_PROFILE_B64')}`,
    `          SUBMISSION_B64: ${secret('ASC_API_KEY_B64')}`,
    `          MPGD_IOS_SIGNING_P12_PASSWORD: ${secret('IOS_P12_PASSWORD')}`,
    `          MPGD_IOS_TEAM_ID: ${secret('IOS_TEAM_ID')}`,
    `          MPGD_ASC_APP_ID: ${secret('ASC_APP_ID')}`,
    `          MPGD_ASC_KEY_ID: ${secret('ASC_KEY_ID')}`,
    `          MPGD_ASC_ISSUER_ID: ${secret('ASC_ISSUER_ID')}`,
    '          ASC_TELEMETRY_DISABLED: 1',
  ];
}

function renderCredentialSetup(
  input: WorkflowRenderInput,
  target: NativeDeployTarget,
): string[] {
  const signingName = input.signingNames[target];
  const submissionName = input.submissionNames[target];
  if (signingName === undefined || submissionName === undefined) {
    throw new Error(`Missing ${target} deployment credential references.`);
  }
  if (target === 'android') {
    return [
      '          write_secret SIGNING_B64 "$secret_dir/upload.keystore"',
      '          write_secret SUBMISSION_B64 "$secret_dir/play-service-account.json"',
      `          export ${signingName}="$secret_dir/upload.keystore"`,
      `          export ${submissionName}="$secret_dir/play-service-account.json"`,
    ];
  }
  return [
    '          write_secret SIGNING_B64 "$secret_dir/signing.p12"',
    '          write_secret PROFILE_B64 "$secret_dir/profile.mobileprovision"',
    `          export ${signingName}="$secret_dir/signing.p12"`,
    `          export ${submissionName}="$SUBMISSION_B64"`,
    '          export MPGD_IOS_PROVISIONING_PROFILE="$secret_dir/profile.mobileprovision"',
    '          case "$(uname -m)" in',
    `            arm64) asc_asset=asc_${pinnedAscVersion}_macOS_arm64 ;;`,
    `            x86_64) asc_asset=asc_${pinnedAscVersion}_macOS_amd64 ;;`,
    '            *) echo "Unsupported macOS architecture" >&2; exit 1 ;;',
    '          esac',
    '          curl -fL --retry 3 \\',
    `            "https://github.com/rorkai/App-Store-Connect-CLI/releases/download/${pinnedAscVersion}/$asc_asset" \\`,
    '            -o "$secret_dir/asc"',
    '          chmod 700 "$secret_dir/asc"',
    '          export MPGD_ASC_BINARY="$secret_dir/asc"',
  ];
}
