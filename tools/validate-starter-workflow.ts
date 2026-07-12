import { existsSync, readFileSync } from 'node:fs';

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
validatePhaserTemplateAITConsoleCli();
validatePhaserTemplateDevvitPostOperations();
validatePhaserTemplateDevvitSurfaces();
validatePhaserTemplateOrientationPolicy();

if (failures.length > 0) {
  throw new Error(`Starter workflow validation failed:\n- ${failures.join('\n- ')}`);
}

console.log('Starter workflow validation passed.');

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
      assertString(
        packageJson.dependencies?.['@apps-in-toss/web-framework'],
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
        'granite.config.ts',
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
    ]) {
      assertIncludesText(
        readme,
        requiredText,
        `${templateReadmePath}: durable post operation guidance.`,
      );
    }
  }
}

function validatePhaserTemplateDevvitSurfaces(): void {
  const roots = ['packages/cli/templates/phaser-game', 'examples/phaser-starter'] as const;

  for (const root of roots) {
    const indexPath = `${root}/index.html`;
    const gameDocumentPath = `${root}/game.html`;
    const entryPath = `${root}/src/entry.ts`;
    const gameEntryPath = `${root}/src/gameEntry.ts`;
    const devvitEntryPath = `${root}/src/platform/devvitEntrypoint.ts`;
    const devvitStylePath = `${root}/src/platform/devvitInlinePreview.css`;
    const vitePath = `${root}/vite.config.ts`;

    for (const path of [
      indexPath,
      gameDocumentPath,
      entryPath,
      gameEntryPath,
      devvitEntryPath,
      devvitStylePath,
      vitePath,
    ]) {
      if (!existsSync(path)) {
        failures.push(`${path}: required for split Devvit inline and expanded surfaces.`);
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
      for (const requiredText of ["__APP_TARGET__ === 'reddit'", "import('./main')"]) {
        assertIncludesText(source, requiredText, `${entryPath}: target-aware bootstrap.`);
      }
    }

    if (existsSync(gameEntryPath)) {
      const source = readText(gameEntryPath);
      assertIncludesText(source, "import('./main')", `${gameEntryPath}: Phaser bootstrap.`);

      if (source.includes('getWebViewMode')) {
        failures.push(`${gameEntryPath}: expanded entry must not inspect Devvit web view mode.`);
      }
    }

    if (existsSync(devvitEntryPath)) {
      const source = readText(devvitEntryPath);
      for (const requiredText of [
        "from '@mpgd/adapter-devvit/web'",
        'mountInlinePreview',
        "await import('../main')",
        "requestDevvitExpandedMode(event, 'game')",
      ]) {
        assertIncludesText(source, requiredText, `${devvitEntryPath}: Devvit surface split.`);
      }
    }

    if (existsSync(devvitStylePath)) {
      const source = readText(devvitStylePath);

      for (const requiredText of [
        'body.devvit-preview-host',
        '.devvit-preview',
        '.devvit-preview__button',
      ]) {
        assertIncludesText(source, requiredText, `${devvitStylePath}: inline preview styles.`);
      }
    }

    if (existsSync(vitePath)) {
      const source = readText(vitePath);
      for (const requiredText of [
        "const isDevvitBuild = appTarget === 'reddit'",
        "preview: resolve('index.html')",
        "game: resolve('game.html')",
      ]) {
        assertIncludesText(source, requiredText, `${vitePath}: Devvit multi-page build.`);
      }
    }
  }

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

function assertStringArray(input: unknown, label: string): void {
  if (
    !Array.isArray(input)
    || input.length === 0
    || input.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    failures.push(`${label} must be a non-empty string array.`);
  }
}

function assertIncludes(input: unknown, expected: string, label: string): void {
  if (!Array.isArray(input) || !input.includes(expected)) {
    failures.push(`${label} must include ${expected}.`);
  }
}

function assertEqual(input: unknown, expected: string, label: string): void {
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
