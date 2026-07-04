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
    queryLabel: 'ait',
  },
  {
    target: 'reddit',
    server: 'devvit',
    queries: requiredDevvitQueries,
    name: 'Devvit',
    queryLabel: 'reddit',
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
  assertStringArray(manifest.futureTargets, `${manifestPath}: futureTargets`);
  assertIncludes(manifest.futureTargets, 'reddit', `${manifestPath}: futureTargets`);

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
  const queryLabel = `${label}.${requirement.queryLabel}.queries`;

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
