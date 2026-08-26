import { existsSync, readFileSync } from 'node:fs';

import {
  microsoftStoreBlockEnd,
  microsoftStoreBlockStart,
  microsoftStoreDocumentationAnchors,
} from '../packages/cli/src/microsoft-store-starter';

interface StarterAgentManifest {
  readonly id?: unknown;
  readonly version?: unknown;
  readonly engine?: unknown;
  readonly targets?: unknown;
  readonly futureTargets?: unknown;
  readonly agentWorkflow?: {
    readonly brief?: unknown;
    readonly acceptance?: unknown;
    readonly mcp?: unknown;
  };
  readonly blocks?: unknown;
  readonly acceptance?: {
    readonly commands?: unknown;
    readonly manual?: unknown;
  };
}

interface StarterBlock {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly entry?: unknown;
  readonly capabilities?: unknown;
  readonly gotchas?: unknown;
}

interface StarterMcpRequirement {
  readonly target?: unknown;
  readonly server?: unknown;
  readonly queries?: unknown;
}

interface McpConfig {
  readonly mcpServers?: unknown;
}

interface McpServerConfig {
  readonly command?: unknown;
  readonly args?: unknown;
}

interface AitNavigationTargetsConfig {
  readonly targets?: {
    readonly ait?: {
      readonly navigationBar?: {
        readonly withBackButton?: unknown;
        readonly withHomeButton?: unknown;
        readonly withTitle?: unknown;
        readonly transparentBackground?: unknown;
        readonly theme?: unknown;
      };
    };
  };
}

const aitWebFrameworkVersion = '3.1.1';
const aitCliVersion = '3.1.1';
const aitWebFrameworkPeerRange = '>=3.0.0 <4';
const aitDevtoolsPeerSelector = '@ait-co/devtools>@apps-in-toss/web-framework';
const aitXmldomOverrideVersion = '0.9.12';

const requiredFiles = [
  '.mcp.json',
  '.codex/config.toml',
  '.codex/agents/codebase-explorer.toml',
  '.codex/agents/phaser-scene-builder.toml',
  '.codex/agents/game-block-author.toml',
  '.codex/agents/platform-adapter-author.toml',
  '.codex/agents/apps-in-toss-integrator.toml',
  '.codex/agents/monetization-guard.toml',
  '.codex/agents/reviewer.toml',
  '.agents/skills/create-game-block/SKILL.md',
  '.agents/skills/evolve-phaser-starter/SKILL.md',
  '.agents/skills/add-platform-adapter/SKILL.md',
  '.agents/skills/validate-agentic-game-workflow/SKILL.md',
  'docs/AGENTIC_GAME_WORKFLOW.md',
  'examples/phaser-starter/AGENTS.md',
  'examples/phaser-starter/agent/brief.template.md',
  'examples/phaser-starter/agent/acceptance.md',
  'examples/phaser-starter/agent/game.manifest.schema.json',
  'examples/phaser-starter/agent/game.manifest.json',
  'examples/phaser-starter/mpgd.game.json',
  'examples/phaser-starter/vite.runtime-target-config.ts',
  'packages/cli/templates/phaser-game/AGENTS.md',
  'packages/cli/templates/phaser-game/.agents/skills/use-mpgd-kit/SKILL.md',
  'packages/cli/templates/phaser-game/.agents/skills/use-mpgd-kit/agents/openai.yaml',
  'packages/cli/templates/phaser-game/.agents/skills/release-microsoft-store/SKILL.md',
  'packages/cli/templates/phaser-game/.agents/skills/release-microsoft-store/agents/openai.yaml',
  'packages/cli/templates/phaser-game/docs/MPGD_KIT_WORKFLOWS.md',
  'packages/cli/templates/phaser-game/agent/game-manifest.json',
  'packages/cli/templates/phaser-game/mpgd.game.json',
  'packages/cli/templates/phaser-game/vite.runtime-target-config.ts',
] as const;

const requiredAitQueries = [
  '웹뷰 개발',
  '인앱 결제',
  '인앱 광고',
  '샌드박스',
  '심사',
  '저장소',
] as const;
const requiredDevvitQueries = [
  'Devvit Web',
  'devvit.json',
  'Vite',
  'Redis',
  'playtest',
  'payments',
] as const;
const expectedDevvitVersion = '0.14.1';
/** Verified Vite baseline for generated games and kit targets. */
const expectedViteVersion = '8.1.3';
/** Devvit 0.14.x targets pin Vite 7 for compatibility with @devvit/start. */
const expectedDevvitTargetViteVersion = '7.3.6';
/** Starter configs that must keep the baseline gameplay evidence plan. */
const gameplayE2EConfigPaths = [
  'examples/phaser-starter/mpgd.game.json',
  'packages/cli/templates/phaser-game/mpgd.game.json',
] as const;
/** Starter handoff docs that must explain the optional gameplay E2E step. */
const gameplayE2EDocumentationPaths = [
  'examples/phaser-starter/agent/acceptance.md',
  'packages/cli/templates/phaser-game/README.md',
  'packages/cli/templates/phaser-game/agent/acceptance.md',
] as const;
/** Generic starter states required in both checked manifests. */
const requiredGameplayE2EStateIds = ['launch-ready', 'primary-input', 'resume-session'] as const;
type GameplayE2EConfigPath = (typeof gameplayE2EConfigPaths)[number];
const requiredMcpRequirements = [
  {
    target: 'ait',
    server: 'apps-in-toss',
    queries: requiredAitQueries,
    name: 'Apps in Toss',
  },
  {
    target: 'reddit',
    server: 'devvit',
    queries: requiredDevvitQueries,
    name: 'Devvit',
  },
] as const;

const failures: string[] = [];
validatePeerDependencyRuleParser();

for (const file of requiredFiles) {
  if (!existsSync(file)) {
    failures.push(`Missing starter workflow file: ${file}`);
  }
}

const existingFiles = new Set(requiredFiles.filter((file) => existsSync(file)));

for (const skillFile of requiredFiles.filter(
  (file) => file.endsWith('/SKILL.md') && existingFiles.has(file),
)) {
  validateSkillFrontmatter(skillFile);
}

for (const agentFile of requiredFiles.filter(
  (file) => file.startsWith('.codex/agents/') && existingFiles.has(file),
)) {
  validateAgentDefinition(agentFile);
}

if (existingFiles.has('.mcp.json')) {
  validateMcpConfig('.mcp.json');
}

const manifestPath = 'examples/phaser-starter/agent/game.manifest.json';
const manifest = existingFiles.has(manifestPath)
  ? readJson(manifestPath) as StarterAgentManifest | null
  : null;

if (manifest !== null) {
  assertString(manifest.id, `${manifestPath}: id`);
  assertString(manifest.version, `${manifestPath}: version`);
  assertEqual(manifest.engine, 'phaser-4', `${manifestPath}: engine`);
  assertStringArray(manifest.targets, `${manifestPath}: targets`);
  assertIncludes(manifest.targets, 'ait', `${manifestPath}: targets`);
  assertIncludes(manifest.targets, 'web-preview', `${manifestPath}: targets`);
  assertIncludes(manifest.targets, 'microsoft-store', `${manifestPath}: targets`);
  assertIncludes(manifest.targets, 'verse8', `${manifestPath}: targets`);
  assertIncludes(manifest.targets, 'reddit', `${manifestPath}: targets`);
  assertStringArray(manifest.futureTargets, `${manifestPath}: futureTargets`);
  assertIncludes(manifest.futureTargets, 'telegram', `${manifestPath}: futureTargets`);

  assertString(manifest.agentWorkflow?.brief, `${manifestPath}: agentWorkflow.brief`);
  assertString(manifest.agentWorkflow?.acceptance, `${manifestPath}: agentWorkflow.acceptance`);
  assertMcpRequirements(manifest.agentWorkflow?.mcp, `${manifestPath}: agentWorkflow.mcp`);
  assertBlocks(manifest.blocks, `${manifestPath}: blocks`);
  assertStringArray(manifest.acceptance?.commands, `${manifestPath}: acceptance.commands`);
  assertIncludes(
    manifest.acceptance?.commands,
    'pnpm validate:starter-workflow',
    `${manifestPath}: acceptance.commands`,
  );
  assertIncludes(
    manifest.acceptance?.commands,
    'pnpm check',
    `${manifestPath}: acceptance.commands`,
  );
}

validatePhaserTemplateAITPolyfill();
validateCheckedInAITWrapperNavigation();
validatePhaserTemplateAITWrapper();
validatePhaserTemplateAITConsoleCli();
validatePhaserTemplateDevvitPostOperations();
validatePhaserTemplateDevvitViewModes();
validatePhaserTemplateDevvitVitePlugin();
validatePhaserTemplateBuildGateways();
validatePhaserTemplateMicrosoftStorePwa();
validatePhaserTemplateOrientationPolicy();
validatePhaserTemplateSafeAreaContract();
validatePhaserTemplateLocalePolicy();
validatePhaserTemplateRewardAuthority();
validatePhaserTemplateAcceptanceCommand();
validateGeneratedConsumerWorkflow();
validateGeneratedViteVersionPins();
validateGeneratedViteConfigTyping();
validateGameplayE2EPlan();
validateAppIconPipeline();

if (failures.length > 0) {
  throw new Error(`Starter workflow validation failed:\n- ${failures.join('\n- ')}`);
}

console.log('Starter workflow validation passed.');

function validateGeneratedConsumerWorkflow(): void {
  const templateRoot = 'packages/cli/templates/phaser-game';
  const agentsFile = `${templateRoot}/AGENTS.md`;
  const workflowFile = `${templateRoot}/docs/MPGD_KIT_WORKFLOWS.md`;
  const routerSkill = `${templateRoot}/.agents/skills/use-mpgd-kit/SKILL.md`;
  const storeSkill = `${templateRoot}/.agents/skills/release-microsoft-store/SKILL.md`;
  const manifestFile = `${templateRoot}/agent/game-manifest.json`;
  const manifest = readJson(manifestFile);

  if (!isJsonObject(manifest)) {
    failures.push(`${manifestFile}: must be a JSON object.`);
  } else {
    const workflow = manifest.agentWorkflow;

    if (!isJsonObject(workflow)) {
      failures.push(`${manifestFile}: agentWorkflow must be a JSON object.`);
    } else {
      assertEqual(workflow.guide, 'docs/MPGD_KIT_WORKFLOWS.md', `${manifestFile}: guide`);
      assertEqual(
        workflow.routerSkill,
        '.agents/skills/use-mpgd-kit/SKILL.md',
        `${manifestFile}: router skill`,
      );
      const targetSkills = workflow.targetSkills;

      if (!isJsonObject(targetSkills)) {
        failures.push(`${manifestFile}: agentWorkflow.targetSkills must be a JSON object.`);
      } else {
        assertEqual(
          targetSkills['microsoft-store'],
          '.agents/skills/release-microsoft-store/SKILL.md',
          `${manifestFile}: Microsoft Store skill`,
        );
      }
    }
  }

  const agentsContent = readText(agentsFile);
  for (const requiredText of [
    '.agents/skills/use-mpgd-kit/SKILL.md',
    'PlatformGateway',
    'backend',
    'pnpm accept',
  ]) {
    assertIncludesText(agentsContent, requiredText, `${agentsFile}: consumer routing`);
  }

  const workflowContent = readText(workflowFile);
  for (const requiredText of [
    'Assets and icons',
    'Localization and orientation',
    'Analytics, saves, commerce, ads, and leaderboards',
    'Microsoft Store',
    'Verse8',
    'Apps in Toss',
    'Reddit Devvit',
    'Android and iOS',
    'target init microsoft-store',
    'pnpm accept',
  ]) {
    assertIncludesText(workflowContent, requiredText, `${workflowFile}: capability map`);
  }

  const routerContent = readText(routerSkill);
  for (const requiredText of [
    'agent/game-manifest.json',
    'docs/MPGD_KIT_WORKFLOWS.md',
    'PlatformGateway',
    'backend',
    'pnpm accept',
  ]) {
    assertIncludesText(routerContent, requiredText, `${routerSkill}: workflow router`);
  }

  const storeContent = readText(storeSkill);
  for (const requiredText of [
    'build:microsoft-store',
    'preflight:microsoft-store',
    'package:microsoft-store',
    'accept-package microsoft-store',
    'WACK as optional',
  ]) {
    assertIncludesText(storeContent, requiredText, `${storeSkill}: release workflow`);
  }

  for (const [relativePath, anchor] of Object.entries(microsoftStoreDocumentationAnchors)) {
    assertSingleMicrosoftStoreBlock(`${templateRoot}/${relativePath}`, anchor);
  }
}

function validateGeneratedViteVersionPins(): void {
  const expectedVersionsByPackagePath = {
    'apps/target-devvit/package.json': expectedDevvitTargetViteVersion,
    'examples/phaser-starter/package.json': expectedViteVersion,
    'packages/cli/templates/phaser-game/package.json': expectedViteVersion,
    'packages/cli/templates/phaser-game/apps/target-ait/package.json': expectedViteVersion,
    'packages/cli/templates/phaser-game/apps/target-cloudflare-pages/package.json':
      expectedViteVersion,
    'packages/cli/templates/phaser-game/apps/target-devvit/package.json':
      expectedDevvitTargetViteVersion,
  } as const;

  for (const [packagePath, expectedVersion] of Object.entries(expectedVersionsByPackagePath)) {
    const packageJson = readJson(packagePath) as {
      readonly devDependencies?: Record<string, unknown>;
    } | null;
    const viteVersion = packageJson?.devDependencies?.vite;

    assertString(viteVersion, `${packagePath}: devDependencies.vite`);

    if (typeof viteVersion !== 'string') {
      continue;
    }

    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(viteVersion)) {
      failures.push(
        `${packagePath}: devDependencies.vite must pin the verified Vite version exactly.`,
      );
      continue;
    }

    assertEqual(
      viteVersion,
      expectedVersion,
      `${packagePath}: devDependencies.vite must match the verified Vite baseline (${expectedVersion})`,
    );
  }
}

function validateGeneratedViteConfigTyping(): void {
  const configPaths = [
    'examples/phaser-starter/vite.shared.ts',
    'packages/cli/templates/phaser-game/vite.shared.ts',
  ] as const;

  for (const configPath of configPaths) {
    const content = readText(configPath);

    assertIncludesText(
      content,
      'as unknown as SharedPluginOption',
      `${configPath}: bounded unplugin type`,
    );
  }
}

function assertSingleMicrosoftStoreBlock(file: string, anchor: string | undefined): void {
  const content = readText(file);
  const startCount = content.split(microsoftStoreBlockStart).length - 1;
  const endCount = content.split(microsoftStoreBlockEnd).length - 1;
  const startIndex = content.indexOf(microsoftStoreBlockStart);
  const endIndex = content.indexOf(microsoftStoreBlockEnd);
  const ordered = startIndex >= 0 && endIndex > startIndex;

  if (
    startCount !== 1
    || endCount !== 1
    || !ordered
    || content.slice(startIndex + microsoftStoreBlockStart.length, endIndex).trim().length === 0
  ) {
    failures.push(`${file}: must contain one ordered, non-empty Microsoft Store managed block.`);
  }

  if (anchor !== undefined && content.split(anchor).length - 1 !== 1) {
    failures.push(`${file}: Microsoft Store insertion anchor must appear exactly once: ${anchor}`);
  }
}

function validatePhaserTemplateAcceptanceCommand(): void {
  const templateRoot = 'packages/cli/templates/phaser-game';
  const packageFile = `${templateRoot}/package.json`;
  const acceptanceFile = `${templateRoot}/agent/acceptance.md`;
  const manifestFile = `${templateRoot}/agent/game-manifest.json`;
  const runnerFile = `${templateRoot}/tools/run-game-acceptance.mjs`;
  const packageJson = readJson(packageFile);
  const scripts = isJsonObject(packageJson) && isJsonObject(packageJson.scripts)
    ? packageJson.scripts
    : null;
  const acceptScript = scripts?.accept;

  if (acceptScript !== 'node ./tools/run-game-acceptance.mjs') {
    failures.push(`${packageFile}: must expose the reusable mpgd game accept command.`);
  }

  const runnerSource = readText(runnerFile);

  if (
    !runnerSource.includes("import { runMpgdCli } from '@mpgd/cli'")
    || !runnerSource.includes('configuredKitPath.length === 0')
    || !runnerSource.includes("? '__DEFAULT_KIT_PATH__'")
    || !runnerSource.includes('...process.argv.slice(2)')
  ) {
    failures.push(
      `${runnerFile}: must call the CLI API directly and resolve empty or missing kit paths without shell expansion.`,
    );
  }

  for (const file of [acceptanceFile, manifestFile]) {
    if (!readText(file).includes('pnpm accept')) {
      failures.push(`${file}: must use the reusable pnpm accept handoff command.`);
    }
  }
}

/** Keeps the example and generated starter on the same gameplay evidence contract. */
function validateGameplayE2EPlan(): void {
  for (const configPath of gameplayE2EConfigPaths) {
    validateGameplayE2EConfig(configPath);
  }

  for (const documentationPath of gameplayE2EDocumentationPaths) {
    assertIncludesText(
      readText(documentationPath),
      'gameplay:e2e',
      `${documentationPath}: must describe the optional target gameplay E2E contract.`,
    );
  }
}

/** Validates one starter config without assuming a game-specific implementation. */
function validateGameplayE2EConfig(configPath: GameplayE2EConfigPath): void {
  const config = readJson(configPath) as {
    readonly acceptance?: {
      readonly gameplay?: {
        readonly schemaVersion?: unknown;
        readonly states?: unknown;
      };
    };
  } | null;
  const gameplay = config?.acceptance?.gameplay;

  if (gameplay?.schemaVersion !== 1) {
    failures.push(`${configPath}: acceptance.gameplay.schemaVersion must be 1.`);
  }

  if (!Array.isArray(gameplay?.states)) {
    failures.push(`${configPath}: acceptance.gameplay.states must be an array.`);
    return;
  }

  const states = gameplay.states.filter(isJsonObject);
  const stateIds = states.map((state) => state.id);

  for (const stateId of requiredGameplayE2EStateIds) {
    assertIncludes(stateIds, stateId, `${configPath}: acceptance.gameplay.states`);
  }

  const resumeState = states.find((state) => state.id === 'resume-session');
  const resumeActions = Array.isArray(resumeState?.actions)
    ? resumeState.actions.filter(isJsonObject)
    : [];
  const pauseResume = resumeActions.find((action) => action.type === 'pause-resume');

  if (pauseResume?.expectSameSession !== true) {
    failures.push(`${configPath}: resume-session must verify session continuity.`);
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePhaserTemplateMicrosoftStorePwa(): void {
  const exampleRoot = 'examples/phaser-starter';
  const templateRoot = 'packages/cli/templates/phaser-game';
  const runtimePath = 'src/platform/microsoftStorePwa.ts';
  const exampleRuntime = `${exampleRoot}/${runtimePath}`;
  const templateRuntime = `${templateRoot}/${runtimePath}`;

  if (!existsSync(exampleRuntime) || !existsSync(templateRuntime)) {
    failures.push('Starter and template must include the Microsoft Store PWA runtime helper.');
    return;
  } else if (readText(exampleRuntime) !== readText(templateRuntime)) {
    failures.push(`${templateRuntime}: must stay in parity with ${exampleRuntime}.`);
  }

  for (const root of [exampleRoot, templateRoot]) {
    const mainPath = `${root}/src/main.ts`;
    const pwaManifestPath = `${root}/public/manifest.webmanifest`;
    const main = readText(mainPath);
    const pwaManifest = readJson(pwaManifestPath) as {
      readonly id?: unknown;
      readonly scope?: unknown;
      readonly start_url?: unknown;
    } | null;

    assertIncludesText(
      main,
      "import { installMicrosoftStorePwa } from './platform/microsoftStorePwa'",
      `${mainPath}: Microsoft Store PWA registration.`,
    );
    assertIncludesText(
      main,
      'installMicrosoftStorePwa(runtimeConfig)',
      `${mainPath}: Microsoft Store PWA registration.`,
    );

    if (pwaManifest !== null) {
      assertEqual(
        pwaManifest.id,
        root === exampleRoot ? './mpgd-phaser-starter' : './__GAME_NAME__',
        `${pwaManifestPath}: stable game-specific PWA id`,
      );
      assertEqual(pwaManifest.scope, './', `${pwaManifestPath}: relative PWA scope`);
      assertEqual(pwaManifest.start_url, './', `${pwaManifestPath}: relative PWA start URL`);
    }
  }

  const readme = readText(`${templateRoot}/README.md`);

  for (const requiredText of [
    '`pwa-release.json`',
    '`service-worker.js`',
    '`mpgd:pwa-update-ready`',
    '`skipWaiting()`',
  ]) {
    assertIncludesText(readme, requiredText, 'Phaser template Microsoft Store PWA guidance.');
  }
}

function validatePhaserTemplateBuildGateways(): void {
  const exampleRoot = 'examples/phaser-starter';
  const templateRoot = 'packages/cli/templates/phaser-game';
  const runtimeValidatorFile = 'vite.runtime-target-config.ts';

  if (
    readText(`${exampleRoot}/${runtimeValidatorFile}`)
    !== readText(`${templateRoot}/${runtimeValidatorFile}`)
  ) {
    failures.push(
      `${templateRoot}/${runtimeValidatorFile}: must stay in parity with ${exampleRoot}/${runtimeValidatorFile}.`,
    );
  }

  const gatewayFiles = [
    'src/platform/buildGatewayModule.ts',
    'src/platform/buildGateways/browser.ts',
    'src/platform/buildGateways/capacitorAndroid.ts',
    'src/platform/buildGateways/capacitorIos.ts',
    'src/platform/buildGateways/ait.ts',
    'src/platform/buildGateways/aitSandbox.ts',
    'src/platform/buildGateways/reddit.ts',
    'src/platform/buildGateways/redditSandbox.ts',
    'src/platform/buildGateways/verse8.ts',
    'src/platform/buildGateways/microsoftStore.ts',
  ] as const;

  for (const relativePath of gatewayFiles) {
    const examplePath = `${exampleRoot}/${relativePath}`;
    const templatePath = `${templateRoot}/${relativePath}`;

    if (!existsSync(examplePath)) {
      failures.push(`${examplePath}: required for target-isolated gateway builds.`);
      continue;
    }

    if (!existsSync(templatePath)) {
      failures.push(`${templatePath}: required for target-isolated gateway builds.`);
      continue;
    }

    const exampleText = readText(examplePath);
    const templateText = readText(templatePath);

    if (exampleText !== templateText) {
      failures.push(`${templatePath}: must stay in parity with ${examplePath}.`);
    }

    if (
      relativePath.startsWith('src/platform/buildGateways/')
      && !exampleText.includes('export async function createBuildGateway')
    ) {
      failures.push(`${examplePath}: must export the build gateway contract.`);
    }
  }

  for (const root of [exampleRoot, templateRoot]) {
    const vitePath = `${root}/vite.shared.ts`;
    const installPath = `${root}/src/platform/${
      root === exampleRoot ? 'installStarterPlatform.ts' : 'installPlatform.ts'
    }`;

    for (const requiredText of [
      "'#mpgd-platform-gateway': resolve(input.gameRoot, buildGatewayModule)",
      'export function resolveBuildGatewayModule',
      "return 'src/platform/buildGateways/browser.ts'",
      "'src/platform/buildGateways/aitSandbox.ts'",
      "'src/platform/buildGateways/redditSandbox.ts'",
      "'src/platform/buildGateways/verse8.ts'",
      "'src/platform/buildGateways/microsoftStore.ts'",
    ]) {
      assertIncludesText(readText(vitePath), requiredText, `${vitePath}: build gateway isolation.`);
    }

    assertIncludesText(
      readText(installPath),
      "import { createBuildGateway } from '#mpgd-platform-gateway'",
      `${installPath}: build-selected gateway.`,
    );
  }
}

function validateAppIconPipeline(): void {
  for (const path of [
    'examples/phaser-starter/mpgd.game.json',
    'packages/cli/templates/phaser-game/mpgd.game.json',
  ]) {
    const config = readJson(path) as {
      readonly brand?: { readonly appIcon?: { readonly source?: unknown } };
    } | null;

    if (config !== null) {
      assertString(config.brand?.appIcon?.source, `${path}: brand.appIcon.source`);
    }
  }

  for (const path of [
    'examples/phaser-starter/mpgd.targets.json',
    'packages/cli/templates/phaser-game/mpgd.targets.json',
  ]) {
    const config = readJson(path) as {
      readonly targets?: Record<string, { readonly icon?: { readonly profile?: unknown } }>;
    } | null;

    if (config === null || config.targets === undefined) {
      continue;
    }

    for (const [target, targetConfig] of Object.entries(config.targets)) {
      assertString(targetConfig.icon?.profile, `${path}: ${target}.icon.profile`);
    }
  }

  for (const path of [
    'apps/target-devvit/devvit.json',
    'packages/cli/templates/phaser-game/apps/target-devvit/devvit.json',
  ]) {
    const config = readJson(path) as {
      readonly marketingAssets?: { readonly icon?: unknown };
    } | null;

    if (config !== null) {
      assertEqual(
        config.marketingAssets?.icon,
        'generated/marketing-icon.png',
        `${path}: marketingAssets.icon`,
      );
    }
  }

  const packagePath = 'packages/cli/templates/phaser-game/package.json';
  const packageJson = readJson(packagePath) as {
    readonly scripts?: Record<string, unknown>;
  } | null;

  for (const script of [
    'icons:generate',
    'icons:generate:devvit',
    'icons:generate:devvit:production',
    'icons:verify',
    'icons:inspect',
  ]) {
    assertString(packageJson?.scripts?.[script], `${packagePath}: scripts.${script}`);
  }

  const devvitPackagePath =
    'packages/cli/templates/phaser-game/apps/target-devvit/package.json';
  const devvitPackageJson = readJson(devvitPackagePath) as {
    readonly scripts?: Record<string, unknown>;
  } | null;

  assertEqual(
    devvitPackageJson?.scripts?.['prepare:icon'],
    'pnpm --dir ../.. icons:generate:devvit',
    `${devvitPackagePath}: scripts.prepare:icon`,
  );
  assertEqual(
    devvitPackageJson?.scripts?.['prepare:icon:production'],
    'pnpm --dir ../.. icons:generate:devvit:production',
    `${devvitPackagePath}: scripts.prepare:icon:production`,
  );

  for (const script of ['init', 'init:copy-paste', 'upload', 'publish']) {
    const command = devvitPackageJson?.scripts?.[script];
    assertString(command, `${devvitPackagePath}: scripts.${script}`);

    if (
      typeof command === 'string'
      && !command.startsWith('pnpm run prepare:icon:production && ')
    ) {
      failures.push(`${devvitPackagePath}: scripts.${script} must prepare a production icon.`);
    }
  }

  const devCommand = devvitPackageJson?.scripts?.dev;
  assertString(devCommand, `${devvitPackagePath}: scripts.dev`);

  if (typeof devCommand === 'string' && !devCommand.startsWith('pnpm run prepare:icon && ')) {
    failures.push(`${devvitPackagePath}: scripts.dev must prepare a development icon.`);
  }
}

function validateSkillFrontmatter(path: string): void {
  const content = readText(path);
  const match = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---/.exec(content);

  if (match?.groups === undefined) {
    failures.push(`${path}: missing YAML frontmatter.`);
    return;
  }

  const frontmatter = match.groups.frontmatter ?? '';
  if (!/^name: .+$/m.test(frontmatter)) {
    failures.push(`${path}: missing skill name.`);
  }
  if (!/^description: .+$/m.test(frontmatter)) {
    failures.push(`${path}: missing skill description.`);
  }
}

function validateAgentDefinition(path: string): void {
  const content = readText(path);

  for (const key of ['name', 'description', 'developer_instructions']) {
    if (!new RegExp(`^${key}\\s*=`, 'm').test(content)) {
      failures.push(`${path}: missing ${key}.`);
    }
  }
}

function validateMcpConfig(path: string): void {
  const config = readJson(path) as McpConfig | null;

  if (config === null) {
    return;
  }

  if (typeof config.mcpServers !== 'object' || config.mcpServers === null) {
    failures.push(`${path}: mcpServers must be an object.`);
    return;
  }

  const servers = config.mcpServers as Record<string, McpServerConfig>;

  assertMcpServerCommand(servers['ttsc-graph'], '@ttsc/graph', `${path}: ttsc-graph`);
  assertMcpServerCommand(servers.devvit, '@devvit/mcp', `${path}: devvit`);
}

function validatePhaserTemplateAITPolyfill(): void {
  const packagePath = 'packages/cli/templates/phaser-game/package.json';
  const mainPath = 'packages/cli/templates/phaser-game/src/main.ts';
  const workspacePath = 'packages/cli/templates/phaser-game/pnpm-workspace.yaml';
  const readmePath = 'packages/cli/templates/phaser-game/README.md';

  if (!existsSync(packagePath)) {
    failures.push(`${packagePath}: required for the AIT polyfill starter flow.`);
  } else {
    const packageJson = readJson(packagePath) as { readonly dependencies?: Record<string, unknown> }
      | null;

    if (packageJson !== null) {
      assertString(
        packageJson.dependencies?.['@ait-co/polyfill'],
        `${packagePath}: dependencies.@ait-co/polyfill`,
      );
      assertEqual(
        packageJson.dependencies?.['@apps-in-toss/web-framework'],
        aitWebFrameworkVersion,
        `${packagePath}: dependencies.@apps-in-toss/web-framework`,
      );
    }
  }

  if (!existsSync(mainPath)) {
    failures.push(`${mainPath}: required for the AIT polyfill starter flow.`);
  } else {
    const initialFailureCount = failures.length;
    const mainContent = readText(mainPath);

    if (failures.length === initialFailureCount) {
      const polyfillImportIndex = mainContent.search(/await\s+import\('@ait-co\/polyfill'\)/);
      const aitTargetGateIndex =
        polyfillImportIndex === -1
          ? -1
          : findWrappingBlockPatternIndex(
              mainContent,
              /if\s*\(\s*__APP_TARGET__\s*===\s*['"]ait['"]\s*\)/g,
              polyfillImportIndex,
            );
      const installDestructureIndex = mainContent.search(
        /const\s+\{\s*install\s*\}\s*=\s*await\s+import\('@ait-co\/polyfill'\)/,
      );
      const installCallIndex =
        installDestructureIndex === -1
          ? -1
          : findPatternIndex(mainContent, /await\s+install\(\)/, installDestructureIndex);
      const polyfillInstallIndex =
        installDestructureIndex !== -1 && installCallIndex !== -1 ? installCallIndex : -1;
      const bootstrapIndex = mainContent.indexOf('await bootstrap();');
      const runtimeDetectionIndex = mainContent.indexOf('detectRuntime();');

      if (polyfillImportIndex === -1) {
        failures.push(`${mainPath}: must dynamically import @ait-co/polyfill for AIT builds.`);
      } else if (aitTargetGateIndex === -1) {
        failures.push(`${mainPath}: must gate @ait-co/polyfill to AIT target.`);
      }
      if (polyfillInstallIndex === -1) {
        failures.push(`${mainPath}: must await @ait-co/polyfill install before bootstrap work.`);
      }
      if (bootstrapIndex === -1) {
        failures.push(
          `${mainPath}: must call await bootstrap() for the AIT polyfill starter flow.`,
        );
      }
      if (runtimeDetectionIndex === -1) {
        failures.push(`${mainPath}: must call detectRuntime() after polyfill install.`);
      } else if (polyfillInstallIndex !== -1 && polyfillInstallIndex > runtimeDetectionIndex) {
        failures.push(`${mainPath}: polyfill install must precede runtime detection.`);
      }
    }
  }

  if (!existsSync(workspacePath)) {
    failures.push(`${workspacePath}: required for the AIT polyfill starter flow.`);
  } else {
    const initialFailureCount = failures.length;
    const workspace = readText(workspacePath);

    if (failures.length === initialFailureCount) {
      for (const requiredText of [
        "'@sentry/cli': true",
        "'@swc/core': true",
        'cloudflared: false',
        'esbuild: true',
        'protobufjs: true',
      ]) {
        if (!workspace.includes(requiredText)) {
          failures.push(`${workspacePath}: allowBuilds must include ${requiredText}.`);
        }
      }
      if (!workspace.includes(`'@xmldom/xmldom': '${aitXmldomOverrideVersion}'`)) {
        failures.push(
          `${workspacePath}: overrides must pin @xmldom/xmldom to `
            + `${aitXmldomOverrideVersion}.`,
        );
      }

      const actualAitDevtoolsPeerVersion = readAllowedPeerVersion(
        workspace,
        aitDevtoolsPeerSelector,
      );

      if (actualAitDevtoolsPeerVersion !== aitWebFrameworkVersion) {
        failures.push(
          `${workspacePath}: peerDependencyRules.allowedVersions must include `
            + `'${aitDevtoolsPeerSelector}': '${aitWebFrameworkVersion}'.`,
        );
      }
    }
  }

  if (!existsSync(readmePath)) {
    failures.push(`${readmePath}: required for the AIT polyfill starter flow.`);
  } else {
    const initialFailureCount = failures.length;
    const readme = readText(readmePath);

    if (failures.length === initialFailureCount) {
      for (const requiredText of [
        '@ait-co/polyfill',
        'install()',
        '@apps-in-toss/web-framework',
        '`__APP_TARGET__` is `ait',
        'navigator.clipboard',
        'apps-in-toss.config.ts',
      ]) {
        if (!readme.includes(requiredText)) {
          failures.push(`${readmePath}: must document ${requiredText} for the AIT polyfill flow.`);
        }
      }
    }
  }
}

function validatePhaserTemplateAITConsoleCli(): void {
  const packagePath = 'packages/cli/templates/phaser-game/package.json';
  const readmePath = 'packages/cli/templates/phaser-game/README.md';

  if (!existsSync(packagePath)) {
    failures.push(`${packagePath}: required for the AIT console CLI starter flow.`);
  } else {
    const packageJson = readJson(packagePath) as {
      readonly devDependencies?: Record<string, unknown>;
      readonly scripts?: Record<string, unknown>;
    } | null;

    if (packageJson !== null) {
      assertString(
        packageJson.devDependencies?.['@ait-co/console-cli'],
        `${packagePath}: devDependencies.@ait-co/console-cli`,
      );

      for (const [scriptName, scriptValue] of Object.entries({
        'build:ait:package':
          'pnpm exec mpgd target build ait production --targets-file ./mpgd.targets.json --kit-path ${MPGD_KIT_PATH:-__DEFAULT_KIT_PATH__}',
        'ait:console:login': 'aitcc login',
        'ait:console:whoami': 'aitcc whoami',
        'ait:console:init': 'aitcc app init',
        'ait:console:register': 'aitcc app register',
        'ait:console:status': 'aitcc app status',
        'ait:console:deploy': 'aitcc app deploy',
      })) {
        assertEqual(
          packageJson.scripts?.[scriptName],
          scriptValue,
          `${packagePath}: ${scriptName}`,
        );
      }
    }
  }

  if (!existsSync(readmePath)) {
    failures.push(`${readmePath}: required for the AIT console CLI starter flow.`);
  } else {
    const initialFailureCount = failures.length;
    const readme = readText(readmePath);

    if (failures.length === initialFailureCount) {
      for (const requiredText of [
        '@ait-co/console-cli',
        'aitcc.yaml',
        'pnpm ait:console:login',
        'pnpm ait:console:whoami',
        'pnpm ait:console:init',
        'pnpm ait:console:register',
        'pnpm ait:console:status',
        'pnpm build:ait:package',
        'pnpm ait:console:deploy -- release-output/ait/YOUR_APP.ait',
        './assets/',
      ]) {
        if (!readme.includes(requiredText)) {
          failures.push(`${readmePath}: must document ${requiredText} for the AIT console flow.`);
        }
      }
    }
  }
}

function validateCheckedInAITWrapperNavigation(): void {
  const wrapperConfigPath = 'apps/target-ait/apps-in-toss.config.ts';

  if (!existsSync(wrapperConfigPath)) {
    failures.push(`${wrapperConfigPath}: required for the checked-in AIT wrapper flow.`);
    return;
  }

  const content = readText(wrapperConfigPath);
  for (const requiredText of [
    'readNavigationBar(process.env.MPGD_AIT_NAVIGATION_BAR)',
    'navigationBar === undefined ? {} : { navigationBar }',
    "AppsInTossConfig['navigationBar']",
    'JSON.parse(encoded)',
  ]) {
    assertIncludesText(content, requiredText, wrapperConfigPath);
  }
}

function validatePhaserTemplateAITWrapper(): void {
  const templateRoot = 'packages/cli/templates/phaser-game';
  const wrapperRoot = `${templateRoot}/apps/target-ait`;
  const wrapperPackagePath = `${wrapperRoot}/package.json`;
  const wrapperMainPath = `${wrapperRoot}/src/main.ts`;
  const wrapperVitePath = `${wrapperRoot}/vite.config.ts`;
  const wrapperConfigPath = `${wrapperRoot}/apps-in-toss.config.ts`;
  const legacyWrapperConfigPath = `${wrapperRoot}/granite.config.ts`;
  const targetsPath = `${templateRoot}/mpgd.targets.json`;
  const rootPackagePath = `${templateRoot}/package.json`;
  const gitignorePath = `${templateRoot}/gitignore`;
  const adapterPackagePath = 'adapters/ait/package.json';
  const baseTsconfigPath = 'tsconfig.base.json';

  for (const path of [
    wrapperPackagePath,
    wrapperMainPath,
    wrapperVitePath,
    wrapperConfigPath,
    targetsPath,
    rootPackagePath,
    gitignorePath,
    adapterPackagePath,
    baseTsconfigPath,
  ]) {
    if (!existsSync(path)) {
      failures.push(`${path}: required for the game-owned AIT wrapper flow.`);
    }
  }

  if (existsSync(adapterPackagePath)) {
    const packageJson = readJson(adapterPackagePath) as {
      readonly exports?: Record<string, unknown>;
      readonly peerDependencies?: Record<string, unknown>;
      readonly devDependencies?: Record<string, unknown>;
    } | null;

    if (packageJson !== null) {
      assertEqual(
        packageJson.exports?.['./package.json'],
        './package.json',
        `${adapterPackagePath}: exports[./package.json]`,
      );
      assertEqual(
        packageJson.peerDependencies?.['@apps-in-toss/web-framework'],
        aitWebFrameworkPeerRange,
        `${adapterPackagePath}: peerDependencies.@apps-in-toss/web-framework`,
      );
      assertEqual(
        packageJson.devDependencies?.['@apps-in-toss/web-framework'],
        aitWebFrameworkVersion,
        `${adapterPackagePath}: devDependencies.@apps-in-toss/web-framework`,
      );

      for (const [subpath, basename] of [
        ['./ad-config', 'ad-config'],
        ['./host', 'host'],
        ['./local-mock', 'local-mock'],
        ['./wrapper', 'wrapper'],
      ] as const) {
        const exported = packageJson.exports?.[subpath];

        if (!isJsonObject(exported)) {
          failures.push(`${adapterPackagePath}: exports[${subpath}] must be an object.`);
          continue;
        }

        assertEqual(
          exported.types,
          `./dist/${basename}.d.ts`,
          `${adapterPackagePath}: exports[${subpath}].types`,
        );
        assertEqual(
          exported.default,
          `./dist/${basename}.js`,
          `${adapterPackagePath}: exports[${subpath}].default`,
        );
      }
    }
  }

  if (existsSync(baseTsconfigPath)) {
    const tsconfig = readJson(baseTsconfigPath) as {
      readonly compilerOptions?: {
        readonly paths?: Record<string, unknown>;
      };
    } | null;

    if (tsconfig !== null) {
      assertIncludes(
        tsconfig.compilerOptions?.paths?.['@mpgd/adapter-ait/package.json'],
        './adapters/ait/package.json',
        `${baseTsconfigPath}: compilerOptions.paths[@mpgd/adapter-ait/package.json]`,
      );
    }
  }

  if (existsSync(wrapperPackagePath)) {
    const packageJson = readJson(wrapperPackagePath) as {
      readonly dependencies?: Record<string, unknown>;
      readonly devDependencies?: Record<string, unknown>;
      readonly scripts?: Record<string, unknown>;
    } | null;

    if (packageJson !== null) {
      assertString(
        packageJson.dependencies?.['@mpgd/adapter-ait'],
        `${wrapperPackagePath}: dependencies.@mpgd/adapter-ait`,
      );
      assertEqual(
        packageJson.dependencies?.['@apps-in-toss/web-framework'],
        aitWebFrameworkVersion,
        `${wrapperPackagePath}: dependencies.@apps-in-toss/web-framework`,
      );
      assertEqual(
        packageJson.devDependencies?.['@apps-in-toss/cli'],
        aitCliVersion,
        `${wrapperPackagePath}: devDependencies.@apps-in-toss/cli`,
      );
      assertEqual(
        packageJson.scripts?.build,
        'vite build && ait build',
        `${wrapperPackagePath}: build`,
      );
    }
  }

  if (existsSync(wrapperMainPath)) {
    const content = readText(wrapperMainPath);
    for (const requiredText of [
      "from '@mpgd/adapter-ait/host'",
      "from '@mpgd/adapter-ait/wrapper'",
      'installAitHostBridge({',
      'mountAitGameBundle(app)',
    ]) {
      assertIncludesText(content, requiredText, wrapperMainPath);
    }
  }

  if (existsSync(wrapperVitePath)) {
    const content = readText(wrapperVitePath);
    for (const requiredText of [
      "from '@mpgd/adapter-ait/ad-config'",
      "'@apps-in-toss/web-framework': '@mpgd/adapter-ait/local-mock'",
      'MPGD_AIT_LOCAL_MOCK',
      '__MPGD_AIT_AD_GROUP_IDS__',
      '__MPGD_AIT_AD_PLACEMENT_TYPES__',
    ]) {
      assertIncludesText(content, requiredText, wrapperVitePath);
    }
  }

  if (existsSync(legacyWrapperConfigPath)) {
    failures.push(`${legacyWrapperConfigPath}: SDK 3 wrappers must not retain the SDK 2 config.`);
  }

  if (existsSync(wrapperConfigPath)) {
    const content = readText(wrapperConfigPath);
    for (const requiredText of [
      '__GAME_NAME__',
      'type AppsInTossConfig',
      "primaryColor: readEnvString(process.env.MPGD_AIT_PRIMARY_COLOR) ?? '#101820'",
      'readNavigationBar(process.env.MPGD_AIT_NAVIGATION_BAR)',
      'navigationBar === undefined ? {} : { navigationBar }',
      'webView: {',
      "webBundleDir: 'dist'",
    ]) {
      assertIncludesText(content, requiredText, wrapperConfigPath);
    }

    for (const legacyText of ['displayName:', 'icon:', 'webViewProps:', 'outdir:', 'web: {']) {
      if (content.includes(legacyText)) {
        failures.push(`${wrapperConfigPath}: must not contain SDK 2 field ${legacyText}`);
      }
    }
  }

  if (existsSync(targetsPath)) {
    const targets = readJson(targetsPath) as {
      readonly targets?: {
        readonly ait?: {
          readonly wrapperApp?: unknown;
          readonly webDir?: unknown;
          readonly metadata?: {
            readonly appName?: unknown;
            readonly displayName?: unknown;
            readonly primaryColor?: unknown;
            readonly sdkMajor?: unknown;
          };
        };
      };
    } | null;

    if (targets !== null) {
      assertEqual(
        targets.targets?.ait?.wrapperApp,
        'apps/target-ait',
        `${targetsPath}: targets.ait.wrapperApp`,
      );
      assertEqual(
        targets.targets?.ait?.webDir,
        'apps/target-ait/public/game',
        `${targetsPath}: targets.ait.webDir`,
      );
      assertEqual(
        targets.targets?.ait?.metadata?.appName,
        '__GAME_NAME__',
        `${targetsPath}: targets.ait.metadata.appName`,
      );
      assertEqual(
        targets.targets?.ait?.metadata?.displayName,
        '__GAME_TITLE__',
        `${targetsPath}: targets.ait.metadata.displayName`,
      );
      assertEqual(
        targets.targets?.ait?.metadata?.primaryColor,
        '#101820',
        `${targetsPath}: targets.ait.metadata.primaryColor`,
      );
      if (targets.targets?.ait?.metadata?.sdkMajor !== 3) {
        failures.push(`${targetsPath}: targets.ait.metadata.sdkMajor must be 3.`);
      }
    }
  }

  if (existsSync(rootPackagePath)) {
    const packageJson = readJson(rootPackagePath) as {
      readonly scripts?: Record<string, unknown>;
    } | null;

    if (packageJson !== null) {
      for (const [scriptName, scriptValue] of Object.entries({
        'dev:ait':
          "APP_TARGET=ait MPGD_CONFIG_TARGET=ait MPGD_PLATFORM_TARGETS_FILE=./mpgd.targets.json APP_VERSION=0.0.0-dev BUILD_ID=ait-sandbox sh -c '__WORKSPACE_I18N_BUILD_PREFIX__vite --host 0.0.0.0'",
        'ait:wrapper:dev': 'pnpm --dir apps/target-ait run dev',
        'ait:wrapper:dev:plain': 'pnpm --dir apps/target-ait run dev:plain',
      })) {
        assertEqual(
          packageJson.scripts?.[scriptName],
          scriptValue,
          `${rootPackagePath}: ${scriptName}`,
        );
      }
    }
  }

  if (existsSync(gitignorePath)) {
    const ignoredPaths = new Set(readText(gitignorePath).split(/\r?\n/u));

    for (const ignoredPath of [
      'apps/target-ait/.ait_relay',
      'apps/target-ait/.ait_urls',
      'apps/target-ait/generated/',
      'apps/target-ait/public/assets/',
      'apps/target-ait/public/game/',
    ]) {
      if (!ignoredPaths.has(ignoredPath)) {
        failures.push(`${gitignorePath}: must ignore ${ignoredPath}.`);
      }
    }

    if (ignoredPaths.has('apps/target-ait/.granite/')) {
      failures.push(`${gitignorePath}: must not retain the SDK 2 .granite cache path.`);
    }
  }
}

function validatePhaserTemplateDevvitPostOperations(): void {
  const kitPackagePath = 'apps/target-devvit/package.json';
  const kitStorePath = 'apps/target-devvit/src/server/postOperationStore.ts';
  const templatePackagePath =
    'packages/cli/templates/phaser-game/apps/target-devvit/package.json';
  const templateStorePath =
    'packages/cli/templates/phaser-game/apps/target-devvit/src/server/postOperationStore.ts';
  const templateReadmePath =
    'packages/cli/templates/phaser-game/apps/target-devvit/README.md';

  for (const [packagePath, expectedVersion] of [
    [kitPackagePath, 'workspace:*'],
    [templatePackagePath, '__MPGD_DEPENDENCY_VERSION_ADAPTER_DEVVIT__'],
  ] as const) {
    if (!existsSync(packagePath)) {
      failures.push(`${packagePath}: required for durable Devvit post operations.`);
      continue;
    }

    const packageJson = readJson(packagePath) as {
      readonly dependencies?: Record<string, unknown>;
    } | null;

    if (packageJson !== null) {
      assertEqual(
        packageJson.dependencies?.['@mpgd/adapter-devvit'],
        expectedVersion,
        `${packagePath}: dependencies.@mpgd/adapter-devvit`,
      );
    }
  }

  if (!existsSync(kitStorePath)) {
    failures.push(`${kitStorePath}: required for the Devvit Redis store wrapper.`);
  }
  if (!existsSync(templateStorePath)) {
    failures.push(`${templateStorePath}: required for the generated Devvit Redis store wrapper.`);
  }

  if (existsSync(kitStorePath) && existsSync(templateStorePath)) {
    const kitStore = readText(kitStorePath);
    const templateStore = readText(templateStorePath);

    if (kitStore !== templateStore) {
      failures.push(`${templateStorePath}: must stay in parity with ${kitStorePath}.`);
    }

    for (const requiredText of [
      "from '@devvit/web/server'",
      "from '@mpgd/adapter-devvit/server'",
      'createDevvitRedisPostOperationStore',
      'DevvitIndexedDurableOperationStore',
    ]) {
      assertIncludesText(
        templateStore,
        requiredText,
        `${templateStorePath}: durable post operation wrapper.`,
      );
    }
  }

  if (!existsSync(templateReadmePath)) {
    failures.push(`${templateReadmePath}: required for durable Devvit post operation guidance.`);
  } else {
    const readme = readText(templateReadmePath);

    for (const requiredText of [
      '## Durable Post Operations',
      'postOperationStore.ts',
      '@mpgd/adapter-devvit/server',
      '`reconciliation-required`',
      '`reconcile`',
      '`listPending()`',
    ]) {
      assertIncludesText(
        readme,
        requiredText,
        `${templateReadmePath}: durable post operation guidance.`,
      );
    }
  }
}

function validatePhaserTemplateDevvitViewModes(): void {
  const roots = ['packages/cli/templates/phaser-game', 'examples/phaser-starter'] as const;

  for (const root of roots) {
    const indexPath = `${root}/index.html`;
    const gameDocumentPath = `${root}/game.html`;
    const entryPath = `${root}/src/entry.ts`;
    const gameEntryPath = `${root}/src/gameEntry.ts`;
    const entryFailurePath = `${root}/src/runtime/renderEntryFailure.ts`;
    const mainPath = `${root}/src/main.ts`;
    const createGamePath = `${root}/src/runtime/createGame.ts`;
    const devvitEntryPath = `${root}/src/platform/devvitEntrypoint.ts`;
    const devvitStylePath = `${root}/src/platform/devvitInlineMode.css`;
    const vitePath = `${root}/vite.config.ts`;

    for (const path of [
      indexPath,
      gameDocumentPath,
      entryPath,
      gameEntryPath,
      entryFailurePath,
      mainPath,
      createGamePath,
      devvitEntryPath,
      devvitStylePath,
      vitePath,
    ]) {
      if (!existsSync(path)) {
        failures.push(`${path}: required for Devvit inline and expanded view modes.`);
      }
    }

    if (existsSync(indexPath)) {
      const source = readText(indexPath);
      assertIncludesText(source, '/src/entry.ts', `${indexPath}: platform entry.`);

      if (source.includes('/src/main.ts')) {
        failures.push(`${indexPath}: must not load the Phaser bootstrap directly.`);
      }
    }

    if (existsSync(gameDocumentPath)) {
      assertIncludesText(
        readText(gameDocumentPath),
        '/src/gameEntry.ts',
        `${gameDocumentPath}: expanded game entry.`,
      );
    }

    if (existsSync(entryPath)) {
      const source = readText(entryPath);
      for (const requiredText of [
        "__APP_TARGET__ === 'reddit'",
        "import('./main')",
        'renderEntryFailure(error)',
      ]) {
        assertIncludesText(source, requiredText, `${entryPath}: target-aware bootstrap.`);
      }
    }

    if (existsSync(gameEntryPath)) {
      const source = readText(gameEntryPath);
      for (const requiredText of ["import('./main')", 'renderEntryFailure(error)']) {
        assertIncludesText(source, requiredText, `${gameEntryPath}: Phaser bootstrap.`);
      }

      if (source.includes('getWebViewMode')) {
        failures.push(`${gameEntryPath}: expanded entry must not inspect Devvit web view mode.`);
      }
    }

    if (existsSync(entryFailurePath)) {
      const source = readText(entryFailurePath);

      for (const requiredText of [
        "querySelector<HTMLElement>('#game')",
        "setAttribute('role', 'alert')",
        'Failed to load the game. Please refresh and try again.',
      ]) {
        assertIncludesText(source, requiredText, `${entryFailurePath}: entry failure fallback.`);
      }
    }

    if (existsSync(devvitEntryPath)) {
      const source = readText(devvitEntryPath);
      for (const requiredText of [
        "from '@mpgd/adapter-devvit/web'",
        'startDevvitPreviewWebView',
        'mountInlinePreview',
        'loadExpandedGame',
        "await import('../main')",
        "requestDevvitExpandedMode(event, 'game')",
        'expandedRequestRecoveryMs',
        "recover('Full screen did not open. Try again.')",
      ]) {
        assertIncludesText(source, requiredText, `${devvitEntryPath}: Devvit view modes.`);
      }

      for (const forbiddenText of [
        'startDevvitWebView',
        'startDevvitViewMode',
        'mountInlineMode',
        'context.startGameplay()',
        'mountGameplayDocument()',
        'devvit-inline-gameplay-loading',
        "textContent = 'Play here'",
      ]) {
        if (source.includes(forbiddenText)) {
          failures.push(
            `${devvitEntryPath}: preview-only default must not contain ${forbiddenText}.`,
          );
        }
      }
    }

    if (existsSync(mainPath)) {
      assertIncludesText(
        readText(mainPath),
        'document.body.dataset.mpgdPreserveBrowserTouchGestures',
        `${mainPath}: inline mode touch policy.`,
      );
    }

    if (existsSync(createGamePath)) {
      const source = readText(createGamePath);

      for (const requiredText of [
        'preserveBrowserTouchGestures',
        'capture: input.preserveBrowserTouchGestures !== true',
      ]) {
        assertIncludesText(source, requiredText, `${createGamePath}: inline mode touch policy.`);
      }
    }

    if (existsSync(devvitStylePath)) {
      const source = readText(devvitStylePath);

      for (const requiredText of [
        'body.devvit-inline-mode-host',
        '.devvit-launch-screen',
        '.devvit-launch-screen__button',
        'position: fixed',
        'overflow: hidden',
        'touch-action: pan-y',
        '@media (max-height: 440px)',
      ]) {
        assertIncludesText(source, requiredText, `${devvitStylePath}: inline mode styles.`);
      }

      for (const forbiddenText of [
        'body.devvit-inline-mode-gameplay',
        '.devvit-inline-gameplay-loading',
      ]) {
        if (source.includes(forbiddenText)) {
          failures.push(`${devvitStylePath}: inline preview must not contain ${forbiddenText}.`);
        }
      }

      if (/overflow(?:-[xy])?:\s*(?:auto|scroll|overlay)/iu.test(source)) {
        failures.push(`${devvitStylePath}: inline preview must not create a scroll container.`);
      }
    }

    if (existsSync(vitePath)) {
      const source = readText(vitePath);
      for (const requiredText of [
        "const isDevvitBuild = appTarget === 'reddit'",
        "preview: resolve(gameRoot, 'index.html')",
        "game: resolve(gameRoot, 'game.html')",
      ]) {
        assertIncludesText(source, requiredText, `${vitePath}: Devvit multi-page build.`);
      }
    }
  }

  for (const relativePath of [
    'src/platform/devvitEntrypoint.ts',
    'src/platform/devvitInlineMode.css',
  ]) {
    const templatePath = `packages/cli/templates/phaser-game/${relativePath}`;
    const examplePath = `examples/phaser-starter/${relativePath}`;
    const templateSource = existsSync(templatePath) ? readText(templatePath) : undefined;
    const exampleSource = existsSync(examplePath) ? readText(examplePath) : undefined;
    const comparableTemplateSource =
      relativePath === 'src/platform/devvitEntrypoint.ts'
        ? templateSource?.replace('__GAME_TITLE__', 'mpgd Phaser Starter')
        : templateSource;

    if (
      comparableTemplateSource !== undefined
      && exampleSource !== undefined
      && comparableTemplateSource !== exampleSource
    ) {
      failures.push(`${templatePath}: must stay in parity with ${examplePath}.`);
    }
  }

  const templateEntryFailure =
    'packages/cli/templates/phaser-game/src/runtime/renderEntryFailure.ts';
  const exampleEntryFailure = 'examples/phaser-starter/src/runtime/renderEntryFailure.ts';

  if (
    existsSync(templateEntryFailure)
    && existsSync(exampleEntryFailure)
    && readText(templateEntryFailure) !== readText(exampleEntryFailure)
  ) {
    failures.push(
      `${templateEntryFailure}: must stay in parity with `
        + `${exampleEntryFailure}.`,
    );
  }

  assertIncludesText(
    readText('tsconfig.base.json'),
    '"@mpgd/adapter-devvit/view-mode": ["./adapters/devvit/src/view-mode.ts"]',
    'tsconfig.base.json: Devvit view-mode workspace path.',
  );

  for (const path of [
    'apps/target-devvit/devvit.json',
    'packages/cli/templates/phaser-game/apps/target-devvit/devvit.json',
  ]) {
    const manifest = readJson(path) as {
      readonly post?: {
        readonly entrypoints?: Record<string, { readonly entry?: unknown }>;
      };
    } | null;

    if (manifest === null) {
      continue;
    }

    assertEqual(
      manifest.post?.entrypoints?.default?.entry,
      'index.html',
      `${path}: inline post entry`,
    );
    assertEqual(
      manifest.post?.entrypoints?.game?.entry,
      'game.html',
      `${path}: expanded game entry`,
    );
  }
}

function validatePhaserTemplateDevvitVitePlugin(): void {
  const wrapperRoots = [
    'apps/target-devvit',
    'packages/cli/templates/phaser-game/apps/target-devvit',
  ] as const;

  for (const root of wrapperRoots) {
    const vitePath = `${root}/vite.config.ts`;
    const serverPath = `${root}/src/server/index.ts`;
    const packagePath = `${root}/package.json`;
    const manifestPath = `${root}/devvit.json`;

    for (const path of [
      vitePath,
      serverPath,
      packagePath,
      manifestPath,
      `${root}/src/client/index.html`,
      `${root}/src/client/game.html`,
      `${root}/src/client/preview.ts`,
      `${root}/src/client/game.ts`,
    ]) {
      if (!existsSync(path)) {
        failures.push(`${path}: required for the official Devvit Vite build.`);
      }
    }

    if (existsSync(vitePath)) {
      const source = readText(vitePath);

      for (const requiredText of [
        "from '@devvit/start/vite'",
        'createGameViteSharedConfig',
        "sourcemap: mode !== 'production'",
      ]) {
        assertIncludesText(source, requiredText, `${vitePath}: official Devvit Vite plugin.`);
      }
    }

    if (existsSync(serverPath)) {
      const source = readText(serverPath);

      assertIncludesText(
        source,
        "from '@mpgd/bridge/orpc/node'",
        `${serverPath}: direct oRPC Node HTTP adapter.`,
      );
      if (source.includes('/api/mpgd/bridge')) {
        failures.push(`${serverPath}: must expose only the oRPC bridge route.`);
      }

      for (const forbiddenPackage of ['express', 'helmet', 'hono']) {
        if (
          source.includes(`from '${forbiddenPackage}'`) ||
          source.includes(`from "${forbiddenPackage}"`)
        ) {
          failures.push(`${serverPath}: must not import ${forbiddenPackage}.`);
        }
      }
    }

    const packageJson = readJson(packagePath) as {
      readonly dependencies?: Record<string, unknown>;
      readonly devDependencies?: Record<string, unknown>;
    } | null;

    if (packageJson !== null) {
      assertEqual(
        packageJson.dependencies?.['@devvit/web'],
        expectedDevvitVersion,
        `${packagePath}: dependencies.@devvit/web`,
      );
      assertEqual(
        packageJson.devDependencies?.['@devvit/start'],
        expectedDevvitVersion,
        `${packagePath}: devDependencies.@devvit/start`,
      );
      assertEqual(
        packageJson.devDependencies?.devvit,
        expectedDevvitVersion,
        `${packagePath}: devDependencies.devvit`,
      );
    }

    const manifest = readJson(manifestPath) as {
      readonly scripts?: Record<string, unknown>;
    } | null;

    if (manifest !== null) {
      assertEqual(
        manifest.scripts?.dev,
        'vite build --mode staging --watch',
        `${manifestPath}: scripts.dev`,
      );
    }
  }

  for (const path of [
    'examples/phaser-starter/mpgd.targets.json',
    'packages/cli/templates/phaser-game/mpgd.targets.json',
  ]) {
    const config = readJson(path) as AitNavigationTargetsConfig & {
      readonly targets?: Record<string, {
        readonly kind?: unknown;
        readonly buildStrategy?: unknown;
      }>;
    } | null;

    if (config !== null) {
      assertEqual(config.targets?.reddit?.kind, 'devvit-web', `${path}: targets.reddit.kind`);
      assertTransparentAitNavigation(config, path);

      if (config.targets?.reddit?.buildStrategy !== undefined) {
        failures.push(`${path}: Devvit targets must not configure a legacy build strategy.`);
      }
    }
  }

}

function assertTransparentAitNavigation(
  config: AitNavigationTargetsConfig,
  path: string,
): void {
  const navigationBar = config.targets?.ait?.navigationBar;
  for (const [key, expected] of [
    ['withBackButton', false],
    ['withHomeButton', false],
    ['withTitle', false],
    ['transparentBackground', true],
    ['theme', 'dark'],
  ] as const) {
    assertEqual(navigationBar?.[key], expected, `${path}: targets.ait.navigationBar.${key}`);
  }
}

function validatePhaserTemplateOrientationPolicy(): void {
  const mainPath = 'packages/cli/templates/phaser-game/src/main.ts';
  const pwaManifestPath = 'packages/cli/templates/phaser-game/public/manifest.webmanifest';
  const readmePath = 'packages/cli/templates/phaser-game/README.md';
  const messagesPath = 'packages/cli/templates/phaser-game/src/i18n/messages.ts';
  const lobbyScenePath = 'packages/cli/templates/phaser-game/src/scenes/LobbyScene.ts';
  const agentManifestPath = 'packages/cli/templates/phaser-game/agent/game-manifest.json';
  const agentBriefPath = 'packages/cli/templates/phaser-game/agent/brief.md';
  const agentAcceptancePath = 'packages/cli/templates/phaser-game/agent/acceptance.md';
  let orientationPolicyMode: string | undefined;

  if (!existsSync(mainPath)) {
    failures.push(`${mainPath}: required for the viewport orientation starter flow.`);
  } else {
    const mainContent = readText(mainPath);
    const policyMatch =
      /mode:\s*['"](?<mode>responsive|prefer-landscape|prefer-portrait|lock-landscape|lock-portrait)['"]/.exec(
        mainContent,
      );

    orientationPolicyMode = policyMatch?.groups?.mode;
    if (orientationPolicyMode === undefined) {
      failures.push(`${mainPath}: must define a viewport orientation policy mode.`);
    }
    assertIncludesText(
      mainContent,
      'satisfies TargetViewportOrientationPolicy',
      `${mainPath}: orientation policy must be typed with TargetViewportOrientationPolicy.`,
    );
    assertIncludesText(
      mainContent,
      'orientationPolicy,',
      `${mainPath}: resolveTargetViewportPlan input must include orientationPolicy.`,
    );
    assertIncludesText(
      mainContent,
      "source: 'container'",
      `${mainPath}: viewport measurement must prefer the game container before fallbacks.`,
    );
    assertIncludesText(
      mainContent,
      "source: 'visual-viewport'",
      `${mainPath}: viewport measurement must keep visualViewport fallback.`,
    );
  }

  if (!existsSync(pwaManifestPath)) {
    failures.push(`${pwaManifestPath}: required for installed web shell orientation policy.`);
  } else {
    const pwaManifest = readJson(pwaManifestPath) as { readonly orientation?: unknown } | null;

    if (pwaManifest !== null) {
      const expectedOrientation = resolvePwaManifestOrientation(orientationPolicyMode);

      // Responsive mode intentionally leaves PWA orientation unconstrained; an undefined
      // policy already fails the main.ts validation above.
      if (expectedOrientation !== undefined) {
        assertEqual(
          pwaManifest.orientation,
          expectedOrientation,
          `${pwaManifestPath}: orientation`,
        );
      }
    }
  }

  if (!existsSync(readmePath)) {
    failures.push(`${readmePath}: required for the viewport orientation starter flow.`);
  } else {
    const readme = readText(readmePath);

    for (const requiredText of [
      'orientationPolicy',
      'prefer-landscape',
      'prefer-portrait',
      'lock-landscape',
      'lock-portrait',
      '"orientation": "landscape"',
      'runtime contract',
      'soft rotate prompt',
    ]) {
      assertIncludesText(
        readme,
        requiredText,
        `${readmePath}: must document ${requiredText} for orientation policy.`,
      );
    }
  }

  if (!existsSync(messagesPath)) {
    failures.push(`${messagesPath}: required for orientation policy status text.`);
  } else {
    const messages = readText(messagesPath);

    for (const requiredText of ['orientationPolicy', 'orientationMismatch']) {
      assertIncludesText(
        messages,
        requiredText,
        `${messagesPath}: must include ${requiredText} message.`,
      );
    }
  }

  if (!existsSync(lobbyScenePath)) {
    failures.push(`${lobbyScenePath}: required for orientation policy status text.`);
  } else {
    const lobbyScene = readText(lobbyScenePath);

    for (const requiredText of [
      'context.viewport.orientation',
      'shouldShowRotatePrompt',
      'preferredOrientation',
      'orientationMismatch',
      'orientationPolicy',
    ]) {
      assertIncludesText(
        lobbyScene,
        requiredText,
        `${lobbyScenePath}: must include ${requiredText} for orientation policy rendering.`,
      );
    }
  }

  if (!existsSync(agentManifestPath)) {
    failures.push(`${agentManifestPath}: required for generated starter agent workflow.`);
  } else {
    const agentManifest = readJson(agentManifestPath) as { readonly blocks?: unknown } | null;

    if (agentManifest !== null) {
      assertTemplateAgentBlock(
        agentManifest.blocks,
        'runtime.viewport.orientation-policy',
        'src/main.ts',
        `${agentManifestPath}: blocks`,
      );
    }
  }

  if (!existsSync(agentBriefPath)) {
    failures.push(`${agentBriefPath}: required for generated starter agent workflow.`);
  } else {
    const agentBrief = readText(agentBriefPath);

    for (const requiredText of ['Orientation policy', 'soft prompts', 'resize behavior']) {
      assertIncludesText(
        agentBrief,
        requiredText,
        `${agentBriefPath}: must guide ${requiredText}.`,
      );
    }
  }

  if (!existsSync(agentAcceptancePath)) {
    failures.push(`${agentAcceptancePath}: required for generated starter agent workflow.`);
  } else {
    const agentAcceptance = readText(agentAcceptancePath);

    for (const requiredText of [
      'viewport orientation policy',
      'soft prompts',
      'WebView hard locks',
    ]) {
      assertIncludesText(
        agentAcceptance,
        requiredText,
        `${agentAcceptancePath}: must check ${requiredText}.`,
      );
    }
  }
}

function validatePhaserTemplateSafeAreaContract(): void {
  const templateManifestPath = 'packages/cli/templates/phaser-game/agent/game-manifest.json';
  const templateBriefPath = 'packages/cli/templates/phaser-game/agent/brief.md';
  const templateAcceptancePath = 'packages/cli/templates/phaser-game/agent/acceptance.md';
  const starterManifestPath = 'examples/phaser-starter/agent/game.manifest.json';
  const starterBriefPath = 'examples/phaser-starter/agent/brief.template.md';
  const starterAcceptancePath = 'examples/phaser-starter/agent/acceptance.md';

  if (!existsSync(templateManifestPath)) {
    failures.push(`${templateManifestPath}: required for generated safe-area agent guidance.`);
  } else {
    const templateManifest = readJson(templateManifestPath) as { readonly blocks?: unknown } | null;

    if (templateManifest !== null) {
      assertTemplateAgentBlock(
        templateManifest.blocks,
        'runtime.viewport.safe-area-contract',
        'src/main.ts',
        `${templateManifestPath}: blocks`,
      );
    }
  }

  const safeAreaDocumentationExpectations = [
    [templateBriefPath, ['Safe-area geometry', 'safeArea.contentBounds', 'never both']],
    [
      templateAcceptancePath,
      ['safe-area geometry', 'CSS-padded', 'full-bleed', 'safeArea.contentBounds'],
    ],
    [
      starterBriefPath,
      ['safe-area snapshot', 'safeArea.contentBounds', 'never both', 'CSS-padded', 'full-bleed'],
    ],
    [
      starterAcceptancePath,
      ['Safe-area geometry', 'CSS-padded', 'full-bleed', 'safeArea.contentBounds'],
    ],
  ] as const;

  for (const [path, requiredTexts] of safeAreaDocumentationExpectations) {
    if (!existsSync(path)) {
      failures.push(`${path}: required for safe-area agent guidance.`);
      continue;
    }

    const content = readText(path);
    for (const requiredText of requiredTexts) {
      assertIncludesText(content, requiredText, `${path}: safe-area agent guidance.`);
    }
  }

  if (!existsSync(starterManifestPath)) {
    failures.push(`${starterManifestPath}: required for starter safe-area agent guidance.`);
    return;
  }

  const starterManifest = readJson(starterManifestPath) as StarterAgentManifest | null;

  if (starterManifest === null) {
    return;
  }

  assertStarterAgentBlockContract(
    starterManifest.blocks,
    'runtime.viewport.safe-area-contract',
    'src/main.ts',
    ['viewport-safe-area-snapshot', 'viewport-safe-content-bounds'],
    ['exactly once', 'safeArea.contentBounds', 'full-bleed', 'CSS-padded'],
    `${starterManifestPath}: blocks`,
  );
  assertStringArray(
    starterManifest.acceptance?.manual,
    `${starterManifestPath}: acceptance.manual`,
  );
  assertIncludes(
    starterManifest.acceptance?.manual,
    'Safe-area geometry is reserved exactly once: CSS-padded containers do not also subtract safeArea.contentBounds, while full-bleed surfaces use the snapshot bounds.',
    `${starterManifestPath}: acceptance.manual`,
  );
}

function validatePhaserTemplateLocalePolicy(): void {
  const mainPath = 'packages/cli/templates/phaser-game/src/main.ts';

  if (!existsSync(mainPath)) {
    failures.push(`${mainPath}: required for target-aware locale resolution.`);
    return;
  }

  const mainContent = readText(mainPath);

  assertIncludesText(
    mainContent,
    'resolveTargetMpgdLocale',
    `${mainPath}: generated games must use the target-aware locale resolver.`,
  );
  assertIncludesText(
    mainContent,
    'runtime.effectiveConfig?.localization.fallbackLocale',
    `${mainPath}: generated games must prefer the effective target locale fallback.`,
  );
  assertIncludesText(
    mainContent,
    'runtime.config.localization.fallbackLocale',
    `${mainPath}: generated games must preserve the base target locale fallback.`,
  );
}

function validatePhaserTemplateRewardAuthority(): void {
  const scenePath = 'packages/cli/templates/phaser-game/src/scenes/PlayScene.ts';

  if (!existsSync(scenePath)) {
    failures.push(`${scenePath}: required for authoritative rewarded-ad validation.`);
    return;
  }

  const sceneContent = readText(scenePath);

  assertIncludesText(
    sceneContent,
    'this.context.gameServices.client',
    `${scenePath}: rewarded ads must require the game-services client.`,
  );
  assertIncludesText(
    sceneContent,
    'gameServicesClient.claimRewardedAd',
    `${scenePath}: rewarded ads must use the authoritative claim flow.`,
  );
  assertIncludesText(
    sceneContent,
    'result.claim?.granted === true',
    `${scenePath}: reward presentation must depend on the authoritative ledger claim.`,
  );

  if (sceneContent.includes('platform.ads.showRewarded')) {
    failures.push(
      `${scenePath}: scenes must not call the rewarded-ad platform SDK without the ledger flow.`,
    );
  }
}

function assertMcpServerCommand(
  server: McpServerConfig | undefined,
  packageName: string,
  label: string,
): void {
  if (server === undefined) {
    failures.push(`${label} MCP server is required.`);
    return;
  }

  assertEqual(server.command, 'npx', `${label}.command`);

  if (!Array.isArray(server.args)) {
    failures.push(`${label}.args must be an array.`);
    return;
  }

  assertIncludes(server.args, '-y', `${label}.args`);
  assertIncludes(server.args, packageName, `${label}.args`);
}

function assertMcpRequirements(input: unknown, label: string): void {
  if (!Array.isArray(input)) {
    failures.push(`${label} must be an array.`);
    return;
  }

  for (const requirement of requiredMcpRequirements) {
    assertMcpRequirement(input, label, requirement);
  }
}

function assertMcpRequirement(
  input: readonly unknown[],
  label: string,
  requirement: (typeof requiredMcpRequirements)[number],
): void {
  const entry = input.find((candidate): candidate is StarterMcpRequirement => {
    return (
      typeof candidate === 'object'
      && candidate !== null
      && (candidate as StarterMcpRequirement).target === requirement.target
      && (candidate as StarterMcpRequirement).server === requirement.server
    );
  });
  const queryLabel = `${label}.${requirement.target}.queries`;

  if (entry === undefined) {
    failures.push(
      `${label} must include a ${requirement.name} MCP requirement for ${requirement.target}.`,
    );
    return;
  }

  assertStringArray(entry.queries, queryLabel);
  for (const query of requirement.queries) {
    assertIncludes(entry.queries, query, queryLabel);
  }
}

function assertBlocks(input: unknown, label: string): void {
  if (!Array.isArray(input) || input.length === 0) {
    failures.push(`${label} must be a non-empty array.`);
    return;
  }

  for (const [index, rawBlock] of input.entries()) {
    const blockLabel = `${label}[${index}]`;

    if (typeof rawBlock !== 'object' || rawBlock === null) {
      failures.push(`${blockLabel} must be an object.`);
      continue;
    }

    const block = rawBlock as StarterBlock;
    assertString(block.id, `${blockLabel}.id`);
    assertString(block.kind, `${blockLabel}.kind`);
    assertString(block.entry, `${blockLabel}.entry`);
    assertStringArray(block.capabilities, `${blockLabel}.capabilities`);
    assertStringArray(block.gotchas, `${blockLabel}.gotchas`);

    if (typeof block.id === 'string' && !/^[a-z]+(?:\.[a-z0-9-]+)+$/.test(block.id)) {
      failures.push(`${blockLabel}.id must be capability-named, received ${block.id}.`);
    }

    if (typeof block.id === 'string' && /mario|gradius|zelda|tetris|pokemon/i.test(block.id)) {
      failures.push(`${blockLabel}.id must not use copyrighted reference names.`);
    }
  }
}

function assertString(input: unknown, label: string): void {
  if (typeof input !== 'string' || input.length === 0) {
    failures.push(`${label} must be a non-empty string.`);
  }
}

function assertStringArray(input: unknown, label: string): readonly string[] | undefined {
  if (
    !Array.isArray(input)
    || input.length === 0
    || input.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    failures.push(`${label} must be a non-empty string array.`);
    return undefined;
  }

  return input;
}

function assertIncludes(input: unknown, expected: string, label: string): void {
  if (!Array.isArray(input) || !input.includes(expected)) {
    failures.push(`${label} must include ${expected}.`);
  }
}

function assertEqual(input: unknown, expected: string | boolean, label: string): void {
  if (input !== expected) {
    failures.push(`${label} must be ${expected}.`);
  }
}

function assertIncludesText(content: string, expected: string, label: string): void {
  if (!content.includes(expected)) {
    failures.push(`${label} Missing text: ${expected}.`);
  }
}

function assertTemplateAgentBlock(
  input: unknown,
  expectedId: string,
  expectedOwner: string,
  label: string,
): void {
  if (!Array.isArray(input)) {
    failures.push(`${label} must be an array.`);
    return;
  }

  const block = input.find((candidate): candidate is { readonly id?: unknown; readonly owner?: unknown } => {
    return (
      typeof candidate === 'object'
      && candidate !== null
      && (candidate as { readonly id?: unknown }).id === expectedId
    );
  });

  if (block === undefined) {
    failures.push(`${label} must include ${expectedId}.`);
    return;
  }

  assertEqual(block.owner, expectedOwner, `${label}.${expectedId}.owner`);
}

function assertStarterAgentBlockContract(
  input: unknown,
  expectedId: string,
  expectedEntry: string,
  expectedCapabilities: readonly string[],
  expectedGotchaTexts: readonly string[],
  label: string,
): void {
  if (!Array.isArray(input)) {
    failures.push(`${label} must be an array.`);
    return;
  }

  const block = input.find((candidate): candidate is StarterBlock => {
    return (
      typeof candidate === 'object'
      && candidate !== null
      && (candidate as StarterBlock).id === expectedId
    );
  });

  if (block === undefined) {
    failures.push(`${label} must include ${expectedId}.`);
    return;
  }

  assertEqual(block.entry, expectedEntry, `${label}.${expectedId}.entry`);
  const capabilities = assertStringArray(block.capabilities, `${label}.${expectedId}.capabilities`);
  const gotchas = assertStringArray(block.gotchas, `${label}.${expectedId}.gotchas`);

  if (capabilities === undefined || gotchas === undefined) {
    return;
  }

  for (const capability of expectedCapabilities) {
    assertIncludes(capabilities, capability, `${label}.${expectedId}.capabilities`);
  }

  const gotchaText = gotchas.join('\n');
  for (const requiredText of expectedGotchaTexts) {
    assertIncludesText(gotchaText, requiredText, `${label}.${expectedId}.gotchas`);
  }
}

function resolvePwaManifestOrientation(mode: string | undefined): string | undefined {
  switch (mode) {
    case 'prefer-landscape':
    case 'lock-landscape':
      return 'landscape';
    case 'prefer-portrait':
    case 'lock-portrait':
      return 'portrait';
    case 'responsive':
    case undefined:
      return undefined;
    default:
      // Defensive fallback for future policy modes added outside this validator.
      failures.push(`Unknown viewport orientation policy mode: ${mode}.`);
      return undefined;
  }
}

function findPatternIndex(content: string, pattern: RegExp, startIndex: number): number {
  const safeStartIndex = Math.max(startIndex, 0);
  const match = pattern.exec(content.slice(safeStartIndex));

  return match === null ? -1 : safeStartIndex + match.index;
}

function findWrappingBlockPatternIndex(
  content: string,
  pattern: RegExp,
  targetIndex: number,
): number {
  let matchedIndex = -1;

  for (const match of content.slice(0, Math.max(targetIndex, 0)).matchAll(pattern)) {
    const patternIndex = match.index;
    const blockStartIndex = content.indexOf('{', patternIndex);

    if (blockStartIndex === -1 || blockStartIndex > targetIndex) {
      continue;
    }

    const blockEndIndex = findMatchingBraceIndex(content, blockStartIndex);

    if (blockEndIndex !== -1 && targetIndex < blockEndIndex) {
      matchedIndex = patternIndex;
    }
  }

  return matchedIndex;
}

function findMatchingBraceIndex(content: string, openBraceIndex: number): number {
  let depth = 0;

  for (let index = openBraceIndex; index < content.length; index += 1) {
    const char = content[index];

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    }

    if (depth === 0) {
      return index;
    }
  }

  return -1;
}

function validatePeerDependencyRuleParser(): void {
  const positive = `peerDependencyRules:\n  allowedVersions:\n    '${aitDevtoolsPeerSelector}': '${aitWebFrameworkVersion}'\n`;
  const hashValue = `peerDependencyRules:\n  allowedVersions:\n    '${aitDevtoolsPeerSelector}': ${aitWebFrameworkVersion}+build#1\n`;
  const invalid = [
    `# peerDependencyRules:\n#   allowedVersions:\n#     '${aitDevtoolsPeerSelector}': '${aitWebFrameworkVersion}'\n`,
    `allowedVersions:\n  '${aitDevtoolsPeerSelector}': '${aitWebFrameworkVersion}'\n`,
    `peerDependencyRules: |\n  allowedVersions:\n    '${aitDevtoolsPeerSelector}': '${aitWebFrameworkVersion}'\n`,
    `peerDependencyRules: >\n  allowedVersions:\n    '${aitDevtoolsPeerSelector}': '${aitWebFrameworkVersion}'\n`,
    `peerDependencyRules:\n  ignored:\n    '${aitDevtoolsPeerSelector}': '${aitWebFrameworkVersion}'\n`,
    `peerDependencyRules:\n  allowedVersions: |\n    '${aitDevtoolsPeerSelector}': '${aitWebFrameworkVersion}'\n`,
    `peerDependencyRules:\n  allowedVersions: >\n    '${aitDevtoolsPeerSelector}': '${aitWebFrameworkVersion}'\n`,
    `peerDependencyRules:\n  allowedVersions: scalar\n    '${aitDevtoolsPeerSelector}': '${aitWebFrameworkVersion}'\n`,
  ];

  if (
    readAllowedPeerVersion(positive, aitDevtoolsPeerSelector) !== aitWebFrameworkVersion
    || readAllowedPeerVersion(hashValue, aitDevtoolsPeerSelector)
      !== `${aitWebFrameworkVersion}+build#1`
    || invalid.some(
      (source) => readAllowedPeerVersion(source, aitDevtoolsPeerSelector) !== undefined,
    )
  ) {
    failures.push('Internal peerDependencyRules.allowedVersions parser self-check failed.');
  }
}

function readAllowedPeerVersion(source: string, selector: string): string | undefined {
  let inPeerDependencyRules = false;
  let inAllowedVersions = false;

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = stripYamlComment(rawLine);

    if (line.trim().length === 0) {
      continue;
    }

    const indentation = /^ */u.exec(line)?.[0].length ?? 0;
    const mapping = parseYamlMapping(line.trim());

    if (mapping === undefined) {
      continue;
    }

    if (indentation === 0) {
      inPeerDependencyRules = mapping.key === 'peerDependencyRules' && mapping.value.length === 0;
      inAllowedVersions = false;
      continue;
    }

    if (!inPeerDependencyRules) {
      continue;
    }

    if (indentation === 2) {
      inAllowedVersions = mapping.key === 'allowedVersions' && mapping.value.length === 0;
      continue;
    }

    if (inAllowedVersions && indentation === 4 && mapping.key === selector) {
      return mapping.value;
    }
  }

  return undefined;
}

function stripYamlComment(line: string): string {
  const commentIndex = findFirstUnquotedCharacter(
    line,
    '#',
    (index) => index === 0 || /\s/u.test(line[index - 1] ?? ''),
  );
  return commentIndex === -1 ? line : line.slice(0, commentIndex);
}

function parseYamlMapping(line: string): { readonly key: string; readonly value: string } | undefined {
  const separatorIndex = findFirstUnquotedCharacter(line, ':');

  if (separatorIndex === -1) {
    return undefined;
  }

  return {
    key: unquoteYamlScalar(line.slice(0, separatorIndex).trim()),
    value: unquoteYamlScalar(line.slice(separatorIndex + 1).trim()),
  };
}

function findFirstUnquotedCharacter(
  line: string,
  target: string,
  accepts: (index: number) => boolean = () => true,
): number {
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (quote !== undefined) {
      if (quote === "'" && character === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      } else if (character === '\\' && quote === '"') {
        index += 1;
      }

      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === target && accepts(index)) {
      return index;
    }
  }

  return -1;
}

function unquoteYamlScalar(value: string): string {
  if (
    value.length >= 2
    && ((value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"')))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    failures.push(
      `${path}: failed to read file: ${error instanceof Error ? error.message : String(error)}.`,
    );

    return '';
  }
}

function readJson(path: string): unknown {
  const initialFailureCount = failures.length;
  const content = readText(path);

  if (failures.length > initialFailureCount) {
    return null;
  }

  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    failures.push(
      `${path}: failed to parse JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );

    return null;
  }
}
