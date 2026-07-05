import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import completion from '@gunshi/plugin-completion';
import i18n, { defineI18n } from '@gunshi/plugin-i18n';
import resources from '@gunshi/resources';
import { cli } from 'gunshi';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = resolvePackageRoot(sourceDir);
const detectedKitRoot = resolveDefaultKitRoot();
const gameTemplateDir = path.resolve(packageRoot, 'templates/phaser-game');
const cliVersion = readPackageVersion(packageRoot);
const defaultMatrixTargets = 'web,ait,reddit';
const defaultDependencyVersion = `^${cliVersion}`;

const supportedBuildTargets = [
  'browser',
  'web',
  'web-preview',
  'android',
  'ios',
  'ait',
  'devvit',
  'reddit',
] as const;
const supportedVariants = ['wrapper', 'sync', 'simulator', 'archive'] as const;

export async function runMpgdCli(args: readonly string[]): Promise<void> {
  await cli([...args], entryCommand, {
    name: 'mpgd',
    version: cliVersion,
    subCommands: {
      game: gameCommand,
      target: targetCommand,
      kit: kitCommand,
    },
    plugins: [
      i18n({
        locale: readCliLocale(),
        builtinResources: resources,
      }),
      completion({
        config: {
          subCommands: {
            game: {
              handler: () => listTemplateCompletionItems(),
            },
            target: {
              handler: () => listTargetCompletionItems(),
            },
          },
        },
      }),
    ],
  });
}

export async function runCreateGameCli(args: readonly string[]): Promise<void> {
  await runMpgdCli(['game', 'create', ...args]);
}

export function readCliArgs(): readonly string[] {
  const encoded = process.env.MPGD_CLI_ARGV;

  if (encoded === undefined) {
    return process.argv.slice(2);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error('Invalid MPGD_CLI_ARGV payload.');
  }

  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error('Invalid MPGD_CLI_ARGV payload.');
  }

  return parsed;
}

const entryCommand = defineI18n({
  name: 'mpgd',
  description: 'Manage mpgd-kit starter and target workflows.',
  resource: commandResource({
    en: 'Manage mpgd-kit starter and target workflows.',
    ko: 'mpgd-kit 스타터와 타깃 워크플로우를 관리합니다.',
  }),
  run: () => {
    console.log('Use a sub-command: game, target, kit.');
    console.log('Run "pnpm mpgd --help" for available commands.');
  },
});

const gameCommand = defineI18n({
  name: 'game',
  description: 'Create standalone Phaser game starters.',
  resource: commandResource({
    en: 'Create standalone Phaser game starters.',
    ko: '독립 Phaser 게임 스타터를 생성합니다.',
  }),
  subCommands: {
    create: defineI18n({
      name: 'create',
      description: 'Create a Phaser game starter in a directory.',
      resource: commandResource(
        {
          en: 'Create a Phaser game starter in a directory.',
          ko: '지정한 디렉터리에 Phaser 게임 스타터를 생성합니다.',
        },
        {
          directory: {
            en: 'Directory to create.',
            ko: '생성할 디렉터리.',
          },
          title: {
            en: 'Display title. Defaults to the directory name.',
            ko: '표시 제목. 기본값은 디렉터리 이름입니다.',
          },
          'package-name': {
            en: 'npm package name. Defaults to the directory basename.',
            ko: 'npm 패키지명. 기본값은 디렉터리 마지막 이름입니다.',
          },
          'dependency-version': {
            en: 'Version range for @mpgd packages.',
            ko: '@mpgd 패키지에 사용할 버전 범위.',
          },
          workspace: {
            en: 'Use workspace:* for @mpgd dependencies.',
            ko: '@mpgd 의존성에 workspace:*를 사용합니다.',
          },
          'kit-path': {
            en: 'Path to an mpgd-kit checkout when using --workspace.',
            ko: '--workspace 사용 시 mpgd-kit 체크아웃 경로.',
          },
          'dry-run': {
            en: 'Print files that would be generated without writing them.',
            ko: '파일을 쓰지 않고 생성 예정 목록만 출력합니다.',
          },
        },
      ),
      args: {
        directory: {
          type: 'positional',
          required: true,
          description: 'Directory to create.',
        },
        title: {
          type: 'string',
          required: false,
          description: 'Display title. Defaults to the directory name.',
        },
        'package-name': {
          type: 'string',
          required: false,
          description: 'npm package name. Defaults to the directory basename.',
        },
        'dependency-version': {
          type: 'string',
          required: false,
          default: defaultDependencyVersion,
          description: 'Version range for @mpgd packages.',
        },
        workspace: {
          type: 'boolean',
          required: false,
          description: 'Use workspace:* for @mpgd dependencies.',
        },
        'kit-path': {
          type: 'string',
          required: false,
          description: 'Path to an mpgd-kit checkout when using --workspace.',
        },
        'dry-run': {
          type: 'boolean',
          required: false,
          description: 'Print files that would be generated without writing them.',
        },
      },
      run: (ctx) => {
        const positionals = readLocalPositionals(ctx.positionals, ['game', 'create']);
        const directory = readRequiredPositional(positionals, 0, 'directory');
        const title = readOptionalString(ctx.values.title);
        const packageName = readOptionalString(ctx.values['package-name']);
        const dependencyVersion =
          ctx.values.workspace === true
            ? 'workspace:*'
            : (readOptionalString(ctx.values['dependency-version']) ?? defaultDependencyVersion);
        const kitPath = readGameCreateKitPath(ctx.values, ctx.values.workspace === true);

        createGameApp({
          directory,
          ...(title === undefined ? {} : { title }),
          ...(packageName === undefined ? {} : { packageName }),
          dependencyVersion,
          workspace: ctx.values.workspace === true,
          ...(kitPath === undefined ? {} : { kitPath }),
          dryRun: ctx.values['dry-run'] === true,
        });
      },
    }),
  },
  run: () => {
    console.log('Use "mpgd game create <directory>".');
  },
});

const targetCommand = defineI18n({
  name: 'target',
  description: 'Build and smoke target artifacts with generated game target config.',
  resource: commandResource({
    en: 'Build and smoke target artifacts with generated game target config.',
    ko: '게임 타깃 설정으로 타깃 산출물을 빌드하고 스모크 검증합니다.',
  }),
  subCommands: {
    build: defineI18n({
      name: 'build',
      description: 'Build one target artifact.',
      resource: commandResource(
        {
          en: 'Build one target artifact.',
          ko: '단일 타깃 산출물을 빌드합니다.',
        },
        {
          target: {
            en: `Target (${supportedBuildTargets.join(', ')})`,
            ko: `타깃 (${supportedBuildTargets.join(', ')})`,
          },
          profile: {
            en: 'Vite build mode/profile.',
            ko: 'Vite 빌드 모드/프로필.',
          },
          'targets-file': {
            en: 'Game target config file.',
            ko: '게임 타깃 설정 파일.',
          },
          'kit-path': {
            en: 'Path to the mpgd-kit checkout used by target wrappers.',
            ko: '타깃 wrapper에 사용할 mpgd-kit 체크아웃 경로.',
          },
          variant: {
            en: `Target variant (${supportedVariants.join(', ')})`,
            ko: `타깃 변형 (${supportedVariants.join(', ')})`,
          },
        },
      ),
      args: {
        target: {
          type: 'positional',
          required: true,
          description: `Target (${supportedBuildTargets.join(', ')})`,
        },
        profile: {
          type: 'positional',
          required: false,
          default: 'production',
          description: 'Vite build mode/profile.',
        },
        ...targetConfigArgs(),
        variant: {
          type: 'enum',
          choices: supportedVariants,
          required: false,
          description: `Target variant (${supportedVariants.join(', ')})`,
        },
      },
      run: (ctx) => {
        const positionals = readLocalPositionals(ctx.positionals, ['target', 'build']);
        const target = readRequiredPositional(positionals, 0, 'target');
        const profile = positionals[1] ?? 'production';

        const variant = readOptionalString(ctx.values.variant);

        runTargetCommand({
          action: 'build',
          target,
          profile,
          env: createTargetCommandEnv(ctx.values),
          ...(variant === undefined ? {} : { variant }),
        });
      },
    }),
    smoke: defineI18n({
      name: 'smoke',
      description: 'Verify one existing target artifact.',
      resource: commandResource(
        {
          en: 'Verify one existing target artifact.',
          ko: '기존 단일 타깃 산출물을 스모크 검증합니다.',
        },
        {
          target: {
            en: `Target (${supportedBuildTargets.join(', ')})`,
            ko: `타깃 (${supportedBuildTargets.join(', ')})`,
          },
          'targets-file': {
            en: 'Game target config file.',
            ko: '게임 타깃 설정 파일.',
          },
          'kit-path': {
            en: 'Path to the mpgd-kit checkout used by target wrappers.',
            ko: '타깃 wrapper에 사용할 mpgd-kit 체크아웃 경로.',
          },
        },
      ),
      args: {
        target: {
          type: 'positional',
          required: true,
          description: `Target (${supportedBuildTargets.join(', ')})`,
        },
        ...targetConfigArgs(),
      },
      run: (ctx) => {
        const positionals = readLocalPositionals(ctx.positionals, ['target', 'smoke']);
        const target = readRequiredPositional(positionals, 0, 'target');

        runTargetCommand({
          action: 'smoke',
          target,
          env: createTargetCommandEnv(ctx.values),
        });
      },
    }),
    'build-all': defineI18n({
      name: 'build-all',
      description: 'Build multiple target artifacts.',
      resource: commandResource(
        {
          en: 'Build multiple target artifacts.',
          ko: '여러 타깃 산출물을 빌드합니다.',
        },
        matrixArgResources(),
      ),
      args: {
        targets: {
          type: 'string',
          required: false,
          default: defaultMatrixTargets,
          description: 'Comma-separated target list, or all.',
        },
        profile: {
          type: 'string',
          required: false,
          default: 'production',
          description: 'Build profile passed to target builds.',
        },
        'ait-variant': {
          type: 'enum',
          choices: supportedVariants,
          required: false,
          description: 'Variant for the ait target, such as wrapper.',
        },
        'ios-variant': {
          type: 'enum',
          choices: supportedVariants,
          required: false,
          description: 'Variant for the ios target, such as sync or archive.',
        },
        ...targetConfigArgs(),
      },
      run: (ctx) => {
        const aitVariant = readOptionalString(ctx.values['ait-variant']);
        const iosVariant = readOptionalString(ctx.values['ios-variant']);

        runTargetMatrix({
          action: 'build',
          targets: parseTargetList(readOptionalString(ctx.values.targets)),
          profile: readOptionalString(ctx.values.profile) ?? 'production',
          env: createTargetCommandEnv(ctx.values),
          ...(aitVariant === undefined ? {} : { aitVariant }),
          ...(iosVariant === undefined ? {} : { iosVariant }),
        });
      },
    }),
    'smoke-all': defineI18n({
      name: 'smoke-all',
      description: 'Verify existing artifacts for multiple targets.',
      resource: commandResource(
        {
          en: 'Verify existing artifacts for multiple targets.',
          ko: '여러 타깃의 기존 산출물을 스모크 검증합니다.',
        },
        matrixArgResources(),
      ),
      args: {
        targets: {
          type: 'string',
          required: false,
          default: defaultMatrixTargets,
          description: 'Comma-separated target list, or all.',
        },
        ...targetConfigArgs(),
      },
      run: (ctx) => {
        runTargetMatrix({
          action: 'smoke',
          targets: parseTargetList(readOptionalString(ctx.values.targets)),
          env: createTargetCommandEnv(ctx.values),
        });
      },
    }),
  },
  run: () => {
    console.log('Use "mpgd target build <target>" or "mpgd target smoke <target>".');
  },
});

const kitCommand = defineI18n({
  name: 'kit',
  description: 'Inspect this mpgd-kit checkout.',
  resource: commandResource({
    en: 'Inspect this mpgd-kit checkout.',
    ko: '현재 mpgd-kit 체크아웃을 점검합니다.',
  }),
  subCommands: {
    doctor: defineI18n({
      name: 'doctor',
      description: 'Print CLI, kit, template, and target-wrapper status.',
      resource: commandResource({
        en: 'Print CLI, kit, template, and target-wrapper status.',
        ko: 'CLI, kit, template, target wrapper 상태를 출력합니다.',
      }),
      run: () => {
        console.log(`cli package: ${packageRoot}`);
        console.log(`mpgd-kit: ${detectedKitRoot ?? 'not detected'}`);
        console.log(`cli template: ${existsSync(gameTemplateDir) ? 'ok' : 'missing'}`);
        console.log(`mobile wrapper: ${kitFileStatus('apps/mobile-capacitor/package.json')}`);
        console.log(`ait wrapper: ${kitFileStatus('apps/target-ait/package.json')}`);
        console.log(`devvit wrapper: ${kitFileStatus('apps/target-devvit/package.json')}`);
      },
    }),
  },
  run: () => {
    console.log('Use "mpgd kit doctor".');
  },
});

interface LocalizedText {
  readonly en: string;
  readonly ko: string;
}

function commandResource(
  description:
    | LocalizedText
    | {
        readonly base: LocalizedText;
        readonly args: Record<string, LocalizedText>;
      },
  args: Record<string, LocalizedText> = {},
) {
  const normalized =
    'base' in description
      ? description
      : {
          base: description,
          args,
        };

  return (locale: Intl.Locale) => {
    const resource: Record<string, string> = {
      description: pickLocalizedText(locale, normalized.base),
    };

    for (const [name, text] of Object.entries(normalized.args)) {
      resource[`arg:${name}`] = pickLocalizedText(locale, text);
    }

    return resource as { description: string } & Record<string, string>;
  };
}

function targetConfigArgs() {
  return {
    'targets-file': {
      type: 'string',
      required: false,
      default: 'mpgd.targets.json',
      description: 'Game target config file.',
    },
    'kit-path': {
      type: 'string',
      required: false,
      description: 'Path to the mpgd-kit checkout used by target wrappers.',
    },
    'resolved-targets-file': {
      type: 'string',
      required: false,
      description: 'Output path for the resolved target config file.',
    },
  } as const;
}

function matrixArgResources(): Record<string, LocalizedText> {
  return {
    targets: {
      en: 'Comma-separated target list, or all.',
      ko: '쉼표로 구분한 타깃 목록 또는 all.',
    },
    profile: {
      en: 'Build profile passed to target builds.',
      ko: '타깃 빌드에 전달할 빌드 프로필.',
    },
    'targets-file': {
      en: 'Game target config file.',
      ko: '게임 타깃 설정 파일.',
    },
    'kit-path': {
      en: 'Path to the mpgd-kit checkout used by target wrappers.',
      ko: '타깃 wrapper에 사용할 mpgd-kit 체크아웃 경로.',
    },
    'ait-variant': {
      en: 'Variant for the ait target, such as wrapper.',
      ko: 'wrapper 같은 ait 타깃 변형.',
    },
    'ios-variant': {
      en: 'Variant for the ios target, such as sync, simulator, or archive.',
      ko: 'sync, simulator, archive 같은 ios 타깃 변형.',
    },
  };
}

function createGameApp(input: {
  readonly directory: string;
  readonly title?: string;
  readonly packageName?: string;
  readonly dependencyVersion: string;
  readonly workspace: boolean;
  readonly kitPath?: string;
  readonly dryRun: boolean;
}): void {
  const appDir = resolveAppDirectory(input.directory);
  const gameName = path.basename(appDir);

  assertValidGameName(gameName);

  const packageName = input.packageName ?? gameName;
  assertValidPackageName(packageName);
  assertValidDependencyVersion(input.dependencyVersion);

  if (existsSync(appDir)) {
    throw new Error(`Game directory already exists: ${appDir}`);
  }

  const context = createTemplateContext({
    gameName,
    packageName,
    dependencyVersion: input.dependencyVersion,
    appDir,
    workspace: input.workspace,
    ...(input.kitPath === undefined ? {} : { kitPath: input.kitPath }),
    ...(input.title === undefined ? {} : { title: input.title }),
  });
  const files = collectTemplateFiles(gameTemplateDir);

  if (input.dryRun) {
    console.log(`Would create ${path.relative(process.cwd(), appDir) || appDir}:`);

    for (const file of files) {
      console.log(`- ${path.join(path.relative(process.cwd(), appDir), file.relativePath)}`);
    }

    return;
  }

  for (const file of files) {
    const outputFile = path.join(appDir, file.relativePath);
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, renderTemplate(file.content, context));
  }

  console.log(`Created ${appDir}`);
  console.log('Next steps:');
  console.log(`  cd ${appDir}`);
  console.log('  pnpm install --filter . --filter ./apps/target-devvit');
  console.log('  pnpm dev');
  console.log('Target builds require an mpgd-kit checkout:');
  console.log(
    [
      '  mpgd target build-all',
      `--targets-file ${path.join(appDir, 'mpgd.targets.json')}`,
      '--targets web,ait,reddit',
      '--ait-variant wrapper',
      '--kit-path <path-to-mpgd-kit>',
    ].join(' '),
  );
}

function assertValidGameName(name: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error('Game directory basename must use kebab-case, for example: puzzle-one');
  }
}

function resolveAppDirectory(directory: string): string {
  const resolved = path.resolve(process.cwd(), directory);
  const parent = path.dirname(resolved);

  if (!existsSync(parent)) {
    return resolved;
  }

  return path.join(realpathSync(parent), path.basename(resolved));
}

function assertValidPackageName(name: string): void {
  if (!/^(?:@[a-z][a-z0-9-]*\/)?[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      'Package name must be kebab-case, optionally scoped, for example: @scope/puzzle-one',
    );
  }
}

function assertValidDependencyVersion(version: string): void {
  if (!/^(?:workspace:\*|[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(version)) {
    throw new Error(
      'Dependency version must be workspace:* or a semver version/range such as ^0.1.0.',
    );
  }
}

function createTemplateContext(input: {
  readonly gameName: string;
  readonly packageName: string;
  readonly dependencyVersion: string;
  readonly appDir: string;
  readonly workspace: boolean;
  readonly kitPath?: string;
  readonly title?: string;
}) {
  const title =
    input.title === undefined || input.title.length === 0 ? input.gameName : input.title;
  assertValidGameTitle(title);

  const kitPath = input.kitPath ?? detectedKitRoot;

  if (input.workspace && kitPath === undefined) {
    throw new Error(
      'Could not detect an mpgd-kit checkout for --workspace. Pass --kit-path or set MPGD_KIT_PATH.',
    );
  }

  const workspaceRoot = toTemplatePath(path.relative(input.appDir, kitPath ?? input.appDir) || '.');
  const workspacePrefix = workspaceRoot;

  return {
    gameName: input.gameName,
    gameTitle: title,
    packageName: input.packageName,
    dependencyVersion: input.dependencyVersion,
    tsconfigExtendsLine: input.workspace
      ? `  "extends": "${workspacePrefix}/tsconfig.base.json",`
      : '',
    tsconfigWorkspaceIncludes: input.workspace
      ? [
          `,\n    "${workspacePrefix}/packages/**/*.ts"`,
          `,\n    "${workspacePrefix}/adapters/**/*.ts"`,
          `,\n    "${workspacePrefix}/native-plugins/*/src/**/*.ts"`,
        ].join('')
      : '',
    tsconfigWorkspaceExcludes: input.workspace
      ? [
          `,\n    "${workspacePrefix}/packages/**/dist/**"`,
          `,\n    "${workspacePrefix}/packages/cli/templates/**"`,
          `,\n    "${workspacePrefix}/adapters/**/dist/**"`,
          `,\n    "${workspacePrefix}/native-plugins/**/dist/**"`,
        ].join('')
      : '',
    workspaceI18nBuildPrefix: input.workspace
      ? `pnpm --dir ${workspacePrefix} i18n:build && `
      : '',
    defaultKitPath: kitPath === undefined ? '../mpgd-kit' : workspacePrefix,
    pnpmWorkspaceKitPackages: input.workspace
      ? [
          `  - '${workspacePrefix}/packages/*'`,
          `  - '${workspacePrefix}/adapters/*'`,
          `  - '${workspacePrefix}/native-plugins/*'`,
        ].join('\n')
      : '',
    pascalName: toPascalCase(input.gameName),
    camelName: toCamelCase(input.gameName),
  };
}

function assertValidGameTitle(title: string): void {
  if (title.trim().length === 0) {
    throw new Error('Game title cannot be empty.');
  }

  if (/[\u0000-\u001f<>"'\\]/u.test(title)) {
    throw new Error(
      'Game title cannot contain control characters, quotes, backslashes, or angle brackets.',
    );
  }
}

function collectTemplateFiles(templateDir: string): readonly TemplateFile[] {
  const files: TemplateFile[] = [];
  walkTemplateDir(templateDir, '', files);
  return files;
}

function walkTemplateDir(
  templateDir: string,
  relativeDir: string,
  files: TemplateFile[],
): void {
  const currentDir = path.join(templateDir, relativeDir);

  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);

    if (entry.isDirectory()) {
      walkTemplateDir(templateDir, relativePath, files);
      continue;
    }

    files.push({
      relativePath,
      content: readFileSync(path.join(templateDir, relativePath), 'utf8'),
    });
  }
}

interface TemplateFile {
  readonly relativePath: string;
  readonly content: string;
}

function renderTemplate(
  content: string,
  context: ReturnType<typeof createTemplateContext>,
): string {
  return content
    .replaceAll('__GAME_NAME__', context.gameName)
    .replaceAll('__GAME_TITLE__', context.gameTitle)
    .replaceAll('__PACKAGE_NAME__', context.packageName)
    .replaceAll('__MPGD_DEPENDENCY_VERSION__', context.dependencyVersion)
    .replaceAll('__TSCONFIG_EXTENDS_LINE__', context.tsconfigExtendsLine)
    .replaceAll('__TSCONFIG_WORKSPACE_INCLUDES__', context.tsconfigWorkspaceIncludes)
    .replaceAll('__TSCONFIG_WORKSPACE_EXCLUDES__', context.tsconfigWorkspaceExcludes)
    .replaceAll('__WORKSPACE_I18N_BUILD_PREFIX__', context.workspaceI18nBuildPrefix)
    .replaceAll('__DEFAULT_KIT_PATH__', context.defaultKitPath)
    .replaceAll('__PNPM_WORKSPACE_KIT_PACKAGES__', context.pnpmWorkspaceKitPackages)
    .replaceAll('__PASCAL_NAME__', context.pascalName)
    .replaceAll('__CAMEL_NAME__', context.camelName);
}

function toPascalCase(value: string): string {
  return value
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return `${pascal[0]?.toLowerCase() ?? ''}${pascal.slice(1)}`;
}

function toTemplatePath(value: string): string {
  return value.split(path.sep).join('/');
}

interface TargetCommandEnvInput {
  readonly 'targets-file'?: unknown;
  readonly 'kit-path'?: unknown;
  readonly 'resolved-targets-file'?: unknown;
}

interface PackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly scripts?: Record<string, string>;
}

function createTargetCommandEnv(values: TargetCommandEnvInput): NodeJS.ProcessEnv {
  const targetsFile = path.resolve(
    readOptionalString(values['targets-file']) ?? 'mpgd.targets.json',
  );
  const kitPath = resolveKitPathForTarget(values);
  const resolvedTargetsFile = readOptionalString(values['resolved-targets-file']);
  const preparedTargetsFile = preparePlatformTargetsFile({
    targetsFile,
    kitPath,
    ...(resolvedTargetsFile === undefined
      ? {}
      : { outputFile: path.resolve(resolvedTargetsFile) }),
  });

  return {
    ...process.env,
    MPGD_KIT_PATH: kitPath,
    MPGD_PLATFORM_TARGETS_FILE: preparedTargetsFile,
  };
}

function preparePlatformTargetsFile(input: {
  readonly targetsFile: string;
  readonly kitPath: string;
  readonly outputFile?: string;
}): string {
  const parsed = readJsonForCli(input.targetsFile);
  const gameRoot = path.dirname(input.targetsFile);
  const outputFile =
    input.outputFile ?? path.join(gameRoot, '.mpgd.targets.generated.json');
  const outputDir = path.dirname(outputFile);

  if (path.resolve(outputDir) !== path.resolve(gameRoot)) {
    throw new Error(
      '--resolved-targets-file must stay beside the source targets file so relative target paths keep their meaning.',
    );
  }

  const rendered = replaceTargetTokens(parsed, {
    gameRoot,
    kitPath: input.kitPath,
  });

  writeFileSync(outputFile, `${JSON.stringify(rendered, null, 2)}\n`);

  return outputFile;
}

function readJsonForCli(file: string): unknown {
  let raw: string;

  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read targets file ${file}: ${formatError(error)}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse targets file ${file}: ${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replaceTargetTokens(
  value: unknown,
  context: {
    readonly gameRoot: string;
    readonly kitPath: string;
  },
): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll('${MPGD_KIT_PATH}', context.kitPath)
      .replaceAll('${MPGD_GAME_ROOT}', context.gameRoot)
      .replaceAll('${MPGD_GAME_APP_ROOT}', context.gameRoot);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => replaceTargetTokens(entry, context));
  }

  if (typeof value === 'object' && value !== null) {
    const output = Object.create(null) as Record<string, unknown>;

    for (const [key, entry] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }

      output[key] = replaceTargetTokens(entry, context);
    }

    return output;
  }

  return value;
}

function runTargetCommand(input: {
  readonly action: 'build' | 'smoke';
  readonly target: string;
  readonly env: NodeJS.ProcessEnv;
  readonly profile?: string;
  readonly variant?: string;
}): void {
  const target = normalizeBuildTarget(input.target);
  const env = withTargetVariantEnv(target, input.variant, input.env);
  const args =
    input.action === 'build'
      ? ['build:target', target, input.profile ?? 'production']
      : ['smoke:target', target];

  console.log(`[mpgd] ${input.action} ${target}`);
  runPnpm(args, env);
}

function runTargetMatrix(input: {
  readonly action: 'build' | 'smoke';
  readonly targets: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly profile?: string;
  readonly aitVariant?: string;
  readonly iosVariant?: string;
}): void {
  for (const target of input.targets) {
    const variant = variantForTarget(target, input);

    runTargetCommand({
      action: input.action,
      target,
      env: input.env,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      ...(variant === undefined ? {} : { variant }),
    });
  }
}

function variantForTarget(
  target: string,
  input: Pick<Parameters<typeof runTargetMatrix>[0], 'aitVariant' | 'iosVariant'>,
): string | undefined {
  const normalized = normalizeBuildTarget(target);

  if (normalized === 'ait') {
    return input.aitVariant;
  }

  if (normalized === 'ios') {
    return input.iosVariant;
  }

  return undefined;
}

function withTargetVariantEnv(
  target: string,
  variant: string | undefined,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (target === 'ait' && variant === 'wrapper') {
    return {
      ...env,
      MPGD_AIT_PACKAGE_MODE: 'skip',
    };
  }

  if (target === 'ios' && variant === 'archive') {
    return {
      ...env,
      MPGD_RUN_IOS_ARCHIVE: '1',
    };
  }

  if (target === 'ios' && variant === 'simulator') {
    return {
      ...env,
      MPGD_RUN_IOS_SIMULATOR_BUILD: '1',
    };
  }

  return env;
}

function parseTargetList(value: string | undefined): readonly string[] {
  const raw = value ?? defaultMatrixTargets;

  if (raw === 'all') {
    return ['web-preview', 'android', 'ios', 'ait', 'reddit'];
  }

  const targets = raw
    .split(',')
    .map((target) => target.trim())
    .filter((target) => target.length > 0)
    .map((target) => normalizeBuildTarget(target));

  if (targets.length === 0) {
    throw new Error('Target list cannot be empty.');
  }

  return [...new Set(targets)];
}

function normalizeBuildTarget(target: string): string {
  if (target === 'browser' || target === 'web') {
    return 'web-preview';
  }

  if (target === 'devvit') {
    return 'reddit';
  }

  if (!supportedBuildTargets.includes(target as (typeof supportedBuildTargets)[number])) {
    throw new Error(`Unsupported target: ${target}`);
  }

  return target;
}

function runPnpm(args: readonly string[], commandEnv: NodeJS.ProcessEnv): void {
  const kitPath = commandEnv.MPGD_KIT_PATH;

  if (kitPath === undefined || kitPath.length === 0) {
    throw new Error('Missing MPGD_KIT_PATH. Pass --kit-path or set MPGD_KIT_PATH.');
  }

  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(command, [...args], {
    cwd: kitPath,
    env: commandEnv,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}

function readRequiredPositional(
  positionals: readonly string[],
  index: number,
  label: string,
): string {
  const value = positionals[index];

  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${label}.`);
  }

  return value;
}

function readLocalPositionals(
  positionals: readonly string[],
  commandPath: readonly string[],
): readonly string[] {
  const commandPathMatches = commandPath.every((segment, index) => positionals[index] === segment);

  if (!commandPathMatches) {
    return positionals;
  }

  return positionals.slice(commandPath.length);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readGameCreateKitPath(
  values: { readonly 'kit-path'?: unknown },
  workspace: boolean,
): string | undefined {
  const explicitKitPath = readOptionalString(values['kit-path']);

  if (explicitKitPath !== undefined) {
    return assertKitRoot(path.resolve(explicitKitPath));
  }

  if (!workspace) {
    return undefined;
  }

  if (process.env.MPGD_KIT_PATH === undefined || process.env.MPGD_KIT_PATH.length === 0) {
    return undefined;
  }

  return isKitRoot(path.resolve(process.env.MPGD_KIT_PATH))
    ? path.resolve(process.env.MPGD_KIT_PATH)
    : undefined;
}

function resolveKitPathForTarget(values: TargetCommandEnvInput): string {
  const rawKitPath =
    readOptionalString(values['kit-path']) ?? process.env.MPGD_KIT_PATH ?? detectedKitRoot;

  if (rawKitPath === undefined) {
    throw new Error(
      'Could not detect an mpgd-kit checkout. Pass --kit-path or set MPGD_KIT_PATH before running target commands.',
    );
  }

  return assertKitRoot(path.resolve(rawKitPath));
}

function resolvePackageRoot(startDir: string): string {
  const packageRoot = findAncestor(
    startDir,
    (dir) => readPackageJsonOrUndefined(dir)?.name === '@mpgd/cli',
  );

  if (packageRoot === undefined) {
    throw new Error(`Could not find @mpgd/cli package root from ${startDir}`);
  }

  return packageRoot;
}

function resolveDefaultKitRoot(): string | undefined {
  const envKitPath = process.env.MPGD_KIT_PATH;

  if (envKitPath !== undefined && envKitPath.length > 0) {
    const resolved = path.resolve(envKitPath);
    if (isKitRoot(resolved)) {
      return resolved;
    }
  }

  return findKitRoot(packageRoot) ?? findKitRoot(process.cwd());
}

function findKitRoot(startDir: string): string | undefined {
  return findAncestor(startDir, isKitRoot);
}

function assertKitRoot(kitPath: string): string {
  if (!isKitRoot(kitPath, { strictParse: true })) {
    throw new Error(
      `Expected an mpgd-kit checkout at ${kitPath}. Pass a directory containing the mpgd-kit root package.json and build:target script.`,
    );
  }

  return kitPath;
}

function isKitRoot(
  dir: string,
  options: { readonly strictParse?: boolean } = {},
): boolean {
  const packageJson = readPackageJsonOrUndefined(dir, options);

  return packageJson?.name === 'mpgd-kit' && packageJson.scripts?.['build:target'] !== undefined;
}

function kitFileStatus(relativePath: string): string {
  if (detectedKitRoot === undefined) {
    return 'unknown';
  }

  return existsSync(path.join(detectedKitRoot, relativePath)) ? 'ok' : 'missing';
}

function readPackageVersion(packageRoot: string): string {
  return readPackageJsonOrUndefined(packageRoot)?.version ?? '0.0.0';
}

function readPackageJsonOrUndefined(
  dir: string,
  options: { readonly strictParse?: boolean } = {},
): PackageJson | undefined {
  const packageJsonPath = path.join(dir, 'package.json');

  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;
  } catch (error) {
    if (options.strictParse === true) {
      throw new Error(`Failed to parse ${packageJsonPath}: ${formatError(error)}`);
    }

    return undefined;
  }
}

function findAncestor(
  startDir: string,
  predicate: (dir: string) => boolean,
): string | undefined {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (predicate(currentDir)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}

function listTemplateCompletionItems() {
  return [
    {
      value: 'create',
      description: 'Create a Phaser starter',
    },
  ];
}

function listTargetCompletionItems() {
  return [...supportedBuildTargets].map((target) => ({
    value: target,
    description: `Target ${target}`,
  }));
}

function readCliLocale(): string {
  const rawLocale = process.env.MPGD_LOCALE ?? process.env.LANG ?? 'en-US';
  const normalized = rawLocale.split('.')[0]?.replace('_', '-');

  if (normalized === undefined || normalized.length === 0) {
    return 'en-US';
  }

  try {
    return new Intl.Locale(normalized).toString();
  } catch {
    return 'en-US';
  }
}

function pickLocalizedText(locale: Intl.Locale, text: LocalizedText): string {
  return locale.language === 'ko' ? text.ko : text.en;
}
